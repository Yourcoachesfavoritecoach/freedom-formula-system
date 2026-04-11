/**
 * Dashboard API Routes
 * Serves client scores, history, and live data for the Coaching Dept. App.
 *
 * All endpoints require: Authorization: Bearer <DASHBOARD_TOKEN>
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const ghl = require('../utils/ghl-api');
const googleAds = require('../utils/google-ads-api');
const metaAds = require('../utils/meta-ads-api');
const { getCustomFieldValue } = require('../utils/rolling-averages');

const router = express.Router();
const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;

// Auth middleware
function requireDashboardToken(req, res, next) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not configured.' });

  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (bearerToken !== token) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

router.use(requireDashboardToken);

// Helper: load full registry (internal use only, includes location IDs for API calls)
function getFullClientList() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  return registry.clients.filter(c => c.ghl_location_id !== 'USMAN_FILLS_THIS');
}

// Helper: load registry without API keys
function getSafeClientList() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  return registry.clients
    .filter(c => c.ghl_location_id !== 'USMAN_FILLS_THIS')
    .map(c => ({
      name: c.name,
      program: c.program,
      ghl_location_id: c.ghl_location_id,
      ff_contact_id: c.ff_contact_id,
      coaching_dept_mirror_contact_id: c.coaching_dept_mirror_contact_id,
      google_ads_customer_id: c.google_ads_customer_id || '',
      meta_ad_account_id: c.meta_ad_account_id || '',
    }));
}

/**
 * GET /api/dashboard/clients
 * Returns client list (no API keys).
 */
router.get('/clients', (req, res) => {
  try {
    const clients = getSafeClientList();
    res.json({ clients });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load client list.' });
  }
});

/**
 * GET /api/dashboard/scores
 * Returns last scoring run results from JSON file.
 */
router.get('/scores', (req, res) => {
  try {
    const resultsPath = path.resolve(__dirname, '../setup/last-score-results.json');
    if (!fs.existsSync(resultsPath)) {
      return res.json({ scores: {}, lastRun: null });
    }
    delete require.cache[require.resolve(resultsPath)];
    const scores = require(resultsPath);

    const stat = fs.statSync(resultsPath);
    res.json({ scores, lastRun: stat.mtime.toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load scores.' });
  }
});

/**
 * GET /api/dashboard/scores/live
 * Pulls current score values from GHL mirror contacts in real-time.
 */
router.get('/scores/live', async (req, res) => {
  try {
    const clients = getSafeClientList();
    const cdFieldDefsResponse = await ghl.getCustomFields(COACHING_DEPT_ID);
    const cdFields = cdFieldDefsResponse.customFields || [];

    const liveScores = {};

    for (const client of clients) {
      const mirrorId = client.coaching_dept_mirror_contact_id;
      if (!mirrorId) continue;

      try {
        const contactResponse = await ghl.getContact(COACHING_DEPT_ID, mirrorId);
        const readField = (name) => getCustomFieldValue(contactResponse, name, cdFields);

        const score = parseFloat(readField('FF Health Score This Week') || 0);
        const lastWeekScore = parseFloat(readField('FF Health Score Last Week') || 0);
        const scoreStatus = readField('FF Score Status') || '';
        const dangerActive = readField('FF Danger Zone Active') === 'true';
        const cycleNumber = readField('FF Current Cycle Number') || '';
        const daysUntilMilestone = readField('FF Days Until Next Milestone') || '';
        const program = readField('FF Program') || client.program;

        liveScores[client.name] = {
          score,
          lastWeekScore,
          scoreStatus,
          dangerActive,
          cycleNumber,
          daysUntilMilestone,
          program,
        };
      } catch (contactErr) {
        liveScores[client.name] = { error: contactErr.message };
      }
    }

    res.json({ scores: liveScores, pulledAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pull live scores: ' + err.message });
  }
});

/**
 * GET /api/dashboard/history?weeks=12&client=Name
 * Returns weekly score history for charts.
 * - weeks: number of weeks to return (default 12, max 52)
 * - client: optional client name filter
 */
router.get('/history', (req, res) => {
  try {
    const historyPath = path.resolve(__dirname, '../setup/score-history.json');
    if (!fs.existsSync(historyPath)) {
      return res.json({ history: [], weeks: 0 });
    }

    let history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const weeksRequested = Math.min(parseInt(req.query.weeks) || 12, 52);
    const clientFilter = req.query.client || null;

    // Trim to requested weeks
    if (history.length > weeksRequested) {
      history = history.slice(-weeksRequested);
    }

    // Filter to specific client if requested
    if (clientFilter) {
      history = history.map(entry => ({
        week: entry.week,
        scores: entry.scores[clientFilter] ? { [clientFilter]: entry.scores[clientFilter] } : {},
      }));
    }

    res.json({ history, weeks: history.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load score history.' });
  }
});

/**
 * GET /api/dashboard/marketing/:clientName
 * Returns live marketing data for a client: ad performance, pipeline, appointments.
 * Pulls from Google Ads, Meta Ads, and GHL pipeline in real-time.
 */
router.get('/marketing/:clientName', async (req, res) => {
  try {
    const clientName = decodeURIComponent(req.params.clientName);
    const fullClients = getFullClientList();
    const client = fullClients.find(c => c.name === clientName);
    if (!client) {
      return res.status(404).json({ error: `Client "${clientName}" not found.` });
    }

    // Date range: last 7 days
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const startStr = weekAgo.toISOString().split('T')[0];
    const endStr = now.toISOString().split('T')[0];

    // Pull Google Ads data
    let google = { leads: 0, spend: 0, cpl: 0 };
    if (client.google_ads_customer_id && client.google_ads_customer_id !== 'USMAN_FILLS_THIS') {
      try {
        const gResult = await googleAds.getWeeklyLeadsAndSpend(
          client.google_ads_customer_id, startStr, endStr
        );
        if (gResult) {
          google = {
            leads: gResult.leads,
            spend: Math.round(gResult.spend * 100) / 100,
            cpl: gResult.leads > 0 ? Math.round((gResult.spend / gResult.leads) * 100) / 100 : 0,
          };
        }
      } catch (err) {
        google.error = err.message;
      }
    }

    // Pull Meta Ads data
    let meta = { leads: 0, spend: 0, cpl: 0 };
    if (client.meta_ad_account_id && client.meta_ad_account_id !== 'USMAN_FILLS_THIS') {
      try {
        const mResult = await metaAds.getWeeklyLeadsAndSpend(
          client.meta_ad_account_id, startStr, endStr
        );
        if (mResult) {
          meta = {
            leads: mResult.leads,
            spend: Math.round(mResult.spend * 100) / 100,
            cpl: mResult.leads > 0 ? Math.round((mResult.spend / mResult.leads) * 100) / 100 : 0,
          };
        }
      } catch (err) {
        meta.error = err.message;
      }
    }

    // Totals
    const totalLeads = google.leads + meta.leads;
    const totalSpend = Math.round((google.spend + meta.spend) * 100) / 100;
    const avgCPL = totalLeads > 0 ? Math.round((totalSpend / totalLeads) * 100) / 100 : 0;

    // Pull GHL pipeline/opportunity data
    let pipeline = { set: 0, showed: 0, closed: 0, totalRevenue: 0, avgDealAmount: 0 };
    try {
      const loc = client.ghl_location_id;
      // Get appointments from GHL
      const calendarsRes = await ghl.getCalendars(loc);
      const calendars = calendarsRes.calendars || [];

      let totalSet = 0;
      let totalShowed = 0;
      for (const cal of calendars) {
        try {
          const appts = await ghl.getAppointments(loc, {
            calendarId: cal.id,
            startTime: weekAgo.toISOString(),
            endTime: now.toISOString(),
          });
          const events = appts.events || [];
          totalSet += events.length;
          totalShowed += events.filter(e => e.status === 'showed' || e.appoinmentStatus === 'showed').length;
        } catch (calErr) {
          // Skip calendars that fail
        }
      }

      // Get opportunities (deals)
      const oppsRes = await ghl.searchOpportunities(loc, { limit: 100 });
      const opps = oppsRes.opportunities || [];

      // Filter to recent won deals
      const recentWon = opps.filter(o => {
        const isWon = o.status === 'won';
        const updatedAt = new Date(o.updatedAt || o.dateUpdated);
        return isWon && updatedAt >= weekAgo;
      });

      const totalRevenue = recentWon.reduce((sum, o) => sum + (parseFloat(o.monetaryValue) || 0), 0);
      const avgDealAmount = recentWon.length > 0 ? Math.round(totalRevenue / recentWon.length) : 0;

      pipeline = {
        set: totalSet,
        showed: totalShowed,
        closed: recentWon.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        avgDealAmount,
      };
    } catch (pipeErr) {
      pipeline.error = pipeErr.message;
    }

    // Cost per appointment
    const googleCostPerAppt = pipeline.set > 0 && google.spend > 0
      ? Math.round((google.spend / pipeline.set) * 100) / 100 : 0;
    const metaCostPerAppt = pipeline.set > 0 && meta.spend > 0
      ? Math.round((meta.spend / pipeline.set) * 100) / 100 : 0;

    // Read churn data from mirror contact
    let churn = { membersLost: 0, churnPercent: 0 };
    const mirrorId = client.coaching_dept_mirror_contact_id;
    if (mirrorId) {
      try {
        const cdFieldDefsResponse = await ghl.getCustomFields(COACHING_DEPT_ID);
        const cdFields = cdFieldDefsResponse.customFields || [];
        const contactResponse = await ghl.getContact(COACHING_DEPT_ID, mirrorId);
        const readField = (name) => getCustomFieldValue(contactResponse, name, cdFields);

        const cancellations = parseFloat(readField('FF Weekly Cancellations') || 0);
        const activeMembers = parseFloat(readField('FF Active Member Count') || 0);
        churn = {
          membersLost: cancellations,
          churnPercent: activeMembers > 0 ? Math.round((cancellations / activeMembers) * 10000) / 100 : 0,
        };
      } catch (churnErr) {
        churn.error = churnErr.message;
      }
    }

    res.json({
      clientName,
      period: { start: startStr, end: endStr },
      google,
      meta,
      totals: { leads: totalLeads, spend: totalSpend, avgCPL },
      pipeline,
      costPerAppointment: { google: googleCostPerAppt, meta: metaCostPerAppt },
      churn,
      pulledAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch marketing data: ' + err.message });
  }
});

/**
 * GET /api/dashboard/checkins/:clientName
 * Returns the most recent weekly check-in notes for a client.
 * Pulls notes from the Coaching Dept. mirror contact in GHL.
 * - limit: number of notes to return (default 5, max 20)
 */
router.get('/checkins/:clientName', async (req, res) => {
  try {
    const clientName = decodeURIComponent(req.params.clientName);
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);

    const clients = getSafeClientList();
    const client = clients.find(c => c.name === clientName);
    if (!client) {
      return res.status(404).json({ error: `Client "${clientName}" not found.` });
    }

    const mirrorId = client.coaching_dept_mirror_contact_id;
    if (!mirrorId) {
      return res.json({ checkins: [], message: 'No mirror contact configured.' });
    }

    const notesResponse = await ghl.getContactNotes(COACHING_DEPT_ID, mirrorId);
    const allNotes = notesResponse.notes || [];

    // Filter to weekly check-in notes (they contain "Weekly Reflection Submission" in the body)
    const checkinNotes = allNotes
      .filter(n => n.body && n.body.includes('Weekly Reflection Submission'))
      .slice(0, limit)
      .map(n => ({
        id: n.id,
        body: n.body,
        dateAdded: n.dateAdded,
      }));

    res.json({ checkins: checkinNotes, clientName, total: checkinNotes.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch check-ins: ' + err.message });
  }
});

module.exports = router;
