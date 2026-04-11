/**
 * Scoring Engine
 * Runs every Sunday at 11:00pm via cron.
 * Loops through every Freedom Formula client in the registry,
 * pulls data, calculates health score, writes results back.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const googleAds = require('../utils/google-ads-api');
const metaAds = require('../utils/meta-ads-api');
const { calculateScore, getScoreStatus } = require('../utils/score-calculator');
const { calculateBCScore, getBCScoreStatus } = require('../utils/bc-score-calculator');
const { updateAllRollingAverages, getCustomFieldValue } = require('../utils/rolling-averages');
const { ALL_FIELDS, FF_FIELDS, BC_FIELDS } = require('../utils/field-definitions');
const { onboardNewClients } = require('./onboard-client');
const base44 = require('../utils/base44-api');
const log = require('../utils/logger');
const runLock = require('../utils/run-lock');

const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;
const REENGAGEMENT_WORKFLOW_ID = process.env.GHL_REENGAGEMENT_WORKFLOW_ID;

/**
 * Auto-provision custom fields on a sub-account.
 * Checks which fields exist and creates any missing ones.
 * FF clients get FF fields. BC clients get all fields (FF + BC).
 */
async function provisionFields(locationId, program) {
  const requiredFields = program === 'Black Circle' ? ALL_FIELDS : FF_FIELDS;

  let existingFields = [];
  try {
    const existing = await ghl.getCustomFields(locationId);
    existingFields = existing.customFields || [];
  } catch (err) {
    console.log(`  Warning: Could not fetch fields for provisioning - ${err.message}`);
    return;
  }

  const existingNames = new Set(existingFields.map((f) => f.name));
  const missing = requiredFields.filter((f) => !existingNames.has(f.name));

  if (missing.length === 0) return;

  console.log(`  Provisioning ${missing.length} missing custom fields...`);
  for (const field of missing) {
    try {
      await ghl.createCustomField(locationId, {
        name: field.name,
        dataType: field.dataType,
        position: field.position,
        model: 'contact',
      });
      console.log(`    Created: ${field.name}`);
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.log(`    Failed to create ${field.name}: ${err.message}`);
    }
  }
}

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

  const validClients = registry.clients.filter((c) => c.ghl_location_id !== 'USMAN_FILLS_THIS');
  const ffClients = validClients.filter((c) => c.program === 'Freedom Formula');
  const bcClients = validClients.filter((c) => c.program === 'Black Circle');

  return { ffClients, bcClients };
}

function getWeekDates() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() - dayOfWeek); // This Sunday
  endDate.setHours(23, 59, 59, 999);

  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 6); // Previous Monday
  startDate.setHours(0, 0, 0, 0);

  return {
    start: startDate,
    end: endDate,
    startStr: startDate.toISOString().split('T')[0],
    endStr: endDate.toISOString().split('T')[0],
  };
}

async function scoreClient(client) {
  const loc = client.ghl_location_id;
  const contactId = client.ff_contact_id;
  const mirrorId = client.coaching_dept_mirror_contact_id;
  const week = getWeekDates();

  console.log(`\nScoring: ${client.name}`);
  console.log(`  Location: ${loc} | Contact: ${contactId}`);

  // Load custom field definitions from client sub-account
  const fieldDefsResponse = await ghl.getCustomFields(loc);
  const fieldDefs = fieldDefsResponse.customFields || [];

  // Load contact data
  const contactResponse = await ghl.getContact(loc, contactId);
  const contact = contactResponse.contact || contactResponse;
  const clientEmail = contact.email || '';

  // Helper to read fields
  const readField = (name) => getCustomFieldValue(contactResponse, name, fieldDefs);

  // ─── Pull Engagement Data ───

  // Metric 1: Form submission timestamp
  const formSubmittedTimestamp = readField('FF Operational Control Rating') ? new Date().toISOString() : null;
  // Check actual submission by looking at contact activity notes
  // The form POSTs and creates a note with timestamp

  // Metric 2: Coaching call disposition
  let appointmentDisposition = null;
  try {
    // Get all calendars for this location
    const calData = await ghl.getCalendars(loc);
    const calendars = calData.calendars || [];

    // Search all calendars for appointments in the scoring week
    for (const cal of calendars) {
      try {
        const appointments = await ghl.getAppointments(loc, {
          calendarId: cal.id,
          startTime: week.start.toISOString(),
          endTime: week.end.toISOString(),
        });
        if (appointments.events && appointments.events.length > 0) {
          // Find appointments for this contact
          for (const appt of appointments.events) {
            if (appt.contactId === contactId || appt.contact_id === contactId) {
              appointmentDisposition = appt.appointmentStatus || appt.status || null;
            }
          }
        }
      } catch (calErr) {
        // Skip calendars that fail
      }
    }
  } catch (err) {
    console.log(`  Warning: Could not fetch appointments - ${err.message}`);
  }

  // Metric 3: Outreach response time
  let lastOutboundTimestamp = null;
  let lastInboundTimestamp = null;
  let outreachSentThisWeek = false;
  try {
    const convos = await ghl.getConversations(loc, contactId);
    if (convos.conversations && convos.conversations.length > 0) {
      const convoId = convos.conversations[0].id;
      const messages = await ghl.getMessages(loc, convoId, { limit: 20 });
      if (messages.messages && Array.isArray(messages.messages)) {
        for (const msg of messages.messages) {
          const msgDate = new Date(msg.dateAdded);
          if (msgDate >= week.start && msgDate <= week.end) {
            if (msg.direction === 'outbound' || msg.type === 'TYPE_OUTBOUND') {
              outreachSentThisWeek = true;
              if (!lastOutboundTimestamp || msgDate > new Date(lastOutboundTimestamp)) {
                lastOutboundTimestamp = msg.dateAdded;
              }
            }
            if (msg.direction === 'inbound' || msg.type === 'TYPE_INBOUND') {
              if (!lastInboundTimestamp || msgDate > new Date(lastInboundTimestamp)) {
                lastInboundTimestamp = msg.dateAdded;
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.log(`  Warning: Could not fetch conversations - ${err.message}`);
  }

  // ─── Pull Operational Data ───

  const operationalControlRating = readField('FF Operational Control Rating');
  const directiveStatus = readField('FF Coaching Directive Status');
  const hoursReclaimedThisWeek = readField('FF Hours Reclaimed This Week');
  const hoursRunningTotal = parseFloat(readField('FF Hours Reclaimed Running Total') || 0);

  // Update hours running total
  if (hoursReclaimedThisWeek !== null && hoursReclaimedThisWeek !== '') {
    const newTotal = hoursRunningTotal + parseFloat(hoursReclaimedThisWeek);
    await ghl.writeFieldsToContact(loc, contactId, {
      'FF Hours Reclaimed Running Total': newTotal,
    }, fieldDefs);
  }

  // ─── Pull Business Performance Data ───

  const weeklyRevenue = parseFloat(readField('FF Weekly Revenue') || 0);
  const weeklyNewMembers = parseFloat(readField('FF Weekly New Members') || 0);
  const weeklyCancellations = parseFloat(readField('FF Weekly Cancellations') || 0);
  const activeMemberCount = parseFloat(readField('FF Active Member Count') || 0);

  // Google Ads data
  let googleLeads = 0;
  let googleSpend = 0;
  let googleFailed = false;
  if (client.google_ads_customer_id && client.google_ads_customer_id !== 'USMAN_FILLS_THIS') {
    const gResult = await googleAds.getWeeklyLeadsAndSpend(
      client.google_ads_customer_id, week.startStr, week.endStr
    );
    if (gResult === null) {
      googleFailed = true;
      console.log('  Warning: Google Ads pull failed, holding prior score for ad metrics');
    } else {
      googleLeads = gResult.leads;
      googleSpend = gResult.spend;
    }
  }

  // Meta Ads data
  let metaLeads = 0;
  let metaSpend = 0;
  let metaFailed = false;
  if (client.meta_ad_account_id && client.meta_ad_account_id !== 'USMAN_FILLS_THIS') {
    const mResult = await metaAds.getWeeklyLeadsAndSpend(
      client.meta_ad_account_id, week.startStr, week.endStr
    );
    if (mResult === null) {
      metaFailed = true;
      console.log('  Warning: Meta Ads pull failed, holding prior score for ad metrics');
    } else {
      metaLeads = mResult.leads;
      metaSpend = mResult.spend;
    }
  }

  // Combined lead and spend totals
  const totalWeeklyLeads = googleLeads + metaLeads;
  const totalWeeklySpend = googleSpend + metaSpend;
  const blendedCPL = totalWeeklyLeads > 0 ? totalWeeklySpend / totalWeeklyLeads : 0;
  const conversionRate = totalWeeklyLeads > 0 ? weeklyNewMembers / totalWeeklyLeads : 0;

  // Write weekly metrics to contact
  await ghl.writeFieldsToContact(loc, contactId, {
    'FF Weekly Leads': totalWeeklyLeads,
    'FF Blended CPL This Week': Math.round(blendedCPL * 100) / 100,
    'FF Conversion Rate This Week': Math.round(conversionRate * 10000) / 100,
  }, fieldDefs);

  // Log data pull failures
  if (googleFailed) {
    await ghl.addContactNote(loc, contactId,
      `Score hold - Google Ads data pull failed - ${new Date().toISOString().split('T')[0]}`);
  }
  if (metaFailed) {
    await ghl.addContactNote(loc, contactId,
      `Score hold - Meta Ads data pull failed - ${new Date().toISOString().split('T')[0]}`);
  }

  // ─── Update Rolling Averages ───

  const averages = await updateAllRollingAverages(loc, contactId, {
    revenue: weeklyRevenue,
    leads: totalWeeklyLeads,
    conversionRate: conversionRate * 100,
    blendedCPL: blendedCPL,
  }, fieldDefs);

  // ─── Consecutive Misses ───

  let consecutiveMissedForms = parseInt(readField('FF Consecutive Missed Forms') || 0);
  let consecutiveMissedCalls = parseInt(readField('FF Consecutive Missed Calls') || 0);

  // Form: check if org chart status was updated this week (proxy for form submission)
  const formSubmitted = operationalControlRating && operationalControlRating !== '';
  if (!formSubmitted) {
    consecutiveMissedForms++;
  } else {
    consecutiveMissedForms = 0;
  }

  // Calls: check appointment disposition
  if (!appointmentDisposition || appointmentDisposition === 'no_show' || appointmentDisposition === 'cancelled') {
    consecutiveMissedCalls++;
  } else if (appointmentDisposition === 'attended' || appointmentDisposition === 'completed' || appointmentDisposition === 'showed') {
    consecutiveMissedCalls = 0;
  }

  await ghl.writeFieldsToContact(loc, contactId, {
    'FF Consecutive Missed Forms': consecutiveMissedForms,
    'FF Consecutive Missed Calls': consecutiveMissedCalls,
  }, fieldDefs);

  // ─── KPI completeness check ───

  const kpiFields = {
    revenue: readField('FF Weekly Revenue'),
    leads: readField('FF Weekly Leads'),
    newMembers: readField('FF Weekly New Members'),
    cancellations: readField('FF Weekly Cancellations'),
    activeMemberCount: readField('FF Active Member Count'),
  };

  // ─── Calculate Score ───

  const lastWeekScore = parseFloat(readField('FF Health Score This Week') || 0);

  const scoreData = {
    formSubmittedTimestamp: formSubmitted ? new Date().toISOString() : null,
    scoringWindowEnd: week.end.toISOString(),
    appointmentDisposition,
    lastOutboundTimestamp,
    lastInboundTimestamp,
    outreachSentThisWeek,
    operationalControlRating: parseFloat(operationalControlRating || 0),
    kpiFields,
    directiveStatus,
    hoursReclaimedThisWeek: parseFloat(hoursReclaimedThisWeek || 0),
    weeklyRevenue,
    revenue4WeekAvg: averages.revenue4WeekAvg || parseFloat(readField('FF Revenue 4-Week Avg') || 0),
    weeklyLeads: totalWeeklyLeads,
    leadVolume4WeekAvg: averages.leadVolume4WeekAvg || parseFloat(readField('FF Lead Volume 4-Week Avg') || 0),
    conversionRateThisWeek: conversionRate * 100,
    conversionRate4WeekAvg: averages.conversionRate4WeekAvg || parseFloat(readField('FF Conversion Rate 4-Week Avg') || 0),
    blendedCPLThisWeek: blendedCPL,
    blendedCPL4WeekAvg: averages.blendedCPL4WeekAvg || parseFloat(readField('FF Blended CPL 4-Week Avg') || 0),
    lastWeekScore,
    consecutiveMissedForms,
    consecutiveMissedCalls,
  };

  let { total, breakdown, dangerTriggers } = calculateScore(scoreData);

  // ─── Override Logic ───

  const overrideNote = readField('FF Score Override Note');
  if (overrideNote && overrideNote.trim() !== '') {
    const overrideMatch = overrideNote.match(/(-?\d+)/);
    if (overrideMatch) {
      const adjustment = parseInt(overrideMatch[1]);
      if (adjustment < 0) {
        total = Math.max(0, total + adjustment);
        await ghl.addContactNote(loc, contactId,
          `Score override applied: ${adjustment} points. Note: ${overrideNote}. Final score: ${total}`);
      }
    }
    // Clear override after applying
    await ghl.writeFieldsToContact(loc, contactId, {
      'FF Score Override Note': '',
    }, fieldDefs);
  }

  total = Math.min(100, Math.max(0, total));
  const status = getScoreStatus(total);

  console.log(`  Score: ${total}/100 (${status.label} - ${status.description})`);
  console.log(`  Breakdown:`, JSON.stringify(breakdown));

  // ─── Write Score to Client Sub-Account ───

  await ghl.writeFieldsToContact(loc, contactId, {
    'FF Health Score Last Week': lastWeekScore,
    'FF Health Score This Week': total,
    'FF Score Status': `${status.label} / ${status.description}`,
  }, fieldDefs);

  // ─── Danger Zone Logic ───

  const dangerActive = dangerTriggers.length > 0;
  const wasDangerActive = readField('FF Danger Zone Active') === 'true';

  if (dangerActive && !wasDangerActive) {
    console.log(`  DANGER ZONE ACTIVATED: ${dangerTriggers.join(', ')}`);

    // Tag client
    await ghl.addContactTag(loc, contactId, ['FF-Danger']);

    // Set danger flag
    await ghl.writeFieldsToContact(loc, contactId, {
      'FF Danger Zone Active': 'true',
    }, fieldDefs);

    // Log note
    await ghl.addContactNote(loc, contactId,
      `Danger Zone activated - ${new Date().toISOString().split('T')[0]} - triggered by ${dangerTriggers.join('; ')}`);

    // Create task in Coaching Dept
    try {
      await ghl.createTask(COACHING_DEPT_ID, mirrorId, {
        title: `DANGER ZONE - ${client.name} - Score: ${total} - Reach out within 24 hours`,
        dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        completed: false,
      });
    } catch (err) {
      console.log(`  Warning: Could not create danger task - ${err.message}`);
    }

    // Trigger re-engagement workflow
    if (REENGAGEMENT_WORKFLOW_ID) {
      try {
        await ghl.triggerWorkflow(loc, REENGAGEMENT_WORKFLOW_ID, contactId);
        console.log('  Re-engagement workflow triggered');
      } catch (err) {
        console.log(`  Warning: Could not trigger workflow - ${err.message}`);
      }
    }
  } else if (!dangerActive && wasDangerActive) {
    // Clear danger zone
    await ghl.removeContactTag(loc, contactId, ['FF-Danger']);
    await ghl.writeFieldsToContact(loc, contactId, {
      'FF Danger Zone Active': 'false',
    }, fieldDefs);
    await ghl.addContactNote(loc, contactId,
      `Danger Zone cleared - ${new Date().toISOString().split('T')[0]} - Score: ${total}`);
  }

  // ─── Mirror Record Update (Coaching Dept) ───

  if (mirrorId) {
    const cdFieldDefs = await ghl.getCustomFields(COACHING_DEPT_ID);
    const cdFields = cdFieldDefs.customFields || [];

    const cycleNumber = readField('FF Current Cycle Number') || 1;
    const daysUntilMilestone = readField('FF Days Until Next Milestone') || '';
    const revenueTier = readField('FF Revenue Tier') || '';

    await ghl.writeFieldsToContact(COACHING_DEPT_ID, mirrorId, {
      'FF Health Score This Week': total,
      'FF Health Score Last Week': lastWeekScore,
      'FF Score Status': `${status.label} / ${status.description}`,
      'FF Danger Zone Active': dangerActive ? 'true' : 'false',
      'FF Current Cycle Number': cycleNumber,
      'FF Days Until Next Milestone': daysUntilMilestone,
      'FF Program': 'Freedom Formula',
      'FF Revenue Tier': revenueTier,
    }, cdFields);

    // Mirror danger tag
    if (dangerActive && !wasDangerActive) {
      await ghl.addContactTag(COACHING_DEPT_ID, mirrorId, ['FF-Danger']);
    } else if (!dangerActive && wasDangerActive) {
      await ghl.removeContactTag(COACHING_DEPT_ID, mirrorId, ['FF-Danger']);
    }

    console.log('  Mirror record updated');
  }

  return {
    name: client.name,
    email: clientEmail,
    score: total,
    lastWeekScore,
    status,
    dangerActive,
    breakdown,
    marketing: {
      googleLeads,
      googleSpend: Math.round(googleSpend * 100) / 100,
      metaLeads,
      metaSpend: Math.round(metaSpend * 100) / 100,
      totalLeads: totalWeeklyLeads,
      totalSpend: Math.round(totalWeeklySpend * 100) / 100,
      blendedCPL: Math.round(blendedCPL * 100) / 100,
      googleCPL: googleLeads > 0 ? Math.round((googleSpend / googleLeads) * 100) / 100 : 0,
      metaCPL: metaLeads > 0 ? Math.round((metaSpend / metaLeads) * 100) / 100 : 0,
      weeklyRevenue,
      weeklyNewMembers,
      weeklyCancellations,
      activeMemberCount,
      conversionRate: Math.round(conversionRate * 10000) / 100,
    },
  };
}

async function scoreBCClient(client) {
  const loc = client.ghl_location_id;
  const contactId = client.ff_contact_id;
  const mirrorId = client.coaching_dept_mirror_contact_id;
  const week = getWeekDates();

  console.log(`\nScoring (BC): ${client.name}`);
  console.log(`  Location: ${loc} | Contact: ${contactId}`);

  const fieldDefsResponse = await ghl.getCustomFields(loc);
  const fieldDefs = fieldDefsResponse.customFields || [];

  const contactResponse = await ghl.getContact(loc, contactId);
  const bcContact = contactResponse.contact || contactResponse;
  const clientEmail = bcContact.email || '';
  const readField = (name) => getCustomFieldValue(contactResponse, name, fieldDefs);

  // ─── Pull Engagement Data ───

  // Form submission check
  const formSubmitted = readField('BC Strategic Initiative Status') || readField('FF Operational Control Rating');
  const formSubmittedTimestamp = formSubmitted ? new Date().toISOString() : null;

  // Coaching call disposition
  let appointmentDisposition = null;
  try {
    const calData = await ghl.getCalendars(loc);
    const calendars = calData.calendars || [];
    for (const cal of calendars) {
      try {
        const appointments = await ghl.getAppointments(loc, {
          calendarId: cal.id,
          startTime: week.start.toISOString(),
          endTime: week.end.toISOString(),
        });
        if (appointments.events && appointments.events.length > 0) {
          for (const appt of appointments.events) {
            if (appt.contactId === contactId || appt.contact_id === contactId) {
              appointmentDisposition = appt.appointmentStatus || appt.status || null;
            }
          }
        }
      } catch (calErr) { /* skip */ }
    }
  } catch (err) {
    console.log(`  Warning: Could not fetch appointments - ${err.message}`);
  }

  // Peer contribution (Q11 from form — "Who did you help this week?")
  const peerContributionResponse = readField('BC Peer Contribution') || '';

  // ─── Pull Leadership Data ───

  const initiativeStatus = readField('BC Strategic Initiative Status');
  const teamDevelopmentRating = readField('BC Team Development Rating');
  const ceoHoursThisWeek = readField('BC CEO Hours This Week');

  // ─── Pull Financial Data ───

  const weeklyRevenue = parseFloat(readField('FF Weekly Revenue') || 0);
  const revenueTarget = parseFloat(readField('BC Weekly Revenue Target') || 0);
  const profitMarginThisWeek = parseFloat(readField('BC Profit Margin This Week') || 0);
  const memberRetentionRate = parseFloat(readField('BC Member Retention Rate') || 0);

  // Google Ads data
  let googleLeads = 0;
  let googleSpend = 0;
  if (client.google_ads_customer_id && client.google_ads_customer_id !== 'USMAN_FILLS_THIS') {
    const gResult = await googleAds.getWeeklyLeadsAndSpend(
      client.google_ads_customer_id, week.startStr, week.endStr
    );
    if (gResult) {
      googleLeads = gResult.leads;
      googleSpend = gResult.spend;
    }
  }

  // Meta Ads data
  let metaLeads = 0;
  let metaSpend = 0;
  if (client.meta_ad_account_id && client.meta_ad_account_id !== 'USMAN_FILLS_THIS') {
    const mResult = await metaAds.getWeeklyLeadsAndSpend(
      client.meta_ad_account_id, week.startStr, week.endStr
    );
    if (mResult) {
      metaLeads = mResult.leads;
      metaSpend = mResult.spend;
    }
  }

  const totalWeeklyLeads = googleLeads + metaLeads;
  const weeklyNewMembers = parseFloat(readField('FF Weekly New Members') || 0);
  const conversionRate = totalWeeklyLeads > 0 ? (weeklyNewMembers / totalWeeklyLeads) * 100 : 0;

  // Write weekly metrics
  await ghl.writeFieldsToContact(loc, contactId, {
    'FF Weekly Leads': totalWeeklyLeads,
  }, fieldDefs);

  // ─── Update Rolling Averages ───

  const blendedCPL = totalWeeklyLeads > 0 ? (googleSpend + metaSpend) / totalWeeklyLeads : 0;
  const averages = await updateAllRollingAverages(loc, contactId, {
    revenue: weeklyRevenue,
    leads: totalWeeklyLeads,
    conversionRate: conversionRate,
    blendedCPL: blendedCPL,
  }, fieldDefs);

  // BC-specific: profit margin rolling average
  const priorProfitAvg = parseFloat(readField('BC Profit Margin 4-Week Avg') || 0);
  const newProfitAvg = priorProfitAvg === 0 ? profitMarginThisWeek :
    Math.round(((priorProfitAvg * 3 + profitMarginThisWeek) / 4) * 100) / 100;
  await ghl.writeFieldsToContact(loc, contactId, {
    'BC Profit Margin 4-Week Avg': newProfitAvg,
  }, fieldDefs);

  // ─── Consecutive Misses ───

  let consecutiveMissedForms = parseInt(readField('FF Consecutive Missed Forms') || 0);
  let consecutiveMissedCalls = parseInt(readField('FF Consecutive Missed Calls') || 0);

  if (!formSubmitted) {
    consecutiveMissedForms++;
  } else {
    consecutiveMissedForms = 0;
  }

  if (!appointmentDisposition || appointmentDisposition === 'no_show' || appointmentDisposition === 'cancelled') {
    consecutiveMissedCalls++;
  } else if (appointmentDisposition === 'attended' || appointmentDisposition === 'completed' || appointmentDisposition === 'showed') {
    consecutiveMissedCalls = 0;
  }

  await ghl.writeFieldsToContact(loc, contactId, {
    'FF Consecutive Missed Forms': consecutiveMissedForms,
    'FF Consecutive Missed Calls': consecutiveMissedCalls,
  }, fieldDefs);

  // Track weeks under revenue target
  let weeksUnderRevenueTarget = parseInt(readField('BC Weeks Under Revenue Target') || 0);
  if (revenueTarget > 0 && weeklyRevenue < revenueTarget) {
    weeksUnderRevenueTarget++;
  } else {
    weeksUnderRevenueTarget = 0;
  }
  await ghl.writeFieldsToContact(loc, contactId, {
    'BC Weeks Under Revenue Target': weeksUnderRevenueTarget,
  }, fieldDefs);

  // ─── Calculate Score ───

  const lastWeekScore = parseFloat(readField('FF Health Score This Week') || 0);

  const scoreData = {
    formSubmittedTimestamp,
    scoringWindowEnd: week.end.toISOString(),
    appointmentDisposition,
    peerContributionResponse,
    initiativeStatus,
    teamDevelopmentRating: parseFloat(teamDevelopmentRating || 0),
    ceoHoursThisWeek: parseFloat(ceoHoursThisWeek || 0),
    weeklyRevenue,
    revenueTarget,
    profitMarginThisWeek,
    profitMargin4WeekAvg: newProfitAvg,
    weeklyLeads: totalWeeklyLeads,
    leadVolume4WeekAvg: averages.leadVolume4WeekAvg || parseFloat(readField('FF Lead Volume 4-Week Avg') || 0),
    conversionRateThisWeek: conversionRate,
    conversionRate4WeekAvg: averages.conversionRate4WeekAvg || parseFloat(readField('FF Conversion Rate 4-Week Avg') || 0),
    memberRetentionRate,
    lastWeekScore,
    consecutiveMissedForms,
    consecutiveMissedCalls,
    weeksUnderRevenueTarget,
  };

  let { total, breakdown, dangerTriggers } = calculateBCScore(scoreData);

  // ─── Override Logic ───

  const overrideNote = readField('FF Score Override Note');
  if (overrideNote && overrideNote.trim() !== '') {
    const overrideMatch = overrideNote.match(/(-?\d+)/);
    if (overrideMatch) {
      const adjustment = parseInt(overrideMatch[1]);
      if (adjustment < 0) {
        total = Math.max(0, total + adjustment);
        await ghl.addContactNote(loc, contactId,
          `BC Score override applied: ${adjustment} points. Note: ${overrideNote}. Final score: ${total}`);
      }
    }
    await ghl.writeFieldsToContact(loc, contactId, {
      'FF Score Override Note': '',
    }, fieldDefs);
  }

  total = Math.min(100, Math.max(0, total));
  const status = getBCScoreStatus(total);

  console.log(`  Score: ${total}/100 (${status.label} - ${status.description})`);
  console.log(`  Breakdown:`, JSON.stringify(breakdown));

  // ─── Write Score to Client Sub-Account ───

  await ghl.writeFieldsToContact(loc, contactId, {
    'FF Health Score Last Week': lastWeekScore,
    'FF Health Score This Week': total,
    'FF Score Status': `${status.label} / ${status.description}`,
  }, fieldDefs);

  // ─── Danger Zone Logic ───

  const dangerActive = dangerTriggers.length > 0;
  const wasDangerActive = readField('FF Danger Zone Active') === 'true';

  if (dangerActive && !wasDangerActive) {
    console.log(`  DANGER ZONE ACTIVATED: ${dangerTriggers.join(', ')}`);
    await ghl.addContactTag(loc, contactId, ['BC-Danger']);
    await ghl.writeFieldsToContact(loc, contactId, {
      'FF Danger Zone Active': 'true',
    }, fieldDefs);
    await ghl.addContactNote(loc, contactId,
      `Black Circle Danger Zone activated - ${new Date().toISOString().split('T')[0]} - triggered by ${dangerTriggers.join('; ')}`);

    try {
      await ghl.createTask(COACHING_DEPT_ID, mirrorId, {
        title: `BC DANGER ZONE - ${client.name} - Score: ${total} - Reach out within 24 hours`,
        dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        completed: false,
      });
    } catch (err) {
      console.log(`  Warning: Could not create danger task - ${err.message}`);
    }

    if (REENGAGEMENT_WORKFLOW_ID) {
      try {
        await ghl.triggerWorkflow(loc, REENGAGEMENT_WORKFLOW_ID, contactId);
        console.log('  Re-engagement workflow triggered');
      } catch (err) {
        console.log(`  Warning: Could not trigger workflow - ${err.message}`);
      }
    }
  } else if (!dangerActive && wasDangerActive) {
    await ghl.removeContactTag(loc, contactId, ['BC-Danger']);
    await ghl.writeFieldsToContact(loc, contactId, {
      'FF Danger Zone Active': 'false',
    }, fieldDefs);
    await ghl.addContactNote(loc, contactId,
      `Black Circle Danger Zone cleared - ${new Date().toISOString().split('T')[0]} - Score: ${total}`);
  }

  // ─── Mirror Record Update (Coaching Dept) ───

  if (mirrorId) {
    const cdFieldDefs = await ghl.getCustomFields(COACHING_DEPT_ID);
    const cdFields = cdFieldDefs.customFields || [];

    const cycleNumber = readField('FF Current Cycle Number') || 1;
    const daysUntilMilestone = readField('FF Days Until Next Milestone') || '';
    const revenueTier = readField('FF Revenue Tier') || '';

    await ghl.writeFieldsToContact(COACHING_DEPT_ID, mirrorId, {
      'FF Health Score This Week': total,
      'FF Health Score Last Week': lastWeekScore,
      'FF Score Status': `${status.label} / ${status.description}`,
      'FF Danger Zone Active': dangerActive ? 'true' : 'false',
      'FF Current Cycle Number': cycleNumber,
      'FF Days Until Next Milestone': daysUntilMilestone,
      'FF Program': 'Black Circle',
      'FF Revenue Tier': revenueTier,
    }, cdFields);

    if (dangerActive && !wasDangerActive) {
      await ghl.addContactTag(COACHING_DEPT_ID, mirrorId, ['BC-Danger']);
    } else if (!dangerActive && wasDangerActive) {
      await ghl.removeContactTag(COACHING_DEPT_ID, mirrorId, ['BC-Danger']);
    }

    console.log('  Mirror record updated');
  }

  const bcWeeklyCancellations = parseFloat(readField('FF Weekly Cancellations') || 0);
  const bcActiveMemberCount = parseFloat(readField('FF Active Member Count') || 0);
  const totalWeeklySpend = googleSpend + metaSpend;

  return {
    name: client.name,
    email: clientEmail,
    program: 'Black Circle',
    score: total,
    lastWeekScore,
    status,
    dangerActive,
    breakdown,
    marketing: {
      googleLeads,
      googleSpend: Math.round(googleSpend * 100) / 100,
      metaLeads,
      metaSpend: Math.round(metaSpend * 100) / 100,
      totalLeads: totalWeeklyLeads,
      totalSpend: Math.round(totalWeeklySpend * 100) / 100,
      blendedCPL: Math.round(blendedCPL * 100) / 100,
      googleCPL: googleLeads > 0 ? Math.round((googleSpend / googleLeads) * 100) / 100 : 0,
      metaCPL: metaLeads > 0 ? Math.round((metaSpend / metaLeads) * 100) / 100 : 0,
      weeklyRevenue,
      weeklyNewMembers,
      weeklyCancellations: bcWeeklyCancellations,
      activeMemberCount: bcActiveMemberCount,
      conversionRate: Math.round(conversionRate * 100) / 100,
    },
  };
}

async function run() {
  // Prevent double-execution
  if (!runLock.acquire('scoring')) {
    log.warn('Scoring', 'Scoring engine already running. Skipping this execution.');
    return;
  }

  try {
    return await _runScoring();
  } finally {
    runLock.release('scoring');
  }
}

async function _runScoring() {
  log.info('Scoring', '=== Freedom Formula Scoring Engine ===');
  log.info('Scoring', `Run time: ${new Date().toISOString()}`);

  // Auto-onboard any new clients (creates mirror contacts, pipeline, tags)
  await onboardNewClients();

  const { ffClients, bcClients } = loadRegistry();
  log.info('Scoring', `Processing ${ffClients.length} FF + ${bcClients.length} BC clients`);

  if (ffClients.length === 0 && bcClients.length === 0) {
    log.info('Scoring', 'No clients in registry. Exiting.');
    return;
  }

  // Auto-provision fields on any sub-accounts missing them
  const allClients = [...ffClients, ...bcClients];
  const provisionedLocations = new Set();
  for (const client of allClients) {
    const loc = client.ghl_location_id;
    if (provisionedLocations.has(loc)) continue;
    provisionedLocations.add(loc);
    await provisionFields(loc, client.program);
  }
  // Also provision the Coaching Dept mirror account
  if (!provisionedLocations.has(COACHING_DEPT_ID)) {
    await provisionFields(COACHING_DEPT_ID, 'Black Circle');
  }

  const results = [];

  // Score Freedom Formula clients
  for (const client of ffClients) {
    try {
      const result = await scoreClient(client);
      result.program = 'Freedom Formula';
      results.push(result);
    } catch (err) {
      console.error(`\nFAILED: ${client.name} - ${err.message}`);
      results.push({
        name: client.name,
        program: 'Freedom Formula',
        score: null,
        error: err.message,
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Score Black Circle clients
  for (const client of bcClients) {
    try {
      const result = await scoreBCClient(client);
      results.push(result);
    } catch (err) {
      console.error(`\nFAILED (BC): ${client.name} - ${err.message}`);
      results.push({
        name: client.name,
        program: 'Black Circle',
        score: null,
        error: err.message,
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Summary
  const succeeded = results.filter((r) => r.score !== null).length;
  const failed = results.filter((r) => r.score === null).length;
  log.info('Scoring', `=== Scoring Complete === Processed: ${results.length}, Succeeded: ${succeeded}, Failed: ${failed}`);

  for (const r of results) {
    const tag = r.program === 'Black Circle' ? '[BC]' : '[FF]';
    if (r.score !== null) {
      log.info('Scoring', `  ${tag} ${r.name}: ${r.score}/100 (${r.status.label})`);
    } else {
      log.error('Scoring', `  ${tag} ${r.name}: FAILED - ${r.error}`);
    }
  }

  // Alert if too many failures
  if (failed > 0 && failed >= succeeded) {
    log.fatal('Scoring', `Majority of clients failed scoring (${failed}/${results.length}). Possible API outage.`);
  }

  // Save results with breakdowns for Monday delivery to read
  const resultsPath = path.resolve(__dirname, '../setup/last-score-results.json');
  const resultsData = {};
  for (const r of results) {
    if (r.score !== null) {
      resultsData[r.name] = {
        score: r.score,
        lastWeekScore: r.lastWeekScore,
        status: r.status,
        dangerActive: r.dangerActive,
        breakdown: r.breakdown,
        marketing: r.marketing || {},
      };
    }
  }
  fs.writeFileSync(resultsPath, JSON.stringify(resultsData, null, 2));
  log.info('Scoring', `Results saved to ${resultsPath}`);

  // ─── Push Scores + Metrics to Base44 ───
  const weekLabel = new Date().toISOString().split('T')[0];
  for (const r of results) {
    if (r.score === null || !r.email) continue;
    try {
      await base44.pushClientScore(r.email, weekLabel, {
        client_name: r.name,
        program: r.program || 'Freedom Formula',
        score: r.score,
        last_week_score: r.lastWeekScore || 0,
        status_label: r.status?.label || '',
        status_description: r.status?.description || '',
        status_color: r.status?.color || '',
        danger_active: r.dangerActive || false,
        breakdown: r.breakdown || {},
      });
      await base44.pushClientMetric(r.email, weekLabel, {
        client_name: r.name,
        program: r.program || 'Freedom Formula',
        weekly_revenue: r.marketing?.weeklyRevenue || 0,
        weekly_leads: r.marketing?.totalLeads || 0,
        weekly_new_members: r.marketing?.weeklyNewMembers || 0,
        weekly_cancellations: r.marketing?.weeklyCancellations || 0,
        active_members: r.marketing?.activeMemberCount || 0,
        google_leads: r.marketing?.googleLeads || 0,
        google_spend: r.marketing?.googleSpend || 0,
        meta_leads: r.marketing?.metaLeads || 0,
        meta_spend: r.marketing?.metaSpend || 0,
        total_spend: r.marketing?.totalSpend || 0,
        blended_cpl: r.marketing?.blendedCPL || 0,
        conversion_rate: r.marketing?.conversionRate || 0,
      });
    } catch (b44Err) {
      log.warn('Scoring', `Base44 push failed for ${r.name}: ${b44Err.message}`);
    }
  }
  log.info('Scoring', 'Base44 score/metric push complete');

  // Write scoring-complete flag so Monday delivery knows scoring finished
  const completeFlagPath = path.resolve(__dirname, '../setup/scoring-complete.json');
  fs.writeFileSync(completeFlagPath, JSON.stringify({
    completedAt: new Date().toISOString(),
    clientsScored: succeeded,
    clientsFailed: failed,
  }, null, 2));

  // Append to score history for dashboard charts
  const historyPath = path.resolve(__dirname, '../setup/score-history.json');
  try {
    const weekLabel = new Date().toISOString().split('T')[0];
    let history = [];
    if (fs.existsSync(historyPath)) {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    }
    // Idempotent: replace if same week already exists
    const existingIdx = history.findIndex(h => h.week === weekLabel);
    const snapshot = { week: weekLabel, scores: resultsData };
    if (existingIdx >= 0) {
      history[existingIdx] = snapshot;
    } else {
      history.push(snapshot);
    }
    // Keep last 52 weeks
    if (history.length > 52) history = history.slice(-52);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    log.info('Scoring', `Score history updated (${history.length} weeks)`);
  } catch (histErr) {
    log.error('Scoring', `Could not update score history: ${histErr.message}`);
  }

  return results;
}

// Allow direct execution or import
if (require.main === module) {
  run().catch((err) => {
    console.error('Scoring engine failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
