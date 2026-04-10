/**
 * Setup Script: Create Freedom Formula Pipeline
 * Creates the 11-stage pipeline inside The Coaching Dept. sub-account.
 * Run once during initial setup.
 */

const ghl = require('../utils/ghl-api');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const LOCATION_ID = process.env.COACHING_DEPT_LOCATION_ID;

const PIPELINE = {
  name: 'Freedom Formula',
  stages: [
    { name: 'Payment Received', position: 0 },
    { name: 'Assessment Pending', position: 1 },
    { name: 'Assessment Complete / Onboarding Scheduled', position: 2 },
    { name: 'Active - Weekly Cycle Begins', position: 3 },
    { name: '30-Day Check-In', position: 4 },
    { name: '60-Day Check-In', position: 5 },
    { name: '90-Day Review', position: 6 },
    { name: 'Renewal - Continuing', position: 7 },
    { name: 'Upgrade Eligible - Black Circle Offer', position: 8 },
    { name: 'Upgraded to Black Circle', position: 9 },
    { name: 'Cancelled', position: 10 },
  ],
};

async function main() {
  console.log('Creating Freedom Formula pipeline...');
  console.log(`Location: ${LOCATION_ID}`);

  if (!LOCATION_ID) {
    console.error('COACHING_DEPT_LOCATION_ID is not set. Check your .env file.');
    process.exit(1);
  }

  try {
    const result = await ghl.createPipeline(LOCATION_ID, PIPELINE);
    console.log('Pipeline created successfully.');
    console.log('Pipeline ID:', result.pipeline ? result.pipeline.id : result.id);

    if (result.pipeline && result.pipeline.stages) {
      console.log('\nStages:');
      for (const stage of result.pipeline.stages) {
        console.log(`  ${stage.position}: ${stage.name} (ID: ${stage.id})`);
      }
    }

    console.log('\nSave the pipeline ID and stage IDs for reference.');
  } catch (err) {
    console.error('Failed to create pipeline:', err.message);
    process.exit(1);
  }
}

main();
