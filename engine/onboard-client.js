/**
 * Client Onboarding
 * Automatically provisions new clients when they appear in the registry
 * without a mirror contact ID. Runs at the start of each scoring cycle.
 *
 * When a new client is added to client-registry.json with their basic info
 * (name, program, location ID, API key, contact ID), this module:
 *   1. Creates a mirror contact in The Coaching Dept.
 *   2. Creates an opportunity in the FF pipeline at Stage 0
 *   3. Applies program tags (FF-Active or BC-Active)
 *   4. Sets initial custom field values
 *   5. Writes the mirror contact ID back to client-registry.json
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const { getCustomFieldValue } = require('../utils/rolling-averages');

const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;
const REGISTRY_PATH = path.resolve(__dirname, '../setup/client-registry.json');

// Default cancellation stage names to look for in client pipelines
const CANCELLATION_STAGE_NAMES = ['cancelled', 'canceled', 'cancellation'];

// Default cancellation stage to create if none found
const DEFAULT_CANCELLATION_STAGE = { name: 'Cancelled Program' };

/**
 * Map pipeline stages for a client and ensure cancellation stage exists.
 * Reads the client's GHL pipelines, maps closed/new_start/cancellation stages,
 * and writes the pipeline_stage_map back to client-registry.json.
 *
 * If no cancellation stage is found, adds one to the client journey pipeline.
 */
async function mapPipelineStages(client, registry) {
  const loc = client.ghl_location_id;

  const pipelinesData = await ghl.getPipelines(loc);
  const pipelines = pipelinesData.pipelines || [];

  if (pipelines.length === 0) {
    console.log(`    No pipelines found for ${client.name}`);
    return;
  }

  // Find the two expected pipelines: lead pipeline and client journey pipeline
  // Lead pipeline typically has: lead stages, booked, showed, closed
  // Client journey pipeline typically has: signed up, program start, active, cancelled
  let leadPipeline = pipelines.find(p =>
    p.name.toLowerCase().includes('lead') || p.name.toLowerCase().includes('sales')
  );
  let journeyPipeline = pipelines.find(p =>
    p.name.toLowerCase().includes('journey') || p.name.toLowerCase().includes('client') ||
    p.name.toLowerCase().includes('90') || p.name.toLowerCase().includes('member')
  );

  // Fallback: if only one pipeline, use it for both
  if (!leadPipeline && pipelines.length === 1) leadPipeline = pipelines[0];
  if (!journeyPipeline && pipelines.length === 1) journeyPipeline = pipelines[0];
  if (!leadPipeline && pipelines.length >= 2) leadPipeline = pipelines[0];
  if (!journeyPipeline && pipelines.length >= 2) journeyPipeline = pipelines[1];

  const stageMap = {
    lead_pipeline_id: leadPipeline ? leadPipeline.id : '',
    client_journey_pipeline_id: journeyPipeline ? journeyPipeline.id : '',
    closed: [],
    closed_stage_ids: [],
    new_start: [],
    new_start_stage_ids: [],
    cancellation: [],
    cancellation_stage_ids: [],
  };

  // Map stages from lead pipeline (closed = sale-related stages)
  if (leadPipeline) {
    for (const stage of leadPipeline.stages || []) {
      const name = stage.name.toLowerCase();
      if (name.includes('sale') || name.includes('closed') || name.includes('won') ||
          name.includes('upsold') || name.includes('challenge')) {
        stageMap.closed.push(stage.name);
        stageMap.closed_stage_ids.push(stage.id);
      }
    }
  }

  // Map stages from client journey pipeline
  if (journeyPipeline) {
    for (const stage of journeyPipeline.stages || []) {
      const name = stage.name.toLowerCase();

      // New start stages
      if (name.includes('signed up') || name.includes('program start') || name.includes('new start')) {
        stageMap.new_start.push(stage.name);
        stageMap.new_start_stage_ids.push(stage.id);
      }

      // Cancellation stages
      if (name.includes('cancel')) {
        stageMap.cancellation.push(stage.name);
        stageMap.cancellation_stage_ids.push(stage.id);
      }
    }

    // If no cancellation stage found, add one
    if (stageMap.cancellation.length === 0) {
      console.log(`    No cancellation stage found — adding "${DEFAULT_CANCELLATION_STAGE.name}" to ${journeyPipeline.name}`);

      const existingStages = (journeyPipeline.stages || []).map(s => ({
        id: s.id,
        name: s.name,
        position: s.position,
      }));

      const newPosition = existingStages.length;
      const updatedStages = [
        ...existingStages,
        { name: DEFAULT_CANCELLATION_STAGE.name, position: newPosition },
      ];

      const updateResult = await ghl.updatePipeline(loc, journeyPipeline.id, {
        name: journeyPipeline.name,
        stages: updatedStages,
      });

      // Find the newly created stage in the response
      const updatedPipelineStages = (updateResult.pipeline || updateResult).stages || [];
      const newCancelStage = updatedPipelineStages.find(s => s.name === DEFAULT_CANCELLATION_STAGE.name);

      if (newCancelStage) {
        stageMap.cancellation.push(newCancelStage.name);
        stageMap.cancellation_stage_ids.push(newCancelStage.id);
        console.log(`    Cancellation stage created: ${newCancelStage.name} (${newCancelStage.id})`);
      }
    }
  }

  // Write pipeline_stage_map to client registry
  const idx = registry.clients.findIndex(
    c => c.ghl_location_id === client.ghl_location_id
  );
  if (idx !== -1) {
    registry.clients[idx].pipeline_stage_map = stageMap;
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  }
}

/**
 * Check if a client needs onboarding (no mirror contact ID).
 */
function needsOnboarding(client) {
  return (
    client.ghl_location_id &&
    client.ghl_location_id !== 'USMAN_FILLS_THIS' &&
    client.ff_contact_id &&
    (!client.coaching_dept_mirror_contact_id || client.coaching_dept_mirror_contact_id === '')
  );
}

/**
 * Run onboarding for a single client.
 * Returns the new mirror contact ID, or null on failure.
 */
async function onboardClient(client, registry) {
  const loc = client.ghl_location_id;
  const contactId = client.ff_contact_id;
  const program = client.program || 'Freedom Formula';

  console.log(`\n  ONBOARDING: ${client.name} (${program})`);

  // Step 1: Get client's contact data from their sub-account
  let clientContact;
  try {
    const contactData = await ghl.getContact(loc, contactId);
    clientContact = contactData.contact || contactData;
  } catch (err) {
    console.error(`    Failed to read client contact: ${err.message}`);
    return null;
  }

  const email = clientContact.email || '';
  const phone = clientContact.phone || '';
  const firstName = clientContact.firstName || client.name.split(' ')[0];
  const lastName = clientContact.lastName || client.name.split(' ').slice(1).join(' ');

  if (!email) {
    console.error(`    No email on client contact record. Cannot create mirror.`);
    return null;
  }

  // Step 2: Create mirror contact in The Coaching Dept.
  let mirrorContactId;
  try {
    // Check if a contact with this email already exists
    const search = await ghl.searchContacts(COACHING_DEPT_ID, { query: email });
    const existing = (search.contacts || []).find(
      (c) => c.email === email || (c.email && c.email.toLowerCase() === email.toLowerCase())
    );

    if (existing) {
      mirrorContactId = existing.id;
      console.log(`    Mirror contact already exists: ${mirrorContactId}`);
    } else {
      const created = await ghl.createContact(COACHING_DEPT_ID, {
        firstName,
        lastName,
        email,
        phone,
        tags: [],
      });
      mirrorContactId = created.contact ? created.contact.id : created.id;
      console.log(`    Mirror contact created: ${mirrorContactId}`);
    }
  } catch (err) {
    console.error(`    Failed to create mirror contact: ${err.message}`);
    return null;
  }

  // Step 3: Apply program tags
  const tags = program === 'Black Circle'
    ? ['BC-Active', 'FF-Cycle-1']
    : ['FF-Active', 'FF-Cycle-1'];

  try {
    // Tags on client sub-account
    await ghl.addContactTag(loc, contactId, tags);
    // Tags on Coaching Dept mirror
    await ghl.addContactTag(COACHING_DEPT_ID, mirrorContactId, tags);
    console.log(`    Tags applied: ${tags.join(', ')}`);
  } catch (err) {
    console.log(`    Warning: Could not apply tags - ${err.message}`);
  }

  // Step 4: Create opportunity in the FF pipeline at Stage 0 (Payment Received)
  try {
    const pipelines = await ghl.getPipelines(COACHING_DEPT_ID);
    const ffPipeline = (pipelines.pipelines || []).find((p) => p.name === 'Freedom Formula');

    if (ffPipeline) {
      const stage0 = ffPipeline.stages.find((s) => s.name.includes('Payment Received'));
      if (stage0) {
        await ghl.createOpportunity(COACHING_DEPT_ID, {
          pipelineId: ffPipeline.id,
          pipelineStageId: stage0.id,
          contactId: mirrorContactId,
          name: `${client.name} - ${program}`,
          status: 'open',
        });
        console.log(`    Pipeline opportunity created at Stage 0`);
      }
    } else {
      console.log(`    Warning: Freedom Formula pipeline not found`);
    }
  } catch (err) {
    console.log(`    Warning: Could not create pipeline opportunity - ${err.message}`);
  }

  // Step 5: Set initial custom field values on client sub-account
  try {
    const fieldDefsResponse = await ghl.getCustomFields(loc);
    const fieldDefs = fieldDefsResponse.customFields || [];

    const today = new Date().toISOString().split('T')[0];
    const initialFields = {
      'FF Cycle Start Date': today,
      'FF Current Cycle Number': 1,
      'FF Program': program,
      'FF Days Until Next Milestone': 30,
      'FF Health Score This Week': 0,
      'FF Health Score Last Week': 0,
      'FF Danger Zone Active': 'false',
      'FF Consecutive Missed Forms': 0,
      'FF Consecutive Missed Calls': 0,
    };

    await ghl.writeFieldsToContact(loc, contactId, initialFields, fieldDefs);
    console.log(`    Initial field values set on client sub-account`);
  } catch (err) {
    console.log(`    Warning: Could not set initial fields on client - ${err.message}`);
  }

  // Set initial fields on Coaching Dept mirror
  try {
    const cdFieldDefsResponse = await ghl.getCustomFields(COACHING_DEPT_ID);
    const cdFieldDefs = cdFieldDefsResponse.customFields || [];

    await ghl.writeFieldsToContact(COACHING_DEPT_ID, mirrorContactId, {
      'FF Program': program,
      'FF Health Score This Week': 0,
      'FF Health Score Last Week': 0,
      'FF Score Status': 'New / Onboarding',
      'FF Danger Zone Active': 'false',
      'FF Days Until Next Milestone': 30,
      'FF Current Cycle Number': 1,
    }, cdFieldDefs);
    console.log(`    Initial field values set on Coaching Dept mirror`);
  } catch (err) {
    console.log(`    Warning: Could not set initial fields on mirror - ${err.message}`);
  }

  // Step 6: Map pipeline stages and ensure cancellation stage exists
  try {
    await mapPipelineStages(client, registry);
    console.log(`    Pipeline stage mapping configured`);
  } catch (err) {
    console.log(`    Warning: Pipeline stage mapping failed - ${err.message}`);
  }

  // Log onboarding note
  try {
    const today = new Date().toISOString().split('T')[0];
    await ghl.addContactNote(loc, contactId,
      `Auto-onboarded to ${program} - ${today} - Mirror: ${mirrorContactId}`);
    await ghl.addContactNote(COACHING_DEPT_ID, mirrorContactId,
      `New ${program} client onboarded - ${today} - Sub-account: ${loc}`);
  } catch (err) {
    // Non-critical
  }

  console.log(`    Onboarding complete for ${client.name}`);
  return mirrorContactId;
}

/**
 * Check all clients in registry and onboard any that need it.
 * Updates client-registry.json with new mirror contact IDs.
 */
async function onboardNewClients() {
  delete require.cache[require.resolve(REGISTRY_PATH)];
  const registry = require(REGISTRY_PATH);
  const clients = registry.clients || [];

  // Register API keys
  for (const client of clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }

  const toOnboard = clients.filter(needsOnboarding);

  if (toOnboard.length === 0) {
    return;
  }

  console.log(`\nFound ${toOnboard.length} client(s) needing onboarding`);

  let registryUpdated = false;

  for (const client of toOnboard) {
    const mirrorId = await onboardClient(client, registry);

    if (mirrorId) {
      // Update the registry entry with the mirror contact ID
      const idx = registry.clients.findIndex(
        (c) => c.ghl_location_id === client.ghl_location_id && c.ff_contact_id === client.ff_contact_id
      );
      if (idx !== -1) {
        registry.clients[idx].coaching_dept_mirror_contact_id = mirrorId;
        registryUpdated = true;
      }
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 500));
  }

  // Write updated registry back to disk
  if (registryUpdated) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
    console.log(`  Registry updated with new mirror contact IDs`);
  }
}

module.exports = { onboardNewClients, onboardClient, needsOnboarding };
