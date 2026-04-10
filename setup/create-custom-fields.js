/**
 * Setup Script: Create Custom Fields
 * Creates all Freedom Formula custom fields on The Coaching Dept. sub-account.
 * Run once during initial setup.
 *
 * NOTE: These same fields must also exist on each client's individual sub-account.
 * Usman is responsible for standardizing fields across all client sub-accounts.
 */

const ghl = require('../utils/ghl-api');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

// Accept a location ID as command line argument, or default to Coaching Dept
const LOCATION_ID = process.argv[2] || process.env.COACHING_DEPT_LOCATION_ID;
const API_KEY = process.argv[3] || null;

// Register the API key if provided
if (API_KEY && LOCATION_ID) {
  ghl.registerLocationKey(LOCATION_ID, API_KEY);
}

const CUSTOM_FIELDS = [
  // ─── Baseline / Tier ───
  { name: 'FF Monthly Revenue Baseline', dataType: 'NUMERICAL', position: 0 },
  { name: 'FF Revenue Tier', dataType: 'TEXT', position: 1 },

  // ─── Weekly KPI Fields ───
  { name: 'FF Weekly Revenue', dataType: 'NUMERICAL', position: 2 },
  { name: 'FF Weekly Leads', dataType: 'NUMERICAL', position: 3 },
  { name: 'FF Weekly New Members', dataType: 'NUMERICAL', position: 4 },
  { name: 'FF Weekly Cancellations', dataType: 'NUMERICAL', position: 5 },
  { name: 'FF Active Member Count', dataType: 'NUMERICAL', position: 6 },

  // ─── Hours Reclaimed ───
  { name: 'FF Hours Reclaimed This Week', dataType: 'NUMERICAL', position: 7 },
  { name: 'FF Hours Reclaimed Running Total', dataType: 'NUMERICAL', position: 8 },

  // ─── Blended CPL ───
  { name: 'FF Blended CPL This Week', dataType: 'NUMERICAL', position: 9 },
  { name: 'FF Blended CPL 4-Week Avg', dataType: 'NUMERICAL', position: 10 },

  // ─── Conversion Rate ───
  { name: 'FF Conversion Rate This Week', dataType: 'NUMERICAL', position: 11 },
  { name: 'FF Conversion Rate 4-Week Avg', dataType: 'NUMERICAL', position: 12 },

  // ─── Revenue Rolling ───
  { name: 'FF Revenue 4-Week Avg', dataType: 'NUMERICAL', position: 13 },

  // ─── Lead Volume Rolling ───
  { name: 'FF Lead Volume 4-Week Avg', dataType: 'NUMERICAL', position: 14 },

  // ─── Health Score ───
  { name: 'FF Health Score This Week', dataType: 'NUMERICAL', position: 15 },
  { name: 'FF Health Score Last Week', dataType: 'NUMERICAL', position: 16 },
  { name: 'FF Score Status', dataType: 'TEXT', position: 17 },

  // ─── Cycle Tracking ───
  { name: 'FF Cycle Start Date', dataType: 'DATE', position: 18 },
  { name: 'FF Current Cycle Number', dataType: 'NUMERICAL', position: 19 },

  // ─── Form Responses ───
  { name: 'FF Org Chart Status', dataType: 'TEXT', position: 20 },
  { name: 'FF Operational Control Rating', dataType: 'NUMERICAL', position: 29 },
  { name: 'FF Coaching Directive Status', dataType: 'TEXT', position: 21 },

  // ─── Override ───
  { name: 'FF Score Override Note', dataType: 'TEXT', position: 22 },

  // ─── Self Rating ───
  { name: 'FF Weekly Self Rating', dataType: 'NUMERICAL', position: 23 },

  // ─── Danger Zone ───
  { name: 'FF Danger Zone Active', dataType: 'TEXT', position: 24 },
  { name: 'FF Consecutive Missed Forms', dataType: 'NUMERICAL', position: 25 },
  { name: 'FF Consecutive Missed Calls', dataType: 'NUMERICAL', position: 26 },

  // ─── Milestone ───
  { name: 'FF Days Until Next Milestone', dataType: 'NUMERICAL', position: 27 },

  // ─── Program ───
  { name: 'FF Program', dataType: 'TEXT', position: 28 },
];

async function main() {
  console.log('Creating custom fields on The Coaching Dept. sub-account...');
  console.log(`Location: ${LOCATION_ID}`);

  if (!LOCATION_ID) {
    console.error('COACHING_DEPT_LOCATION_ID is not set. Check your .env file.');
    process.exit(1);
  }

  // Check for existing fields to avoid duplicates
  let existingFields = [];
  try {
    const existing = await ghl.getCustomFields(LOCATION_ID);
    existingFields = existing.customFields || [];
    console.log(`Found ${existingFields.length} existing custom fields.`);
  } catch (err) {
    console.log('Could not fetch existing fields, proceeding with creation...');
  }

  const existingNames = new Set(existingFields.map((f) => f.name));
  let created = 0;
  let skipped = 0;
  const results = [];

  for (const field of CUSTOM_FIELDS) {
    if (existingNames.has(field.name)) {
      console.log(`  SKIP: ${field.name} (already exists)`);
      skipped++;
      const existing = existingFields.find((f) => f.name === field.name);
      results.push({ name: field.name, id: existing.id, status: 'existed' });
      continue;
    }

    try {
      const result = await ghl.createCustomField(LOCATION_ID, {
        name: field.name,
        dataType: field.dataType,
        position: field.position,
        model: 'contact',
      });
      const fieldId = result.customField ? result.customField.id : result.id;
      console.log(`  OK: ${field.name} (ID: ${fieldId})`);
      results.push({ name: field.name, id: fieldId, status: 'created' });
      created++;

      // Rate limit safety
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`  FAIL: ${field.name} - ${err.message}`);
      results.push({ name: field.name, id: null, status: 'failed' });
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}, Failed: ${CUSTOM_FIELDS.length - created - skipped}`);
  console.log('\nField ID Reference:');
  for (const r of results) {
    if (r.id) console.log(`  ${r.name}: ${r.id}`);
  }
}

main();
