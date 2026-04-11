/**
 * Schedule Sync
 * Runs daily at 6:00am via cron.
 * Pulls upcoming appointments from GHL for each client
 * and pushes them to the ClientSchedule entity in Base44.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const base44 = require('../utils/base44-api');

function loadRegistry() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);

  for (const client of registry.clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }

  return registry.clients.filter(c => c.ghl_location_id !== 'USMAN_FILLS_THIS');
}

async function run() {
  console.log('=== Schedule Sync ===');
  console.log(`Run time: ${new Date().toISOString()}`);

  const clients = loadRegistry();
  if (clients.length === 0) {
    console.log('No clients. Exiting.');
    return;
  }

  // Look 14 days ahead
  const now = new Date();
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + 14);

  let totalPushed = 0;

  for (const client of clients) {
    const loc = client.ghl_location_id;
    const contactId = client.ff_contact_id;

    try {
      // Get client email from contact
      const contactResponse = await ghl.getContact(loc, contactId);
      const contact = contactResponse.contact || contactResponse;
      const email = contact.email;
      if (!email) {
        console.log(`  ${client.name}: No email, skipping`);
        continue;
      }

      // Get all calendars for this location
      const calData = await ghl.getCalendars(loc);
      const calendars = calData.calendars || [];

      for (const cal of calendars) {
        try {
          const appointments = await ghl.getAppointments(loc, {
            calendarId: cal.id,
            startTime: now.toISOString(),
            endTime: endDate.toISOString(),
          });

          const events = appointments.events || [];
          for (const appt of events) {
            // Only sync this client's appointments
            if (appt.contactId !== contactId && appt.contact_id !== contactId) continue;

            const eventId = appt.id || appt._id;
            await base44.pushClientSchedule(email, eventId, {
              client_name: client.name,
              event_title: appt.title || cal.name || 'Coaching Call',
              event_date: appt.startTime || appt.start_time || '',
              event_end: appt.endTime || appt.end_time || '',
              event_type: 'coaching_call',
              status: appt.appointmentStatus || appt.status || 'scheduled',
              calendar_name: cal.name || '',
            });
            totalPushed++;
          }
        } catch (calErr) {
          // Skip calendars that fail
        }
      }

      console.log(`  ${client.name}: synced`);
    } catch (err) {
      console.error(`  FAILED: ${client.name} - ${err.message}`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nSchedule sync complete. ${totalPushed} events pushed to Base44.`);
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Schedule sync failed:', err);
      process.exit(1);
    });
}
