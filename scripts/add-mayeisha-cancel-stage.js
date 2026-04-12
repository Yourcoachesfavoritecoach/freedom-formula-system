/**
 * One-off: Add "Cancelled Program" stage to Mayeisha's 90 Day Client Journey pipeline.
 * Updates client-registry.json with the new stage ID.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const axios = require('axios');

const REGISTRY_PATH = path.resolve(__dirname, '../setup/client-registry.json');

async function main() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const mayeisha = registry.clients.find(c => c.name === 'Mayeisha Parker');

  if (!mayeisha) {
    console.error('Mayeisha Parker not found in registry');
    process.exit(1);
  }

  const loc = mayeisha.ghl_location_id;
  const apiKey = mayeisha.ghl_api_key;
  const pipelineId = mayeisha.pipeline_stage_map.client_journey_pipeline_id;

  console.log(`Location: ${loc}`);
  console.log(`Pipeline: ${pipelineId}`);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };

  // Step 1: Get current pipeline stages
  console.log('\nFetching current pipeline stages...');
  const getRes = await axios.get(
    `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${loc}`,
    { headers }
  );

  const pipelines = getRes.data.pipelines || [];
  const journeyPipeline = pipelines.find(p => p.id === pipelineId);

  if (!journeyPipeline) {
    console.error(`Pipeline ${pipelineId} not found`);
    process.exit(1);
  }

  console.log(`Pipeline: ${journeyPipeline.name}`);
  console.log('Current stages:');
  for (const s of journeyPipeline.stages) {
    console.log(`  ${s.position}: ${s.name} (${s.id})`);
  }

  // Check if cancellation stage already exists
  const existing = journeyPipeline.stages.find(s => s.name.toLowerCase().includes('cancel'));
  if (existing) {
    console.log(`\nCancellation stage already exists: ${existing.name} (${existing.id})`);
    console.log('No changes needed.');
    return;
  }

  // Step 2: Add "Cancelled Program" stage at the end
  const existingStages = journeyPipeline.stages.map(s => ({
    id: s.id,
    name: s.name,
    position: s.position,
  }));

  const newPosition = existingStages.length;
  const updatedStages = [
    ...existingStages,
    { name: 'Cancelled Program', position: newPosition },
  ];

  console.log(`\nAdding "Cancelled Program" at position ${newPosition}...`);

  const updateRes = await axios.put(
    `https://services.leadconnectorhq.com/opportunities/pipelines/${pipelineId}`,
    { name: journeyPipeline.name, stages: updatedStages, locationId: loc },
    { headers }
  );

  const updatedPipeline = updateRes.data.pipeline || updateRes.data;
  const newStage = (updatedPipeline.stages || []).find(s => s.name === 'Cancelled Program');

  if (!newStage) {
    console.error('Stage was not created — check GHL response');
    console.log(JSON.stringify(updateRes.data, null, 2));
    process.exit(1);
  }

  console.log(`Created: ${newStage.name} (${newStage.id})`);

  // Step 3: Update registry
  console.log('\nUpdating client-registry.json...');
  const idx = registry.clients.findIndex(c => c.name === 'Mayeisha Parker');
  registry.clients[idx].pipeline_stage_map.cancellation = ['Cancelled Program'];
  registry.clients[idx].pipeline_stage_map.cancellation_stage_ids = [newStage.id];
  delete registry.clients[idx].pipeline_stage_map._note_cancellation;

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  console.log('Registry updated.');

  // Verify
  console.log('\nFinal stages:');
  for (const s of updatedPipeline.stages || []) {
    console.log(`  ${s.position}: ${s.name} (${s.id})`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Failed:', err.response ? err.response.data : err.message);
  process.exit(1);
});
