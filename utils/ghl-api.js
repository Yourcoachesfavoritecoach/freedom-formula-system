/**
 * GHL API Utility
 * Uses sub-account level PITs for data access.
 * Each sub-account has its own PIT stored in the client registry or .env.
 * The Coaching Dept. PIT is in COACHING_DEPT_API_KEY.
 * Client sub-account PITs are stored in the client registry.
 */

const axios = require('axios');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const API_BASE = 'https://services.leadconnectorhq.com';
const AGENCY_KEY = process.env.FBS_AGENCY_API_KEY;
const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;
const COACHING_DEPT_KEY = process.env.COACHING_DEPT_API_KEY;

// Map of locationId -> API key for sub-account access
const _keyCache = {};

/**
 * Register a sub-account API key for use in requests.
 */
function registerLocationKey(locationId, apiKey) {
  _keyCache[locationId] = apiKey;
}

/**
 * Get the API key for a given location.
 * Falls back to Coaching Dept key if locationId matches, then agency key.
 */
function getKeyForLocation(locationId) {
  if (_keyCache[locationId]) return _keyCache[locationId];
  if (locationId === COACHING_DEPT_ID) return COACHING_DEPT_KEY;
  return COACHING_DEPT_KEY; // Default fallback
}

function headers(locationId) {
  const key = getKeyForLocation(locationId);
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };
}

async function apiRequest(method, path, locationId, data = null, retries = 1) {
  const url = `${API_BASE}${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const config = {
        method,
        url,
        headers: headers(locationId),
        ...(data ? { data } : {}),
      };
      const res = await axios(config);
      return res.data;
    } catch (err) {
      if (attempt < retries && err.response && err.response.status >= 500) {
        await sleep(2000);
        continue;
      }
      const status = err.response ? err.response.status : 'NETWORK';
      const body = err.response ? err.response.data : err.message;
      console.error(`GHL API ${method} ${path} failed (${status}):`, body);
      throw err;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Contacts ───

async function getContact(locationId, contactId) {
  return apiRequest('GET', `/contacts/${contactId}`, locationId);
}

async function updateContact(locationId, contactId, fields) {
  return apiRequest('PUT', `/contacts/${contactId}`, locationId, fields);
}

async function createContact(locationId, contactData) {
  return apiRequest('POST', '/contacts/', locationId, { ...contactData, locationId });
}

async function searchContacts(locationId, query) {
  const params = { locationId, ...query };
  return apiRequest('GET', `/contacts/?${new URLSearchParams(params)}`, locationId);
}

async function addContactNote(locationId, contactId, body) {
  return apiRequest('POST', `/contacts/${contactId}/notes`, locationId, { body });
}

async function addContactTag(locationId, contactId, tags) {
  return apiRequest('POST', `/contacts/${contactId}/tags`, locationId, { tags });
}

async function removeContactTag(locationId, contactId, tags) {
  // GHL v2 uses DELETE with body
  return apiRequest('DELETE', `/contacts/${contactId}/tags`, locationId, { tags });
}

// ─── Custom Fields ───

async function getCustomFields(locationId) {
  return apiRequest('GET', `/locations/${locationId}/customFields`, locationId);
}

async function createCustomField(locationId, fieldData) {
  return apiRequest('POST', `/locations/${locationId}/customFields`, locationId, fieldData);
}

// ─── Custom Values (contact-level field writes) ───

async function updateContactCustomFields(locationId, contactId, customFields) {
  // customFields is an array of { id, value }
  return apiRequest('PUT', `/contacts/${contactId}`, locationId, { customFields: customFields });
}

// ─── Pipelines ───

async function createPipeline(locationId, pipelineData) {
  return apiRequest('POST', '/opportunities/pipelines', locationId, pipelineData);
}

async function getPipelines(locationId) {
  return apiRequest('GET', '/opportunities/pipelines', locationId);
}

async function createOpportunity(locationId, opportunityData) {
  return apiRequest('POST', '/opportunities/', locationId, opportunityData);
}

async function updateOpportunity(locationId, opportunityId, data) {
  return apiRequest('PUT', `/opportunities/${opportunityId}`, locationId, data);
}

async function getOpportunitiesByContact(locationId, contactId) {
  return apiRequest('GET', `/opportunities/search?contact_id=${contactId}`, locationId);
}

// ─── Tags ───

async function getTags(locationId) {
  return apiRequest('GET', `/locations/${locationId}/tags`, locationId);
}

async function createTag(locationId, tagData) {
  return apiRequest('POST', `/locations/${locationId}/tags`, locationId, tagData);
}

// ─── Tasks ───

async function createTask(locationId, contactId, taskData) {
  return apiRequest('POST', `/contacts/${contactId}/tasks`, locationId, taskData);
}

// ─── Appointments ───

async function getCalendars(locationId) {
  return apiRequest('GET', `/calendars/?locationId=${locationId}`, locationId);
}

async function getAppointments(locationId, params) {
  // GHL v2 requires startTime/endTime as ISO strings and a calendarId or groupId
  const qs = new URLSearchParams(params).toString();
  return apiRequest('GET', `/calendars/events?locationId=${locationId}&${qs}`, locationId);
}

// ─── Conversations ───

async function getConversations(locationId, contactId) {
  return apiRequest('GET', `/conversations/search?contactId=${contactId}`, locationId);
}

async function getMessages(locationId, conversationId, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiRequest('GET', `/conversations/${conversationId}/messages?${qs}`, locationId);
}

// ─── Emails ───

async function sendEmail(locationId, emailData) {
  return apiRequest('POST', '/conversations/messages', locationId, emailData);
}

// ─── Workflows ───

async function triggerWorkflow(locationId, workflowId, contactId) {
  return apiRequest('POST', `/contacts/${contactId}/workflow/${workflowId}`, locationId);
}

// ─── Smart Lists ───

async function createSmartList(locationId, listData) {
  return apiRequest('POST', '/contacts/search/saved', locationId, listData);
}

// ─── Bulk Field Writer ───

/**
 * Write multiple custom field values to a contact.
 * fieldMap: { "FF Health Score This Week": 85, "FF Score Status": "Green" }
 * fieldDefinitions: array from getCustomFields() with { id, name } entries
 */
async function writeFieldsToContact(locationId, contactId, fieldMap, fieldDefinitions) {
  const customFields = [];
  for (const [name, value] of Object.entries(fieldMap)) {
    const def = fieldDefinitions.find((f) => f.name === name);
    if (def) {
      customFields.push({ id: def.id, value: value });
    } else {
      console.warn(`Custom field not found: ${name}`);
    }
  }
  if (customFields.length > 0) {
    return updateContactCustomFields(locationId, contactId, customFields);
  }
}

module.exports = {
  getContact,
  createContact,
  updateContact,
  searchContacts,
  addContactNote,
  addContactTag,
  removeContactTag,
  getCustomFields,
  createCustomField,
  updateContactCustomFields,
  writeFieldsToContact,
  createPipeline,
  getPipelines,
  createOpportunity,
  updateOpportunity,
  getOpportunitiesByContact,
  getTags,
  createTag,
  createTask,
  getCalendars,
  getAppointments,
  getConversations,
  getMessages,
  sendEmail,
  triggerWorkflow,
  createSmartList,
  registerLocationKey,
  COACHING_DEPT_ID,
};
