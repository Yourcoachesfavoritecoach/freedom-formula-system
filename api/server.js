/**
 * Check-In Form API Server
 * Receives weekly check-in form submissions and writes them to GHL.
 * Also serves the check-in form HTML.
 * Handles GHL webhook for automatic client onboarding.
 *
 * Endpoints:
 *   GET  /                        → Serves the check-in form
 *   POST /api/check-in            → Receives form data, writes note to GHL contact
 *   POST /api/webhook/new-client   → GHL webhook: creates ClickUp task for Usman + runs onboarding
 *   GET  /admin/onboard            → Usman's admin page to register new client sub-accounts
 *   POST /api/admin/onboard        → Registers client in system + triggers instant onboarding
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const { onboardNewClients } = require('../engine/onboard-client');
const clickup = require('../utils/clickup-api');

const app = express();
const PORT = process.env.PORT || process.env.FORM_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Load client registry for PIT resolution
function loadRegistry() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  for (const client of registry.clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }
  return registry.clients;
}

// Register keys on startup
loadRegistry();

// ─── Serve the form ───
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../forms/weekly-check-in.html'));
});

// ─── Handle check-in submission ───
app.post('/api/check-in', async (req, res) => {
  try {
    const { contactId, locationId, firstName, email, rating, noteBody, submittedAt, responses } = req.body;

    if (!contactId) {
      return res.status(400).json({ error: 'Missing contact_id' });
    }
    if (!noteBody) {
      return res.status(400).json({ error: 'Missing note body' });
    }

    const targetLocationId = locationId || ghl.COACHING_DEPT_ID;

    // 1. Write the reflection as a note on the contact in The Coaching Dept.
    console.log(`Writing check-in note for contact ${contactId} (${firstName || email || 'unknown'})`);
    await ghl.addContactNote(targetLocationId, contactId, noteBody);

    // 2. Update the weekly self-rating custom field if we have it
    if (rating !== null && rating !== undefined) {
      try {
        const fieldDefsResponse = await ghl.getCustomFields(targetLocationId);
        const fieldDefs = fieldDefsResponse.customFields || [];

        await ghl.writeFieldsToContact(targetLocationId, contactId, {
          'FF Weekly Self Rating': rating,
        }, fieldDefs);

        console.log(`  Updated FF Weekly Self Rating: ${rating}`);
      } catch (fieldErr) {
        console.error(`  Warning: Could not update custom field: ${fieldErr.message}`);
        // Don't fail the request — the note is what matters
      }
    }

    // 3. Log success
    console.log(`  Check-in saved for ${firstName || email || contactId} - Rating: ${rating}/10 - ${new Date().toISOString()}`);

    res.json({
      success: true,
      message: 'Check-in recorded.',
      contactId,
      rating,
      timestamp: submittedAt || new Date().toISOString(),
    });
  } catch (err) {
    console.error('Check-in submission failed:', err.message);
    res.status(500).json({ error: 'Failed to save check-in. Please try again.' });
  }
});

// ─── GHL Webhook: New client signed ───
// Add this URL to the GHL workflow that fires when agreement is signed.
// Creates a ClickUp task for Usman with setup instructions.
// Also runs onboarding for any clients already in the registry.
app.post('/api/webhook/new-client', async (req, res) => {
  try {
    const { contact_name, first_name, last_name, email, program } = req.body;
    const clientName = contact_name || `${first_name || ''} ${last_name || ''}`.trim() || 'New Client';
    const clientProgram = program || 'Freedom Formula';

    console.log(`Webhook: New client signed - ${clientName} (${clientProgram}) - ${new Date().toISOString()}`);

    // Build the admin page URL for Usman
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const adminPageUrl = `${protocol}://${host}/admin/onboard`;

    // Create ClickUp task for Usman with step-by-step instructions
    await clickup.createOnboardingTask(clientName, clientProgram, adminPageUrl);

    // Also run onboarding for any clients already in registry
    loadRegistry();
    await onboardNewClients();

    res.json({ success: true, message: `ClickUp task created for ${clientName}.` });
  } catch (err) {
    console.error('Webhook new-client failed:', err.message);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

// ─── Serve admin onboarding page ───
app.get('/admin/onboard', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../forms/admin-onboard.html'));
});

// ─── Handle admin onboarding submission ───
app.post('/api/admin/onboard', async (req, res) => {
  try {
    // Token check
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      const authHeader = req.headers.authorization || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const queryToken = req.query.token || '';
      if (bearerToken !== adminToken && queryToken !== adminToken) {
        return res.status(401).json({ error: 'Unauthorized. Invalid admin token.' });
      }
    }

    const { name, program, ghl_location_id, ghl_api_key, ff_contact_id, google_ads_customer_id, meta_ad_account_id } = req.body;

    if (!name || !program || !ghl_location_id || !ghl_api_key || !ff_contact_id) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Load current registry
    const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
    delete require.cache[require.resolve(registryPath)];
    const registry = require(registryPath);

    // Check for duplicate
    const exists = registry.clients.some(c => c.ghl_location_id === ghl_location_id);
    if (exists) {
      return res.status(409).json({ error: 'Client with this location ID already exists.' });
    }

    // Add new client with empty mirror ID (onboarding will fill it)
    const newClient = {
      name,
      program,
      ghl_location_id,
      ghl_api_key,
      ff_contact_id,
      google_ads_customer_id: google_ads_customer_id || '',
      meta_ad_account_id: meta_ad_account_id || '',
      coaching_dept_mirror_contact_id: '',
    };

    registry.clients.push(newClient);
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');

    // Register the API key and trigger immediate onboarding
    ghl.registerLocationKey(ghl_location_id, ghl_api_key);
    const { onboardNewClients: runOnboard } = require('../engine/onboard-client');
    await runOnboard();

    // Re-read registry to get the mirror contact ID
    delete require.cache[require.resolve(registryPath)];
    const updatedRegistry = require(registryPath);
    const onboardedClient = updatedRegistry.clients.find(c => c.ghl_location_id === ghl_location_id);
    const mirrorId = onboardedClient ? onboardedClient.coaching_dept_mirror_contact_id : '';

    console.log(`Admin onboarded: ${name} (${program}) - Mirror: ${mirrorId}`);

    res.json({
      success: true,
      message: `${name} onboarded successfully.`,
      mirrorContactId: mirrorId,
    });
  } catch (err) {
    console.error('Admin onboard failed:', err.message);
    res.status(500).json({ error: 'Onboarding failed: ' + err.message });
  }
});

// ─── Health check ───
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`Check-in form server running on http://localhost:${PORT}`);
  console.log(`Form URL example: http://localhost:${PORT}/?contact_id=CONTACT_ID&first_name=NAME&email=EMAIL`);
});

module.exports = app;
