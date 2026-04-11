/**
 * Dashboard API Routes
 * Serves client scores, history, and live data for the Coaching Dept. App.
 *
 * All endpoints require: Authorization: Bearer <DASHBOARD_TOKEN>
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ghl = require('../utils/ghl-api');
const base44 = require('../utils/base44-api');
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

      // Filter to recent disqualified/lost deals
      const recentDisqualified = opps.filter(o => {
        const isLost = o.status === 'lost' || o.status === 'abandoned';
        const updatedAt = new Date(o.updatedAt || o.dateUpdated);
        return isLost && updatedAt >= weekAgo;
      });

      const totalRevenue = recentWon.reduce((sum, o) => sum + (parseFloat(o.monetaryValue) || 0), 0);
      const avgDealAmount = recentWon.length > 0 ? Math.round(totalRevenue / recentWon.length) : 0;

      pipeline = {
        set: totalSet,
        showed: totalShowed,
        closed: recentWon.length,
        disqualified: recentDisqualified.length,
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

    // CAC: Cost to Acquire a Customer = Total Spend / Closed Deals
    const cac = pipeline.closed > 0
      ? Math.round((totalSpend / pipeline.closed) * 100) / 100 : 0;

    res.json({
      clientName,
      period: { start: startStr, end: endStr },
      google,
      meta,
      totals: { leads: totalLeads, spend: totalSpend, avgCPL },
      pipeline,
      costPerAppointment: { google: googleCostPerAppt, meta: metaCostPerAppt },
      cac,
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

/**
 * GET /api/dashboard/digest
 * Returns a "What Changed" daily digest comparing today's data to yesterday's.
 * Shows score changes, new danger flags, metric shifts, and missed check-ins.
 */
router.get('/digest', (req, res) => {
  try {
    const snapshotPath = path.resolve(__dirname, '../setup/daily-snapshots.json');
    if (!fs.existsSync(snapshotPath)) {
      return res.json({ digest: null, message: 'No daily snapshots yet. Data will appear after the first nightly refresh.' });
    }

    const snapshots = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (snapshots.length < 2) {
      // Only one snapshot - show current state but no comparison
      const latest = snapshots[snapshots.length - 1];
      return res.json({
        digest: {
          date: latest.date,
          hasComparison: false,
          clients: Object.entries(latest.clients).map(([name, data]) => ({
            name,
            score: data.score,
            status: data.status,
            dangerActive: data.dangerActive,
          })),
        },
        message: 'First snapshot recorded. Comparison will be available after the next nightly refresh.',
      });
    }

    const today = snapshots[snapshots.length - 1];
    const yesterday = snapshots[snapshots.length - 2];

    const changes = [];

    // Compare each client
    for (const [name, todayData] of Object.entries(today.clients)) {
      const yesterdayData = yesterday.clients[name];
      const change = {
        name,
        currentScore: todayData.score,
        currentStatus: todayData.status,
        dangerActive: todayData.dangerActive,
        changes: [],
      };

      if (!yesterdayData) {
        change.changes.push({ type: 'new', message: 'New client added' });
      } else {
        // Score change
        const scoreDiff = todayData.score - yesterdayData.score;
        if (scoreDiff !== 0) {
          change.previousScore = yesterdayData.score;
          change.scoreDiff = scoreDiff;
          change.changes.push({
            type: scoreDiff > 0 ? 'improved' : 'declined',
            message: `Score ${scoreDiff > 0 ? 'up' : 'down'} ${Math.abs(scoreDiff)} points (${yesterdayData.score} → ${todayData.score})`,
          });
        }

        // Status change
        if (todayData.status !== yesterdayData.status) {
          change.previousStatus = yesterdayData.status;
          change.changes.push({
            type: 'status_change',
            message: `Status changed: ${yesterdayData.status} → ${todayData.status}`,
          });
        }

        // Entered danger zone
        if (todayData.dangerActive && !yesterdayData.dangerActive) {
          change.changes.push({
            type: 'danger_entered',
            message: 'Entered Danger Zone',
          });
        }

        // Exited danger zone
        if (!todayData.dangerActive && yesterdayData.dangerActive) {
          change.changes.push({
            type: 'danger_exited',
            message: 'Exited Danger Zone',
          });
        }

        // Check individual metric changes (breakdown)
        if (todayData.breakdown && yesterdayData.breakdown) {
          const metricNames = {
            formSubmission: 'Weekly Check-In',
            coachingCall: 'Coaching Call',
            outreachResponse: 'Response Time',
            orgChart: 'Org Chart',
            weeklyKPIs: 'KPI Completeness',
            revenue: 'Revenue',
            leadVolume: 'Lead Volume',
            conversionRate: 'Conversion Rate',
          };

          for (const [key, label] of Object.entries(metricNames)) {
            const todayVal = todayData.breakdown[key] || 0;
            const yesterdayVal = yesterdayData.breakdown[key] || 0;
            const diff = todayVal - yesterdayVal;
            if (Math.abs(diff) >= 2) {
              change.changes.push({
                type: diff > 0 ? 'metric_up' : 'metric_down',
                metric: label,
                message: `${label}: ${diff > 0 ? '+' : ''}${diff} points`,
              });
            }
          }
        }
      }

      // Only include clients that have changes or are in danger
      if (change.changes.length > 0 || change.dangerActive) {
        changes.push(change);
      }
    }

    // Check for clients that were removed
    for (const name of Object.keys(yesterday.clients)) {
      if (!today.clients[name]) {
        changes.push({
          name,
          changes: [{ type: 'removed', message: 'Client no longer in system' }],
        });
      }
    }

    // Sort: danger first, then by most changes, then by score diff
    changes.sort((a, b) => {
      if (a.dangerActive && !b.dangerActive) return -1;
      if (!a.dangerActive && b.dangerActive) return 1;
      return (b.changes?.length || 0) - (a.changes?.length || 0);
    });

    res.json({
      digest: {
        date: today.date,
        previousDate: yesterday.date,
        hasComparison: true,
        totalClients: Object.keys(today.clients).length,
        clientsWithChanges: changes.filter(c => c.changes.length > 0).length,
        dangerCount: Object.values(today.clients).filter(c => c.dangerActive).length,
        changes,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build digest: ' + err.message });
  }
});

// ─── Coach Actions helpers ───

const ACTIONS_PATH = path.resolve(__dirname, '../setup/coach-actions.json');

function loadActions() {
  if (!fs.existsSync(ACTIONS_PATH)) return [];
  return JSON.parse(fs.readFileSync(ACTIONS_PATH, 'utf8'));
}

function saveActions(actions) {
  fs.writeFileSync(ACTIONS_PATH, JSON.stringify(actions, null, 2) + '\n');
}

/**
 * GET /api/dashboard/actions/:clientName
 * Returns coach action log for a client.
 * - limit: number of actions (default 20, max 100)
 * - type: filter by type (note, assignment, follow-up)
 */
router.get('/actions/:clientName', (req, res) => {
  try {
    const clientName = decodeURIComponent(req.params.clientName);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const typeFilter = req.query.type || null;

    let actions = loadActions().filter(a => a.clientName === clientName);
    if (typeFilter) {
      actions = actions.filter(a => a.type === typeFilter);
    }
    // Newest first
    actions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    actions = actions.slice(0, limit);

    res.json({ actions, clientName, total: actions.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load actions: ' + err.message });
  }
});

/**
 * POST /api/dashboard/actions/:clientName
 * Add a coach action log entry.
 * Body: { coachName, action, type, assignedTo?, assignmentReason? }
 * type: "note" | "assignment" | "follow-up"
 */
router.post('/actions/:clientName', (req, res) => {
  try {
    const clientName = decodeURIComponent(req.params.clientName);
    const { coachName, action, type, assignedTo, assignmentReason } = req.body;

    if (!coachName || !action || !type) {
      return res.status(400).json({ error: 'Missing required fields: coachName, action, type' });
    }
    if (!['note', 'assignment', 'follow-up'].includes(type)) {
      return res.status(400).json({ error: 'type must be: note, assignment, or follow-up' });
    }

    const entry = {
      id: crypto.randomUUID(),
      clientName,
      coachName,
      action,
      type,
      assignedTo: assignedTo || null,
      assignmentReason: assignmentReason || null,
      timestamp: new Date().toISOString(),
      completed: false,
    };

    const actions = loadActions();
    actions.push(entry);
    saveActions(actions);

    // Push to Base44 (non-blocking)
    base44.pushClientAction(entry.id, {
      client_name: clientName,
      coach_name: coachName,
      action_text: action,
      action_type: type,
      assigned_to: assignedTo || '',
      assignment_reason: assignmentReason || '',
      created_at: entry.timestamp,
      completed: false,
    }).catch(() => {});

    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save action: ' + err.message });
  }
});

/**
 * PUT /api/dashboard/actions/:actionId
 * Update an action (mark complete, edit text, etc.)
 * Body: { completed?, action?, assignedTo? }
 */
router.put('/actions/:actionId', (req, res) => {
  try {
    const actionId = req.params.actionId;
    const updates = req.body;

    const actions = loadActions();
    const idx = actions.findIndex(a => a.id === actionId);
    if (idx === -1) {
      return res.status(404).json({ error: 'Action not found.' });
    }

    // Only allow updating specific fields
    if (updates.completed !== undefined) actions[idx].completed = updates.completed;
    if (updates.action) actions[idx].action = updates.action;
    if (updates.assignedTo !== undefined) actions[idx].assignedTo = updates.assignedTo;
    if (updates.assignmentReason) actions[idx].assignmentReason = updates.assignmentReason;
    actions[idx].updatedAt = new Date().toISOString();

    saveActions(actions);

    // Push update to Base44 (non-blocking)
    const a = actions[idx];
    base44.pushClientAction(a.id, {
      client_name: a.clientName,
      coach_name: a.coachName,
      action_text: a.action,
      action_type: a.type,
      assigned_to: a.assignedTo || '',
      assignment_reason: a.assignmentReason || '',
      created_at: a.timestamp,
      completed: a.completed || false,
      updated_at: a.updatedAt,
    }).catch(() => {});

    res.json({ success: true, entry: actions[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update action: ' + err.message });
  }
});

/**
 * GET /api/dashboard/assignments
 * Returns all current client assignments (who is assigned to which coach).
 */
router.get('/assignments', (req, res) => {
  try {
    const actions = loadActions();
    // Get the latest assignment for each client
    const assignments = {};
    actions
      .filter(a => a.type === 'assignment')
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .forEach(a => {
        assignments[a.clientName] = {
          assignedTo: a.assignedTo,
          assignmentReason: a.assignmentReason,
          assignedBy: a.coachName,
          assignedAt: a.timestamp,
        };
      });

    res.json({ assignments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load assignments: ' + err.message });
  }
});

/**
 * GET /api/dashboard/comparison
 * Returns comparison data for all clients: scores, marketing, trends.
 * Used for multi-client comparison view and averages.
 */
router.get('/comparison', async (req, res) => {
  try {
    const clients = getSafeClientList();
    const cdFieldDefsResponse = await ghl.getCustomFields(COACHING_DEPT_ID);
    const cdFields = cdFieldDefsResponse.customFields || [];

    const comparison = [];

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
        const program = readField('FF Program') || client.program;
        const activeMemberCount = parseFloat(readField('FF Active Member Count') || 0);
        const weeklyCancellations = parseFloat(readField('FF Weekly Cancellations') || 0);
        const weeklyRevenue = parseFloat(readField('FF Weekly Revenue') || 0);

        comparison.push({
          name: client.name,
          program,
          score,
          lastWeekScore,
          change: score - lastWeekScore,
          scoreStatus,
          dangerActive,
          activeMemberCount,
          weeklyCancellations,
          churnPercent: activeMemberCount > 0 ? Math.round((weeklyCancellations / activeMemberCount) * 10000) / 100 : 0,
          weeklyRevenue,
          googleAdsId: client.google_ads_customer_id || '',
          metaAdId: client.meta_ad_account_id || '',
        });
      } catch (contactErr) {
        comparison.push({ name: client.name, program: client.program, error: contactErr.message });
      }
    }

    // Compute averages
    const scored = comparison.filter(c => !c.error && c.score > 0);
    const allValid = comparison.filter(c => !c.error);
    const averages = {
      avgScore: scored.length > 0 ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : 0,
      avgChange: scored.length > 0 ? Math.round(scored.reduce((s, c) => s + c.change, 0) / scored.length * 10) / 10 : 0,
      totalClients: allValid.length,
      dangerCount: allValid.filter(c => c.dangerActive).length,
      avgChurn: allValid.length > 0 ? Math.round(allValid.reduce((s, c) => s + (c.churnPercent || 0), 0) / allValid.length * 100) / 100 : 0,
      avgRevenue: allValid.length > 0 ? Math.round(allValid.reduce((s, c) => s + (c.weeklyRevenue || 0), 0) / allValid.length) : 0,
    };

    res.json({ comparison, averages, pulledAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build comparison: ' + err.message });
  }
});

module.exports = router;
