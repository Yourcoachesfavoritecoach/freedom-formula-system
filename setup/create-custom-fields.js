/**
 * Setup Script: Create Custom Fields
 * Creates all Freedom Formula custom fields on The Coaching Dept. sub-account.
 * Run once during initial setup.
 *
 * NOTE: These same fields must also exist on each client's individual sub-account.
 * Usman is responsible for standardizing fields across all client sub-accounts.
 */

const ghl = require('../utils/ghl-api');
const { ALL_FIELDS: CUSTOM_FIELDS } = require('../utils/field-definitions');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

// Accept a location ID as command line argument, or default to Coaching Dept
const LOCATION_ID = process.argv[2] || process.env.COACHING_DEPT_LOCATION_ID;
const API_KEY = process.argv[3] || null;

// Register the API key if provided
if (API_KEY && LOCATION_ID) {
  ghl.registerLocationKey(LOCATION_ID, API_KEY);
}

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
