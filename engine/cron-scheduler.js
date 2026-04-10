/**
 * Cron Scheduler
 * Single entry point that runs all three engines on their schedules.
 *
 * Scoring Engine:  Sunday 11:00pm
 * Monday Delivery: Monday 7:00am
 * Milestone Check: Daily 8:00am
 */

const cron = require('node-cron');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const scoringEngine = require('./scoring-engine');
const mondayDelivery = require('./monday-delivery');
const milestoneCheck = require('./milestone-check');

console.log('=== Freedom Formula Cron Scheduler ===');
console.log(`Started at: ${new Date().toISOString()}`);
console.log('');
console.log('Scheduled jobs:');
console.log('  Scoring Engine:  Every Sunday at 11:00pm');
console.log('  Monday Delivery: Every Monday at 7:00am');
console.log('  Milestone Check: Every day at 8:00am');
console.log('');

// Scoring Engine — Sunday 11:00pm
cron.schedule('0 23 * * 0', async () => {
  console.log(`\n[${new Date().toISOString()}] Scoring engine triggered`);
  try {
    await scoringEngine.run();
  } catch (err) {
    console.error('Scoring engine error:', err);
  }
}, { timezone: 'America/New_York' });

// Monday Delivery — Monday 7:00am
cron.schedule('0 7 * * 1', async () => {
  console.log(`\n[${new Date().toISOString()}] Monday delivery triggered`);
  try {
    await mondayDelivery.run();
  } catch (err) {
    console.error('Monday delivery error:', err);
  }
}, { timezone: 'America/New_York' });

// Milestone Check — Daily 8:00am
cron.schedule('0 8 * * *', async () => {
  console.log(`\n[${new Date().toISOString()}] Milestone check triggered`);
  try {
    await milestoneCheck.run();
  } catch (err) {
    console.error('Milestone check error:', err);
  }
}, { timezone: 'America/New_York' });

console.log('Scheduler running. Press Ctrl+C to stop.');
