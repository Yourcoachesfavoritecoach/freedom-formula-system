/**
 * Shared Custom Field Definitions
 * Single source of truth for all FF and BC custom fields.
 * Used by setup scripts and auto-provisioning in the scoring engine.
 */

const FF_FIELDS = [
  { name: 'FF Monthly Revenue Baseline', dataType: 'NUMERICAL', position: 0 },
  { name: 'FF Revenue Tier', dataType: 'TEXT', position: 1 },
  { name: 'FF Weekly Revenue', dataType: 'NUMERICAL', position: 2 },
  { name: 'FF Weekly Leads', dataType: 'NUMERICAL', position: 3 },
  { name: 'FF Weekly New Members', dataType: 'NUMERICAL', position: 4 },
  { name: 'FF Weekly Cancellations', dataType: 'NUMERICAL', position: 5 },
  { name: 'FF Active Member Count', dataType: 'NUMERICAL', position: 6 },
  { name: 'FF Hours Reclaimed This Week', dataType: 'NUMERICAL', position: 7 },
  { name: 'FF Hours Reclaimed Running Total', dataType: 'NUMERICAL', position: 8 },
  { name: 'FF Blended CPL This Week', dataType: 'NUMERICAL', position: 9 },
  { name: 'FF Blended CPL 4-Week Avg', dataType: 'NUMERICAL', position: 10 },
  { name: 'FF Conversion Rate This Week', dataType: 'NUMERICAL', position: 11 },
  { name: 'FF Conversion Rate 4-Week Avg', dataType: 'NUMERICAL', position: 12 },
  { name: 'FF Revenue 4-Week Avg', dataType: 'NUMERICAL', position: 13 },
  { name: 'FF Lead Volume 4-Week Avg', dataType: 'NUMERICAL', position: 14 },
  { name: 'FF Health Score This Week', dataType: 'NUMERICAL', position: 15 },
  { name: 'FF Health Score Last Week', dataType: 'NUMERICAL', position: 16 },
  { name: 'FF Score Status', dataType: 'TEXT', position: 17 },
  { name: 'FF Cycle Start Date', dataType: 'DATE', position: 18 },
  { name: 'FF Current Cycle Number', dataType: 'NUMERICAL', position: 19 },
  { name: 'FF Org Chart Status', dataType: 'TEXT', position: 20 },
  { name: 'FF Operational Control Rating', dataType: 'NUMERICAL', position: 29 },
  { name: 'FF Coaching Directive Status', dataType: 'TEXT', position: 21 },
  { name: 'FF Score Override Note', dataType: 'TEXT', position: 22 },
  { name: 'FF Weekly Self Rating', dataType: 'NUMERICAL', position: 23 },
  { name: 'FF Danger Zone Active', dataType: 'TEXT', position: 24 },
  { name: 'FF Consecutive Missed Forms', dataType: 'NUMERICAL', position: 25 },
  { name: 'FF Consecutive Missed Calls', dataType: 'NUMERICAL', position: 26 },
  { name: 'FF Days Until Next Milestone', dataType: 'NUMERICAL', position: 27 },
  { name: 'FF Program', dataType: 'TEXT', position: 28 },
];

const BC_FIELDS = [
  { name: 'BC Strategic Initiative Status', dataType: 'TEXT', position: 30 },
  { name: 'BC Team Development Rating', dataType: 'NUMERICAL', position: 31 },
  { name: 'BC CEO Hours This Week', dataType: 'NUMERICAL', position: 32 },
  { name: 'BC Weekly Revenue Target', dataType: 'NUMERICAL', position: 33 },
  { name: 'BC Profit Margin This Week', dataType: 'NUMERICAL', position: 34 },
  { name: 'BC Profit Margin 4-Week Avg', dataType: 'NUMERICAL', position: 35 },
  { name: 'BC Member Retention Rate', dataType: 'NUMERICAL', position: 36 },
  { name: 'BC Peer Contribution', dataType: 'TEXT', position: 37 },
  { name: 'BC Weeks Under Revenue Target', dataType: 'NUMERICAL', position: 38 },
];

const ALL_FIELDS = [...FF_FIELDS, ...BC_FIELDS];

module.exports = { FF_FIELDS, BC_FIELDS, ALL_FIELDS };
