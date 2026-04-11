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
