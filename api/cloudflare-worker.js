/**
 * Cloudflare Worker — Weekly Check-In Proxy
 * Receives form POST, writes note + updates custom field on GHL contact.
 *
 * Deploy to Cloudflare Workers (free tier).
 * Set these environment variables in Cloudflare dashboard:
 *   GHL_API_KEY = pit-8fcda97d-b8c9-4463-bd36-1553df77d257
 *   COACHING_DEPT_LOCATION_ID = FeySgmJup9wqIQhhJomk
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Only accept POST
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
      const data = await request.json();
      const { contact_id, note_body, rating } = data;

      if (!contact_id) {
        return jsonResponse({ error: 'Missing contact_id' }, 400);
      }
      if (!note_body) {
        return jsonResponse({ error: 'Missing note_body' }, 400);
      }

      const locationId = data.location_id || env.COACHING_DEPT_LOCATION_ID;
      const apiKey = env.GHL_API_KEY;
      const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Version': GHL_VERSION,
      };

      // 1. Add note to contact
      const noteRes = await fetch(`${GHL_BASE}/contacts/${contact_id}/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: note_body }),
      });

      if (!noteRes.ok) {
        const errBody = await noteRes.text();
        console.error('Note failed:', noteRes.status, errBody);
        return jsonResponse({ error: 'Failed to save note', status: noteRes.status }, 500);
      }

      // 2. Update custom fields (self rating + scoring fields)
      const fieldsRes = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
        method: 'GET',
        headers,
      });

      if (fieldsRes.ok) {
        const fieldsData = await fieldsRes.json();
        const fields = fieldsData.customFields || [];
        const customFields = [];

        // Map form fields to GHL custom fields
        const fieldMap = {
          'FF Weekly Self Rating': rating,
          'FF Operational Control Rating': data.operational_control_rating,
          'FF Coaching Directive Status': data.coaching_directive,
          'FF Hours Reclaimed This Week': data.hours_reclaimed,
        };

        for (const [name, value] of Object.entries(fieldMap)) {
          if (value === null || value === undefined) continue;
          const field = fields.find(f => f.name === name);
          if (field) {
            customFields.push({ id: field.id, value: value });
          }
        }

        if (customFields.length > 0) {
          await fetch(`${GHL_BASE}/contacts/${contact_id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ customFields }),
          });
        }
      }

      return jsonResponse({
        success: true,
        message: 'Check-in recorded.',
        contact_id,
        rating,
      });

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal error' }, 500);
    }
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
