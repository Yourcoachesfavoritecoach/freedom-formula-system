/**
 * Monday Morning Delivery
 * Runs every Monday at 7:00am via cron.
 * Sends branded score emails to each FF client.
 * Sends internal summary to Dave and Heather.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const { getScoreStatus } = require('../utils/score-calculator');
const { getBCScoreStatus } = require('../utils/bc-score-calculator');
const { getCustomFieldValue } = require('../utils/rolling-averages');

const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;
const FORM_BASE_URL = process.env.FORM_BASE_URL;
const DAVE_EMAIL = process.env.DAVE_EMAIL;
const HEATHER_EMAIL = process.env.HEATHER_EMAIL;

function loadRegistry() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);

  // Register each client's sub-account API key
  for (const client of registry.clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }

  return registry.clients.filter((c) => c.ghl_location_id !== 'USMAN_FILLS_THIS');
}

function loadTemplate(name) {
  return fs.readFileSync(path.resolve(__dirname, `../templates/${name}`), 'utf8');
}

function getWeekDateString() {
  const now = new Date();
  return now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function getContextMessage(status) {
  switch (status.label) {
    case 'Green':
      return 'You are executing. Keep the standard high this week.';
    case 'Yellow':
      return 'Your engagement is solid. Your numbers need attention. Let us fix that this week.';
    case 'Orange':
      return 'Something is off. Check your form, your calls, and your numbers. We are watching.';
    case 'Red':
      return 'We need to talk. Expect to hear from us today.';
    default:
      return '';
  }
}

// Metric breakdown definitions for the email
const METRIC_LABELS = {
  formSubmission:    { name: 'Weekly form submitted', max: 10, category: 'engagement' },
  coachingCall:      { name: 'Coaching call attended', max: 10, category: 'engagement' },
  outreachResponse:  { name: 'Responded to outreach', max: 5, category: 'engagement' },
  opControl:         { name: 'Operational control rating', max: 10, category: 'operations' },
  weeklyKPIs:        { name: 'Weekly KPIs populated', max: 10, category: 'operations' },
  coachingDirective: { name: 'Coaching directive implemented', max: 10, category: 'operations' },
  hoursReclaimed:    { name: 'Hours reclaimed this week', max: 5, category: 'operations' },
  revenue:           { name: 'Revenue vs 4-week average', max: 15, category: 'performance' },
  leadVolume:        { name: 'Lead volume trend', max: 10, category: 'performance' },
  conversionRate:    { name: 'Conversion rate trend', max: 10, category: 'performance' },
  blendedCPL:        { name: 'Blended cost per lead', max: 5, category: 'performance' },
};

function buildBreakdownRow(metricKey, points) {
  const def = METRIC_LABELS[metricKey];
  if (!def) return '';
  const pct = Math.round((points / def.max) * 100);
  const barColor = points === def.max ? '#22C55E' : points > 0 ? '#F56600' : '#E5E5E5';
  const pointsColor = points === def.max ? '#22C55E' : points > 0 ? '#F56600' : '#EF4444';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td style="padding:10px 12px 2px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td><p style="margin:0;font-size:13px;color:#1A1A1A;">${def.name}</p></td>
            <td align="right"><p style="margin:0;font-size:13px;font-weight:700;color:${pointsColor};">${points} / ${def.max}</p></td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:2px 12px 10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F0F0;border-radius:3px;height:6px;">
          <tr><td style="width:${pct}%;background:${barColor};border-radius:3px;height:6px;"></td><td></td></tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function buildBreakdownHTML(breakdown) {
  let engagementRows = '';
  let operationsRows = '';
  let performanceRows = '';
  let engagementTotal = 0;
  let operationsTotal = 0;
  let performanceTotal = 0;

  for (const [key, points] of Object.entries(breakdown)) {
    const def = METRIC_LABELS[key];
    if (!def) continue;
    const row = buildBreakdownRow(key, points);
    if (def.category === 'engagement') { engagementRows += row; engagementTotal += points; }
    else if (def.category === 'operations') { operationsRows += row; operationsTotal += points; }
    else if (def.category === 'performance') { performanceRows += row; performanceTotal += points; }
  }

  return { engagementRows, operationsRows, performanceRows, engagementTotal, operationsTotal, performanceTotal };
}

async function sendClientEmail(client, scoreData, template) {
  const { score, lastWeekScore, status, breakdown } = scoreData;
  const change = score - lastWeekScore;
  const changeDirection = change >= 0 ? 'Up' : 'Down';
  const changeAbs = Math.abs(change);

  const formUrl = `${FORM_BASE_URL}?contact_id=${client.ff_contact_id}&location_id=${client.ghl_location_id}`;

  // Get client email from their contact record
  let clientEmail = '';
  try {
    const contactData = await ghl.getContact(client.ghl_location_id, client.ff_contact_id);
    const contact = contactData.contact || contactData;
    clientEmail = contact.email || '';
  } catch (err) {
    console.log(`  Warning: Could not fetch client email for ${client.name}`);
    return;
  }

  if (!clientEmail) {
    console.log(`  Skipping ${client.name} - no email on file`);
    return;
  }

  // Build breakdown HTML
  const bd = buildBreakdownHTML(breakdown || {});

  const html = template
    .replace(/\{\{CLIENT_NAME\}\}/g, client.name)
    .replace(/\{\{SCORE\}\}/g, score)
    .replace(/\{\{STATUS_LABEL\}\}/g, status.label)
    .replace(/\{\{STATUS_DESCRIPTION\}\}/g, status.description)
    .replace(/\{\{STATUS_COLOR\}\}/g, status.color)
    .replace(/\{\{WEEK_CHANGE\}\}/g, changeAbs)
    .replace(/\{\{CHANGE_DIRECTION\}\}/g, changeDirection)
    .replace(/\{\{CONTEXT_MESSAGE\}\}/g, getContextMessage(status))
    .replace(/\{\{FORM_URL\}\}/g, formUrl)
    .replace(/\{\{CLIENT_EMAIL\}\}/g, clientEmail)
    .replace(/\{\{WEEK_DATE\}\}/g, getWeekDateString())
    .replace(/\{\{ENGAGEMENT_ROWS\}\}/g, bd.engagementRows)
    .replace(/\{\{OPERATIONS_ROWS\}\}/g, bd.operationsRows)
    .replace(/\{\{PERFORMANCE_ROWS\}\}/g, bd.performanceRows)
    .replace(/\{\{ENGAGEMENT_TOTAL\}\}/g, bd.engagementTotal)
    .replace(/\{\{OPERATIONS_TOTAL\}\}/g, bd.operationsTotal)
    .replace(/\{\{PERFORMANCE_TOTAL\}\}/g, bd.performanceTotal)
    .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, '{{unsubscribe_link}}');

  try {
    await ghl.sendEmail(COACHING_DEPT_ID, {
      type: 'Email',
      contactId: client.coaching_dept_mirror_contact_id,
      subject: `Your Freedom Formula Score - Week of ${getWeekDateString()}`,
      html: html,
      emailFrom: process.env.SENDER_EMAIL || 'team@thecoachingdept.com',
    });

    // Log delivery to contact activity
    await ghl.addContactNote(client.ghl_location_id, client.ff_contact_id,
      `Monday score delivery sent - Score: ${score} - Status: ${status.label} / ${status.description} - ${new Date().toISOString().split('T')[0]}`);

    console.log(`  Sent: ${client.name} (${score} - ${status.label})`);
  } catch (err) {
    console.error(`  FAILED to send to ${client.name}: ${err.message}`);
  }
}

function buildClientRow(data) {
  const { name, program, score, status, change, dangerActive, daysUntilMilestone } = data;
  const changeStr = change >= 0 ? `+${change}` : `${change}`;
  const changeColor = change >= 0 ? '#22C55E' : '#EF4444';
  const dangerStr = dangerActive ? 'YES' : '-';
  const dangerColor = dangerActive ? '#EF4444' : '#888888';

  return `<tr style="border-bottom:1px solid #F0F0F0;">
    <td style="padding:10px 8px;font-size:14px;color:#1A1A1A;font-weight:600;">${name}</td>
    <td style="padding:10px 8px;font-size:13px;color:#888888;">${program}</td>
    <td style="padding:10px 8px;text-align:center;font-size:16px;font-weight:700;color:${status.color};">${score}</td>
    <td style="padding:10px 8px;text-align:center;font-size:12px;font-weight:700;color:${status.color};">${status.label}</td>
    <td style="padding:10px 8px;text-align:center;font-size:13px;color:${changeColor};font-weight:600;">${changeStr}</td>
    <td style="padding:10px 8px;text-align:center;font-size:13px;color:${dangerColor};font-weight:700;">${dangerStr}</td>
    <td style="padding:10px 8px;text-align:center;font-size:13px;color:#888888;">${daysUntilMilestone || '-'}</td>
  </tr>`;
}

async function sendInternalSummary(clientResults) {
  const summaryTemplate = loadTemplate('internal-summary.html');

  // Sort by score ascending (lowest first)
  const sorted = [...clientResults].sort((a, b) => (a.score || 0) - (b.score || 0));

  let greenCount = 0, yellowCount = 0, orangeCount = 0, redCount = 0, dangerCount = 0;

  const rows = sorted.map((r) => {
    const status = r.status || getScoreStatus(r.score || 0);
    const change = (r.score || 0) - (r.lastWeekScore || 0);

    if (status.label === 'Green') greenCount++;
    else if (status.label === 'Yellow') yellowCount++;
    else if (status.label === 'Orange') orangeCount++;
    else if (status.label === 'Red') redCount++;
    if (r.dangerActive) dangerCount++;

    return buildClientRow({
      name: r.name,
      program: r.program === 'Black Circle' ? 'BC' : 'FF',
      score: r.score || 0,
      status,
      change,
      dangerActive: r.dangerActive || false,
      daysUntilMilestone: r.daysUntilMilestone || '',
    });
  }).join('');

  const html = summaryTemplate
    .replace(/\{\{WEEK_DATE\}\}/g, getWeekDateString())
    .replace(/\{\{CLIENT_ROWS\}\}/g, rows)
    .replace(/\{\{TOTAL_CLIENTS\}\}/g, sorted.length)
    .replace(/\{\{GREEN_COUNT\}\}/g, greenCount)
    .replace(/\{\{YELLOW_COUNT\}\}/g, yellowCount)
    .replace(/\{\{ORANGE_COUNT\}\}/g, orangeCount)
    .replace(/\{\{RED_COUNT\}\}/g, redCount)
    .replace(/\{\{DANGER_COUNT\}\}/g, dangerCount);

  // Send to Dave and Heather via their Coaching Dept mirror contacts
  // For internal delivery, we use the GHL email API with a direct email address
  try {
    // Search for Dave's contact in Coaching Dept
    // Use known contact IDs for Dave and Heather
    const daveContactId = 'fRjv5Xrl10r4y7AK1AFL';
    const heatherContactId = '3dEZDwFLPynAVe8MtHcM';

    await ghl.sendEmail(COACHING_DEPT_ID, {
      type: 'Email',
      contactId: daveContactId,
      subject: `FF Client Health Summary - Week of ${getWeekDateString()}`,
      html: html,
      emailFrom: process.env.SENDER_EMAIL || 'team@thecoachingdept.com',
    });
    console.log('  Internal summary sent to Dave');

    await ghl.sendEmail(COACHING_DEPT_ID, {
      type: 'Email',
      contactId: heatherContactId,
      subject: `FF Client Health Summary - Week of ${getWeekDateString()}`,
      html: html,
      emailFrom: process.env.SENDER_EMAIL || 'team@thecoachingdept.com',
    });
    console.log('  Internal summary sent to Heather');
  } catch (err) {
    console.error(`  Failed to send internal summary: ${err.message}`);
  }
}

async function run() {
  console.log('=== Monday Morning Delivery ===');
  console.log(`Run time: ${new Date().toISOString()}`);

  const clients = loadRegistry();
  console.log(`Delivering to ${clients.length} Freedom Formula clients`);

  if (clients.length === 0) {
    console.log('No clients in registry. Exiting.');
    return;
  }

  const scoreTemplate = loadTemplate('score-email.html');
  const clientResults = [];

  // Load Coaching Dept field defs once
  const cdFieldDefsResponse = await ghl.getCustomFields(COACHING_DEPT_ID);
  const cdFieldDefs = cdFieldDefsResponse.customFields || [];

  for (const client of clients) {
    try {
      // Read score data from mirror record in Coaching Dept
      const mirrorData = await ghl.getContact(COACHING_DEPT_ID, client.coaching_dept_mirror_contact_id);

      const score = parseFloat(getCustomFieldValue(mirrorData, 'FF Health Score This Week', cdFieldDefs) || 0);
      const lastWeekScore = parseFloat(getCustomFieldValue(mirrorData, 'FF Health Score Last Week', cdFieldDefs) || 0);
      const dangerActive = getCustomFieldValue(mirrorData, 'FF Danger Zone Active', cdFieldDefs) === 'true';
      const daysUntilMilestone = getCustomFieldValue(mirrorData, 'FF Days Until Next Milestone', cdFieldDefs);
      const status = client.program === 'Black Circle' ? getBCScoreStatus(score) : getScoreStatus(score);

      // Load breakdown from last scoring run
      let breakdown = {};
      try {
        const resultsPath = path.resolve(__dirname, '../setup/last-score-results.json');
        delete require.cache[require.resolve(resultsPath)];
        const lastResults = require(resultsPath);
        if (lastResults[client.name] && lastResults[client.name].breakdown) {
          breakdown = lastResults[client.name].breakdown;
        }
      } catch (e) {
        // No saved results, breakdown will be empty
      }

      const scoreData = { score, lastWeekScore, status, dangerActive, daysUntilMilestone, breakdown };

      await sendClientEmail(client, scoreData, scoreTemplate);

      clientResults.push({
        name: client.name,
        program: client.program,
        score,
        lastWeekScore,
        status,
        dangerActive,
        daysUntilMilestone,
      });

      // Rate limit
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`  FAILED: ${client.name} - ${err.message}`);
      clientResults.push({
        name: client.name,
        program: client.program,
        score: 0,
        lastWeekScore: 0,
        status: getScoreStatus(0),
        dangerActive: false,
        error: err.message,
      });
    }
  }

  // Send internal summary
  console.log('\nSending internal summary...');
  await sendInternalSummary(clientResults);

  console.log('\n=== Delivery Complete ===');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Monday delivery failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
