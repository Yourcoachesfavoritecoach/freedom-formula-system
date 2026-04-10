/**
 * Setup Script: Create Tags
 * Creates all Freedom Formula and Black Circle tags inside The Coaching Dept. sub-account.
 * Run once during initial setup.
 */

const ghl = require('../utils/ghl-api');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const LOCATION_ID = process.env.COACHING_DEPT_LOCATION_ID;

function buildTagList() {
  const tags = [
    // Program status tags
    'FF-Active',
    'FF-Danger',
    'FF-Upgrade-Eligible',
    'FF-Graduated',
    'FF-Cancelled',
    'BC-Active',
    'BC-Danger',
    'BC-Graduated',
    'BC-Cancelled',
  ];

  // Weekly tags: FF-Week-1 through FF-Week-52
  for (let i = 1; i <= 52; i++) {
    tags.push(`FF-Week-${i}`);
  }

  // Cycle tags: FF-Cycle-1 through FF-Cycle-6
  for (let i = 1; i <= 6; i++) {
    tags.push(`FF-Cycle-${i}`);
  }

  return tags;
}

async function main() {
  console.log('Creating tags on The Coaching Dept. sub-account...');
  console.log(`Location: ${LOCATION_ID}`);

  if (!LOCATION_ID) {
    console.error('COACHING_DEPT_LOCATION_ID is not set. Check your .env file.');
    process.exit(1);
  }

  // Check existing tags
  let existingTags = [];
  try {
    const existing = await ghl.getTags(LOCATION_ID);
    existingTags = (existing.tags || []).map((t) => t.name);
    console.log(`Found ${existingTags.length} existing tags.`);
  } catch (err) {
    console.log('Could not fetch existing tags, proceeding...');
  }

  const existingSet = new Set(existingTags);
  const allTags = buildTagList();
  let created = 0;
  let skipped = 0;

  for (const tagName of allTags) {
    if (existingSet.has(tagName)) {
      skipped++;
      continue;
    }

    try {
      await ghl.createTag(LOCATION_ID, { name: tagName });
      created++;

      // Rate limit — GHL can throttle bulk tag creation
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`  FAIL: ${tagName} - ${err.message}`);
    }
  }

  console.log(`\nDone. Total: ${allTags.length}, Created: ${created}, Skipped: ${skipped}`);
}

main();
