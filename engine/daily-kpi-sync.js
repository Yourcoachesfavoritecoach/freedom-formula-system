/**
 * Daily KPI Sync
 * Runs every day at 6:30am via cron.
 * Pulls yesterday's data from each client's GHL sub-account + ad platforms,
 * pushes to Base44 GymDailyEntry entity.
 *
 * Data sources:
 * - Meta Ads API → meta_leads_today, ad_spend (Meta portion)
 * - Google Ads API → google_leads_today, ad_spend (Google portion)
 * - GHL Calendar → appointments_scheduled_today, appointments_showed_today
 * - GHL Pipeline → closed_today, cash_collected_today, new_starts_today, cancellations_today
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const googleAds = require('../utils/google-ads-api');
const metaAds = require('../utils/meta-ads-api');
const base44 = require('../utils/base44-api');
const log = require('../utils/logger');

/**
 * Get yesterday's date range (full day).
 */
function getYesterdayRange() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const startOfDay = new Date(yesterday);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(yesterday);
  endOfDay.setHours(23, 59, 59, 999);

  return {
    start: startOfDay,
    end: endOfDay,
    dateStr: yesterday.toISOString().split('T')[0], // YYYY-MM-DD
  };
}

/**
 * Load client registry and register API keys.
 */
function loadRegistry() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);

  for (const client of registry.clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }

  return registry.clients.filter((c) => c.ghl_location_id !== 'USMAN_FILLS_THIS');
}

/**
 * Pull yesterday's ad data from Meta + Google.
 */
async function pullAdData(client, dateStr) {
  let metaLeads = 0, metaSpend = 0;
  let googleLeads = 0, googleSpend = 0;

  // Meta Ads
  if (client.meta_ad_account_id && client.meta_ad_account_id !== 'USMAN_FILLS_THIS') {
    try {
      const result = await metaAds.getWeeklyLeadsAndSpend(
        client.meta_ad_account_id, dateStr, dateStr
      );
      if (result) {
        metaLeads = result.leads;
        metaSpend = result.spend;
      }
    } catch (err) {
      log.warn('DailyKPI', `Meta Ads pull failed for ${client.name}: ${err.message}`);
    }
  }

  // Google Ads
  if (client.google_ads_customer_id && client.google_ads_customer_id !== 'USMAN_FILLS_THIS') {
    try {
      const result = await googleAds.getWeeklyLeadsAndSpend(
        client.google_ads_customer_id, dateStr, dateStr
      );
      if (result) {
        googleLeads = result.leads;
        googleSpend = result.spend;
      }
    } catch (err) {
      log.warn('DailyKPI', `Google Ads pull failed for ${client.name}: ${err.message}`);
    }
  }

  return {
    metaLeads,
    metaSpend,
    googleLeads,
    googleSpend,
    totalAdSpend: metaSpend + googleSpend,
  };
}

/**
 * Pull yesterday's appointment data from GHL calendars.
 */
async function pullAppointmentData(client, yesterday) {
  const loc = client.ghl_location_id;
  let scheduled = 0;
  let showed = 0;

  try {
    const calData = await ghl.getCalendars(loc);
    const calendars = calData.calendars || [];

    for (const cal of calendars) {
      try {
        const result = await ghl.getAppointments(loc, {
          calendarId: cal.id,
          startTime: yesterday.start.toISOString(),
          endTime: yesterday.end.toISOString(),
        });

        if (result.events && result.events.length > 0) {
          for (const appt of result.events) {
            scheduled++;
            const status = (appt.appointmentStatus || appt.status || '').toLowerCase();
            if (status === 'showed' || status === 'completed' || status === 'attended') {
              showed++;
            }
          }
        }
      } catch (calErr) {
        // Skip calendars that fail
      }
    }
  } catch (err) {
    log.warn('DailyKPI', `Appointment pull failed for ${client.name}: ${err.message}`);
  }

  return { scheduled, showed };
}

/**
 * Pull yesterday's pipeline data from GHL opportunities.
 * Maps pipeline stages to: closed, cash collected, new starts, cancellations.
 *
 * Stage mapping is configurable per client via client-registry.json.
 * Default stage names if not configured:
 *   closed stages: "won", "closed", "closed won", "paid"
 *   new start stages: "new start", "started", "active"
 *   cancellation stages: "cancelled", "canceled", "lost", "churned"
 */
async function pullPipelineData(client, yesterday) {
  const loc = client.ghl_location_id;
  let closed = 0;
  let cashCollected = 0;
  let newStarts = 0;
  let cancellations = 0;

  // Configurable stage mappings (from registry or defaults)
  const stageMap = client.pipeline_stage_map || {};

  // Prefer stage ID matching (reliable), fall back to name matching
  const closedStageIds = stageMap.closed_stage_ids || [];
  const newStartStageIds = stageMap.new_start_stage_ids || [];
  const cancelStageIds = stageMap.cancellation_stage_ids || [];

  const closedStageNames = (stageMap.closed || ['won', 'closed', 'closed won', 'paid']).map(s => s.toLowerCase());
  const newStartStageNames = (stageMap.new_start || ['new start', 'started', 'active']).map(s => s.toLowerCase());
  const cancelStageNames = (stageMap.cancellation || ['cancelled', 'canceled', 'lost', 'churned']).map(s => s.toLowerCase());

  try {
    // GHL search endpoint doesn't support date filtering directly.
    // Query by pipeline ID and filter by updatedAt client-side.
    const pipelineIds = [
      stageMap.lead_pipeline_id,
      stageMap.client_journey_pipeline_id,
    ].filter(Boolean);

    let opportunities = [];
    for (const pipelineId of pipelineIds) {
      const result = await ghl.searchOpportunities(loc, {
        pipeline_id: pipelineId,
      });
      opportunities = opportunities.concat(result.opportunities || []);
    }

    // If no pipelines configured, try without filter
    if (pipelineIds.length === 0) {
      const result = await ghl.searchOpportunities(loc, {});
      opportunities = result.opportunities || [];
    }

    for (const opp of opportunities) {
      const stageId = opp.pipelineStageId || '';
      const stageName = (opp.stage_name || opp.status || '').toLowerCase();
      const monetaryValue = parseFloat(opp.monetaryValue || opp.monetary_value || 0);

      // Check last status change date
      const updatedAt = new Date(opp.updatedAt || opp.dateUpdated || opp.lastStatusChangeAt || 0);
      const isFromYesterday = updatedAt >= yesterday.start && updatedAt <= yesterday.end;

      if (!isFromYesterday) continue;

      // Match by stage ID first, then fall back to name matching
      const isClosed = closedStageIds.includes(stageId) ||
        closedStageNames.some(s => stageName.includes(s));
      const isNewStart = newStartStageIds.includes(stageId) ||
        newStartStageNames.some(s => stageName.includes(s));
      const isCancellation = cancelStageIds.includes(stageId) ||
        cancelStageNames.some(s => stageName.includes(s));

      if (isClosed) {
        closed++;
        cashCollected += monetaryValue;
      }
      if (isNewStart) {
        newStarts++;
      }
      if (isCancellation) {
        cancellations++;
      }
    }
  } catch (err) {
    log.warn('DailyKPI', `Pipeline pull failed for ${client.name}: ${err.message}`);
  }

  return { closed, cashCollected, newStarts, cancellations };
}

/**
 * Get client email from GHL contact.
 */
async function getClientEmail(client) {
  try {
    const contactResponse = await ghl.getContact(client.ghl_location_id, client.ff_contact_id);
    const contact = contactResponse.contact || contactResponse;
    return contact.email || '';
  } catch (err) {
    log.warn('DailyKPI', `Could not fetch contact for ${client.name}: ${err.message}`);
    return '';
  }
}

/**
 * Sync one client's daily KPIs.
 */
async function syncClient(client) {
  const yesterday = getYesterdayRange();

  log.info('DailyKPI', `Syncing ${client.name} for ${yesterday.dateStr}`);

  // Get client email for Base44 lookup
  const clientEmail = await getClientEmail(client);
  if (!clientEmail) {
    log.warn('DailyKPI', `No email found for ${client.name}, skipping`);
    return;
  }

  // Pull all data sources in parallel
  const [adData, apptData, pipelineData] = await Promise.all([
    pullAdData(client, yesterday.dateStr),
    pullAppointmentData(client, yesterday),
    pullPipelineData(client, yesterday),
  ]);

  // Build daily entry
  const dailyEntry = {
    meta_leads_today: adData.metaLeads,
    google_leads_today: adData.googleLeads,
    leads_today: adData.metaLeads + adData.googleLeads,
    ad_spend_today: adData.totalAdSpend,
    appointments_scheduled_today: apptData.scheduled,
    appointments_showed_today: apptData.showed,
    closed_today: pipelineData.closed,
    cash_collected_today: pipelineData.cashCollected,
    new_starts_today: pipelineData.newStarts,
    cancellations_today: pipelineData.cancellations,
  };

  log.info('DailyKPI', `  ${client.name}: ${JSON.stringify(dailyEntry)}`);

  // Upsert to Base44 GymDailyEntry
  try {
    const result = await base44.upsertEntity(
      'GymDailyEntry',
      { client_email: clientEmail, entry_date: yesterday.dateStr },
      dailyEntry
    );
    log.info('DailyKPI', `  Pushed to Base44 (${result.created ? 'created' : 'updated'})`);
  } catch (err) {
    log.error('DailyKPI', `  Base44 push failed for ${client.name}: ${err.message}`);
  }
}

/**
 * Run daily KPI sync for all clients.
 */
async function run() {
  log.info('DailyKPI', '=== Daily KPI Sync Started ===');

  const clients = loadRegistry();
  log.info('DailyKPI', `Found ${clients.length} clients`);

  let succeeded = 0;
  let failed = 0;

  for (const client of clients) {
    try {
      await syncClient(client);
      succeeded++;
    } catch (err) {
      log.error('DailyKPI', `Failed to sync ${client.name}: ${err.message}`);
      failed++;
    }
  }

  log.info('DailyKPI', `=== Daily KPI Sync Complete: ${succeeded} succeeded, ${failed} failed ===`);
}

module.exports = { run };
