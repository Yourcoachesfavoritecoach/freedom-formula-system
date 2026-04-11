/**
 * Nightly Refresh
 * Runs every night at 11pm (except Sunday when full scoring runs).
 * Pulls current score values from GHL mirror contacts and updates
 * last-score-results.json so the dashboard always shows fresh data.
 * Also saves a daily snapshot for the "What Changed" digest.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const base44 = require('../utils/base44-api');
const { getCustomFieldValue } = require('../utils/rolling-averages');
const log = require('../utils/logger');
const runLock = require('../utils/run-lock');

const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;

function loadRegistry() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  return registry.clients.filter(c => c.ghl_location_id !== 'USMAN_FILLS_THIS');
}

async function run() {
  // Prevent double-execution or running during scoring
  if (runLock.isLocked('scoring')) {
    log.warn('NightlyRefresh', 'Scoring engine is running. Skipping nightly refresh.');
    return;
  }
  if (!runLock.acquire('nightly-refresh')) {
    log.warn('NightlyRefresh', 'Nightly refresh already running. Skipping.');
    return;
  }

  try {
    return await _runRefresh();
  } finally {
    runLock.release('nightly-refresh');
  }
}

async function _runRefresh() {
  log.info('NightlyRefresh', '=== Nightly Score Refresh ===');
  log.info('NightlyRefresh', `Run time: ${new Date().toISOString()}`);

  const clients = loadRegistry();
  if (clients.length === 0) {
    log.info('NightlyRefresh', 'No clients. Exiting.');
    return;
  }

  // Register sub-account API keys
  for (const client of clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }

  // Get Coaching Dept field definitions
  const cdFieldDefsResponse = await ghl.getCustomFields(COACHING_DEPT_ID);
  const cdFields = cdFieldDefsResponse.customFields || [];

  const resultsData = {};
  let successCount = 0;
  let failCount = 0;

  for (const client of clients) {
    const mirrorId = client.coaching_dept_mirror_contact_id;
    if (!mirrorId) {
      console.log(`  Skipping ${client.name} - no mirror contact`);
      continue;
    }

    try {
      const contactResponse = await ghl.getContact(COACHING_DEPT_ID, mirrorId);
      const mirrorContact = contactResponse.contact || contactResponse;
      const clientEmail = mirrorContact.email || '';
      const readField = (name) => getCustomFieldValue(contactResponse, name, cdFields);

      const score = parseFloat(readField('FF Health Score This Week') || 0);
      const lastWeekScore = parseFloat(readField('FF Health Score Last Week') || 0);
      const scoreStatus = readField('FF Score Status') || '';
      const dangerActive = readField('FF Danger Zone Active') === 'true';
      const program = readField('FF Program') || client.program;

      // Parse status into label/description/color
      let statusLabel = 'Red';
      let statusDescription = 'Danger Zone';
      let statusColor = '#EF4444';
      if (score >= 80) {
        statusLabel = 'Green'; statusDescription = 'Thriving'; statusColor = '#22C55E';
      } else if (score >= 60) {
        statusLabel = 'Yellow'; statusDescription = 'Watch'; statusColor = '#EAB308';
      } else if (score >= 40) {
        statusLabel = 'Orange'; statusDescription = 'At Risk'; statusColor = '#F97316';
      }

      // Read breakdown fields
      const breakdown = {
        formSubmission: parseFloat(readField('FF Form Submission Score') || 0),
        coachingCall: parseFloat(readField('FF Coaching Call Score') || 0),
        outreachResponse: parseFloat(readField('FF Outreach Response Score') || 0),
        orgChart: parseFloat(readField('FF Org Chart Score') || 0),
        weeklyKPIs: parseFloat(readField('FF Weekly KPIs Score') || 0),
        coachingDirective: parseFloat(readField('FF Coaching Directive Score') || 0),
        hoursReclaimed: parseFloat(readField('FF Hours Reclaimed Score') || 0),
        revenue: parseFloat(readField('FF Revenue Score') || 0),
        leadVolume: parseFloat(readField('FF Lead Volume Score') || 0),
        conversionRate: parseFloat(readField('FF Conversion Rate Score') || 0),
        blendedCPL: parseFloat(readField('FF Blended CPL Score') || 0),
      };

      resultsData[client.name] = {
        email: clientEmail,
        score,
        lastWeekScore,
        status: { label: statusLabel, description: statusDescription, color: statusColor },
        dangerActive,
        breakdown,
        program,
      };

      console.log(`  ${client.name}: ${score}/100 (${statusLabel})`);
      successCount++;
    } catch (err) {
      console.error(`  FAILED: ${client.name} - ${err.message}`);
      failCount++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  // Write updated results
  const resultsPath = path.resolve(__dirname, '../setup/last-score-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(resultsData, null, 2));
  console.log(`\nResults saved: ${successCount} succeeded, ${failCount} failed`);

  // Push refreshed scores to Base44
  const today = new Date().toISOString().split('T')[0];
  for (const [name, data] of Object.entries(resultsData)) {
    if (!data.email) continue;
    try {
      await base44.pushClientScore(data.email, today, {
        client_name: name,
        program: data.program || '',
        score: data.score,
        last_week_score: data.lastWeekScore || 0,
        status_label: data.status?.label || '',
        status_description: data.status?.description || '',
        status_color: data.status?.color || '',
        danger_active: data.dangerActive || false,
        breakdown: data.breakdown || {},
      });
    } catch (b44Err) {
      console.log(`  Base44 push failed for ${name}: ${b44Err.message}`);
    }
  }
  console.log('Base44 score push complete');

  // Save daily snapshot for "What Changed" digest
  await saveDailySnapshot(resultsData);

  return resultsData;
}

/**
 * Save a daily snapshot to daily-snapshots.json.
 * Keeps last 30 days of snapshots.
 */
async function saveDailySnapshot(resultsData) {
  const snapshotPath = path.resolve(__dirname, '../setup/daily-snapshots.json');
  const today = new Date().toISOString().split('T')[0];

  let snapshots = [];
  if (fs.existsSync(snapshotPath)) {
    try {
      snapshots = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    } catch (e) {
      snapshots = [];
    }
  }

  // Build snapshot with key metrics per client
  const snapshot = {
    date: today,
    timestamp: new Date().toISOString(),
    clients: {},
  };

  for (const [name, data] of Object.entries(resultsData)) {
    snapshot.clients[name] = {
      score: data.score,
      status: data.status?.label || '',
      dangerActive: data.dangerActive || false,
      breakdown: data.breakdown || {},
    };
  }

  // Replace if same date exists, otherwise append
  const existingIdx = snapshots.findIndex(s => s.date === today);
  if (existingIdx >= 0) {
    snapshots[existingIdx] = snapshot;
  } else {
    snapshots.push(snapshot);
  }

  // Keep last 30 days
  if (snapshots.length > 30) snapshots = snapshots.slice(-30);

  fs.writeFileSync(snapshotPath, JSON.stringify(snapshots, null, 2));
  console.log(`Daily snapshot saved for ${today} (${snapshots.length} days stored)`);
}

module.exports = { run };

// Allow direct execution
if (require.main === module) {
  run()
    .then(() => {
      console.log('Nightly refresh complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Nightly refresh failed:', err);
      process.exit(1);
    });
}
