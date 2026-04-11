/**
 * Base44 API Utility
 * Creates and updates entity records in the Coaching Dept. Library app.
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

/**
 * Search for a UserProfile by email.
 * Returns the record if found, null otherwise.
 */
async function findUserProfileByEmail(email) {
  const url = `${BASE44_BASE_URL}/UserProfile?filter=${encodeURIComponent(JSON.stringify({ email }))}`;
  const results = await makeRequest('GET', url);
  const records = Array.isArray(results) ? results : (results.results || []);
  return records.length > 0 ? records[0] : null;
}

/**
 * Create a new UserProfile record.
 */
async function createUserProfile(data) {
  return makeRequest('POST', `${BASE44_BASE_URL}/UserProfile`, data);
}

/**
 * Update an existing UserProfile record by ID.
 */
async function updateUserProfile(id, data) {
  return makeRequest('PUT', `${BASE44_BASE_URL}/UserProfile/${id}`, data);
}

/**
 * Create or update a UserProfile by email.
 * Returns { id, created } where created=true if new record.
 */
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
  findUserProfileByEmail,
  createUserProfile,
  updateUserProfile,
  upsertUserProfile,
};
