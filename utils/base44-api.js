/**
 * Base44 API Utility
 * Creates and updates entity records in the Coaching Dept. Library app.
 * Supports UserProfile (intake) + generic entity CRUD for companion app data.
 */

const https = require('https');

const BASE44_API_KEY = process.env.BASE44_API_KEY;
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_BASE_URL = `https://app.base44.com/api/apps/${BASE44_APP_ID}/entities`;

function makeRequest(method, entityUrl, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(entityUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`Base44 API ${method} ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Generic Entity CRUD ───

/**
 * Find records in any entity by filter object.
 * Returns array of matching records.
 */
async function findEntity(entityName, filter) {
  const url = `${BASE44_BASE_URL}/${entityName}?filter=${encodeURIComponent(JSON.stringify(filter))}`;
  const results = await makeRequest('GET', url);
  return Array.isArray(results) ? results : (results.results || []);
}

/**
 * Create a record in any entity.
 */
async function createEntity(entityName, data) {
  return makeRequest('POST', `${BASE44_BASE_URL}/${entityName}`, data);
}

/**
 * Update a record in any entity by ID.
 */
async function updateEntity(entityName, id, data) {
  return makeRequest('PUT', `${BASE44_BASE_URL}/${entityName}/${id}`, data);
}

/**
 * Upsert a record by composite filter.
 * If a record matching the filter exists, update it. Otherwise create.
 * Returns { id, created }.
 */
async function upsertEntity(entityName, filter, data) {
  const existing = await findEntity(entityName, filter);
  if (existing.length > 0) {
    const id = existing[0].id || existing[0]._id;
    await updateEntity(entityName, id, data);
    return { id, created: false };
  }
  const created = await createEntity(entityName, { ...filter, ...data });
  return { id: created.id || created._id, created: true };
}

// ─── Push Convenience Wrappers (non-critical — log and swallow errors) ───

/**
 * Push a ClientScore record for a client week.
 * Upserts by client_email + week_date.
 */
async function pushClientScore(email, weekDate, scoreData) {
  try {
    return await upsertEntity('ClientScore', { client_email: email, week_date: weekDate }, scoreData);
  } catch (err) {
    console.log(`Base44: ClientScore push failed for ${email}: ${err.message}`);
    return null;
  }
}

/**
 * Push a ClientMetric record for a client week.
 * Upserts by client_email + week_date.
 */
async function pushClientMetric(email, weekDate, metricData) {
  try {
    return await upsertEntity('ClientMetric', { client_email: email, week_date: weekDate }, metricData);
  } catch (err) {
    console.log(`Base44: ClientMetric push failed for ${email}: ${err.message}`);
    return null;
  }
}

/**
 * Push a ClientAction record.
 * Upserts by action_id.
 */
async function pushClientAction(actionId, actionData) {
  try {
    return await upsertEntity('ClientAction', { action_id: actionId }, actionData);
  } catch (err) {
    console.log(`Base44: ClientAction push failed for ${actionId}: ${err.message}`);
    return null;
  }
}

/**
 * Push a ClientMilestone record.
 * Upserts by client_email + milestone_type + cycle_number.
 */
async function pushClientMilestone(email, milestoneType, cycleNumber, milestoneData) {
  try {
    return await upsertEntity('ClientMilestone', {
      client_email: email,
      milestone_type: milestoneType,
      cycle_number: cycleNumber,
    }, milestoneData);
  } catch (err) {
    console.log(`Base44: ClientMilestone push failed for ${email}: ${err.message}`);
    return null;
  }
}

/**
 * Push a ClientSchedule record.
 * Upserts by client_email + event_id.
 */
async function pushClientSchedule(email, eventId, scheduleData) {
  try {
    return await upsertEntity('ClientSchedule', { client_email: email, event_id: eventId }, scheduleData);
  } catch (err) {
    console.log(`Base44: ClientSchedule push failed for ${email}: ${err.message}`);
    return null;
  }
}

// ─── UserProfile (legacy convenience wrappers) ───

async function findUserProfileByEmail(email) {
  const records = await findEntity('UserProfile', { email });
  return records.length > 0 ? records[0] : null;
}

async function createUserProfile(data) {
  return createEntity('UserProfile', data);
}

async function updateUserProfile(id, data) {
  return updateEntity('UserProfile', id, data);
}

async function upsertUserProfile(email, data) {
  const existing = await findUserProfileByEmail(email);
  if (existing) {
    const id = existing.id || existing._id;
    await updateUserProfile(id, { ...data, onboarding_completed: true });
    return { id, created: false };
  }
  const created = await createUserProfile({ ...data, email, onboarding_completed: true });
  return { id: created.id || created._id, created: true };
}

module.exports = {
  // Generic CRUD
  findEntity,
  createEntity,
  updateEntity,
  upsertEntity,
  // Push wrappers
  pushClientScore,
  pushClientMetric,
  pushClientAction,
  pushClientMilestone,
  pushClientSchedule,
  // UserProfile
  findUserProfileByEmail,
  createUserProfile,
  updateUserProfile,
  upsertUserProfile,
};
