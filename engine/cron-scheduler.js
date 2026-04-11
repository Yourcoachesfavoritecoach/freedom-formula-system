/**
 * Cron Scheduler
 * Single entry point that runs all engines on their schedules.
 *
 * Scoring Engine:  Sunday 11:00pm
 * Nightly Refresh: Mon-Sat 11:00pm
 * Monday Delivery: Monday 7:00am (only if scoring completed)
 * Milestone Check: Daily 8:00am
 */

const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Ensure client registry exists before anything tries to load it
require('../setup/ensure-registry');

const scoringEngine = require('./scoring-engine');
const mondayDelivery = require('./monday-delivery');
const milestoneCheck = require('./milestone-check');
const nightlyRefresh = require('./nightly-refresh');
const scheduleSync = require('./schedule-sync');
const log = require('../utils/logger');

// Start the API server alongside cron jobs (handles webhooks + form submissions)
require('../api/server');

log.info('Scheduler', '=== Freedom Formula Cron Scheduler ===');
log.info('Scheduler', `Started at: ${new Date().toISOString()}`);
log.info('Scheduler', 'Scheduled jobs:');
log.info('Scheduler', '  Scoring Engine:  Every Sunday at 11:00pm');
log.info('Scheduler', '  Nightly Refresh: Mon-Sat at 11:00pm');
log.info('Scheduler', '  Monday Delivery: Every Monday at 7:00am');
log.info('Scheduler', '  Milestone Check: Every day at 8:00am');
log.info('Scheduler', '  Schedule Sync:   Every day at 6:00am');
log.info('Scheduler', '  API Server:      Running on port ' + (process.env.PORT || process.env.FORM_PORT || 3000));

// Scoring Engine -- Sunday 11:00pm
cron.schedule('0 23 * * 0', async () => {
  log.info('Scheduler', 'Scoring engine triggered');
  try {
    await scoringEngine.run();
  } catch (err) {
    log.fatal('Scheduler', `Scoring engine crashed: ${err.message}`);
  }
}, { timezone: 'America/New_York' });

// Monday Delivery -- Monday 7:00am
cron.schedule('0 7 * * 1', async () => {
  log.info('Scheduler', 'Monday delivery triggered');

  // Verify scoring completed before sending emails
  const completeFlagPath = path.resolve(__dirname, '../setup/scoring-complete.json');
  try {
    if (fs.existsSync(completeFlagPath)) {
      const flag = JSON.parse(fs.readFileSync(completeFlagPath, 'utf8'));
      const completedAt = new Date(flag.completedAt);
      const hoursSinceScoring = (Date.now() - completedAt.getTime()) / (1000 * 60 * 60);

      if (hoursSinceScoring > 12) {
        log.error('Scheduler', `Scoring completed ${Math.round(hoursSinceScoring)}h ago (expected <12h). Delivery may use stale data.`);
      }
      if (flag.clientsFailed > 0) {
        log.warn('Scheduler', `${flag.clientsFailed} clients failed scoring. Delivery will skip them.`);
      }
    } else {
      log.error('Scheduler', 'No scoring-complete flag found. Scoring may not have run. Delivering with last available data.');
    }
  } catch (flagErr) {
    log.warn('Scheduler', `Could not read scoring-complete flag: ${flagErr.message}`);
  }

  try {
    await mondayDelivery.run();
  } catch (err) {
    log.fatal('Scheduler', `Monday delivery crashed: ${err.message}`);
  }
}, { timezone: 'America/New_York' });

// Nightly Refresh -- Mon-Sat 11:00pm (Sunday is handled by full scoring engine)
cron.schedule('0 23 * * 1-6', async () => {
  log.info('Scheduler', 'Nightly refresh triggered');
  try {
    await nightlyRefresh.run();
  } catch (err) {
    log.error('Scheduler', `Nightly refresh crashed: ${err.message}`);
  }
}, { timezone: 'America/New_York' });

// Milestone Check -- Daily 8:00am
cron.schedule('0 8 * * *', async () => {
  log.info('Scheduler', 'Milestone check triggered');
  try {
    await milestoneCheck.run();
  } catch (err) {
    log.error('Scheduler', `Milestone check crashed: ${err.message}`);
  }
}, { timezone: 'America/New_York' });

// Schedule Sync -- Daily 6:00am
cron.schedule('0 6 * * *', async () => {
  log.info('Scheduler', 'Schedule sync triggered');
  try {
    await scheduleSync.run();
  } catch (err) {
    log.error('Scheduler', `Schedule sync crashed: ${err.message}`);
  }
}, { timezone: 'America/New_York' });

log.info('Scheduler', 'Scheduler running. Press Ctrl+C to stop.');
