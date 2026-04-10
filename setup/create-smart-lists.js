/**
 * Setup Script: Create Smart Lists
 * Creates the two dashboard smart lists inside The Coaching Dept. sub-account.
 * - Freedom Formula Dashboard: all FF mirror contacts sorted by health score ascending
 * - Black Circle Dashboard: all BC mirror contacts (score blank for now)
 */

const ghl = require('../utils/ghl-api');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const LOCATION_ID = process.env.COACHING_DEPT_LOCATION_ID;

async function main() {
  console.log('Creating smart lists on The Coaching Dept. sub-account...');
  console.log(`Location: ${LOCATION_ID}`);

  if (!LOCATION_ID) {
    console.error('COACHING_DEPT_LOCATION_ID is not set. Check your .env file.');
    process.exit(1);
  }

  // Freedom Formula Dashboard
  try {
    const ffDashboard = await ghl.createSmartList(LOCATION_ID, {
      name: 'Freedom Formula Dashboard',
      filters: [
        {
          field: 'tags',
          operator: 'contains',
          value: 'FF-Active',
        },
      ],
      sortBy: 'FF Health Score This Week',
      sortOrder: 'asc',
    });
    console.log('Freedom Formula Dashboard created.');
    console.log('  ID:', ffDashboard.id || 'check GHL UI');
  } catch (err) {
    console.error('Failed to create FF Dashboard:', err.message);
    console.log('NOTE: You may need to create this smart list manually in GHL.');
    console.log('  Name: Freedom Formula Dashboard');
    console.log('  Filter: Tag contains FF-Active');
    console.log('  Sort: FF Health Score This Week, ascending');
  }

  // Black Circle Dashboard
  try {
    const bcDashboard = await ghl.createSmartList(LOCATION_ID, {
      name: 'Black Circle Dashboard',
      filters: [
        {
          field: 'tags',
          operator: 'contains',
          value: 'BC-Active',
        },
      ],
      sortBy: 'name',
      sortOrder: 'asc',
    });
    console.log('Black Circle Dashboard created.');
    console.log('  ID:', bcDashboard.id || 'check GHL UI');
  } catch (err) {
    console.error('Failed to create BC Dashboard:', err.message);
    console.log('NOTE: You may need to create this smart list manually in GHL.');
    console.log('  Name: Black Circle Dashboard');
    console.log('  Filter: Tag contains BC-Active');
    console.log('  Sort: Name, ascending (score blank until BC scoring built)');
  }

  console.log('\nDone. Both dashboards serve as Dave and Heather\'s command center.');
}

main();
