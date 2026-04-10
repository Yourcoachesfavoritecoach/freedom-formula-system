/**
 * Check-In Form API Server
 * Receives weekly check-in form submissions and writes them to GHL.
 * Also serves the check-in form HTML.
 * Handles GHL webhook for automatic client onboarding.
 *
 * Endpoints:
 *   GET  /                        → Serves the check-in form
 *   POST /api/check-in            → Receives form data, writes note to GHL contact
 *   POST /api/webhook/onboard     → GHL webhook: auto-onboard when client hits Payment Received
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const { onboardNewClients } = require('../engine/onboard-client');

const app = express();
const PORT = process.env.FORM_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Load client registry for PIT resolution
function loadRegistry() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  for (const client of registry.clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }
  return registry.clients;
}

// Register keys on startup
loadRegistry();

// ─── Serve the form ───
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../forms/weekly-check-in.html'));
});

// ─── Handle check-in submission ───
app.post('/api/check-in', async (req, res) => {
  try {
    const { contactId, locationId, firstName, email, rating, noteBody, submittedAt, responses } = req.body;

    if (!contactId) {
      return res.status(400).json({ error: 'Missing contact_id' });
    }
    if (!noteBody) {
      return res.status(400).json({ error: 'Missing note body' });
    }

    const targetLocationId = locationId || ghl.COACHING_DEPT_ID;

    // 1. Write the reflection as a note on the contact in The Coaching Dept.
    console.log(`Writing check-in note for contact ${contactId} (${firstName || email || 'unknown'})`);
    await ghl.addContactNote(targetLocationId, contactId, noteBody);

    // 2. Update the weekly self-rating custom field if we have it
    if (rating !== null && rating !== undefined) {
      try {
        const fieldDefsResponse = await ghl.getCustomFields(targetLocationId);
        const fieldDefs = fieldDefsResponse.customFields || [];

        await ghl.writeFieldsToContact(targetLocationId, contactId, {
          'FF Weekly Self Rating': rating,
        }, fieldDefs);

        console.log(`  Updated FF Weekly Self Rating: ${rating}`);
      } catch (fieldErr) {
        console.error(`  Warning: Could not update custom field: ${fieldErr.message}`);
        // Don't fail the request — the note is what matters
      }
    }

    // 3. Log success
    console.log(`  Check-in saved for ${firstName || email || contactId} - Rating: ${rating}/10 - ${new Date().toISOString()}`);

    res.json({
      success: true,
      message: 'Check-in recorded.',
      contactId,
      rating,
      timestamp: submittedAt || new Date().toISOString(),
    });
  } catch (err) {
    console.error('Check-in submission failed:', err.message);
    res.status(500).json({ error: 'Failed to save check-in. Please try again.' });
  }
});

// ─── GHL Webhook: Auto-onboard new clients ───
// Set this URL as a webhook in GHL for pipeline stage changes.
// When a contact moves to "Payment Received", this triggers onboarding
// for any clients in the registry that don't have a mirror contact yet.
app.post('/api/webhook/onboard', async (req, res) => {
  try {
    console.log(`Webhook received: onboard trigger - ${new Date().toISOString()}`);

    // Reload registry and onboard anyone missing a mirror contact
    loadRegistry();
    await onboardNewClients();

    res.json({ success: true, message: 'Onboarding check complete.' });
  } catch (err) {
    console.error('Webhook onboard failed:', err.message);
    res.status(500).json({ error: 'Onboarding failed.' });
  }
});

// ─── Health check ───
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`Check-in form server running on http://localhost:${PORT}`);
  console.log(`Form URL example: http://localhost:${PORT}/?contact_id=CONTACT_ID&first_name=NAME&email=EMAIL`);
});

module.exports = app;
