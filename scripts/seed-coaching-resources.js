/**
 * Seed CoachingResource records in Base44.
 * Run once to populate the My Resources tab with starter content.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const base44 = require('../utils/base44-api');

const resources = [
  // --- Recordings ---
  {
    title: 'Freedom Formula Kickoff Call',
    description: 'Welcome call covering the 90-day framework, expectations, and how to get the most out of the program.',
    resource_type: 'Recording',
    category: 'General',
    program: 'Freedom Formula',
    url: 'https://coachingdept.com/resources/ff-kickoff',
    is_published: true,
  },
  {
    title: 'Black Circle Advanced Strategy Session',
    description: 'Deep dive into scaling past $50k/mo — team leverage, profit optimization, and owner exit planning.',
    resource_type: 'Recording',
    category: 'Operations',
    program: 'Black Circle',
    url: 'https://coachingdept.com/resources/bc-strategy',
    is_published: true,
  },
  {
    title: 'Sales Mastery Workshop',
    description: 'Closing framework, objection handling, and follow-up sequences that convert leads into members.',
    resource_type: 'Recording',
    category: 'Sales',
    program: 'Both',
    url: 'https://coachingdept.com/resources/sales-mastery',
    is_published: true,
  },
  {
    title: 'Lead Generation Bootcamp',
    description: 'Paid ads, organic content, and referral systems to fill your pipeline consistently.',
    resource_type: 'Recording',
    category: 'Marketing',
    program: 'Both',
    url: 'https://coachingdept.com/resources/leadgen-bootcamp',
    is_published: true,
  },
  {
    title: 'Leadership & Team Culture',
    description: 'Building a team that runs without you. Hiring, firing, accountability, and culture systems.',
    resource_type: 'Recording',
    category: 'Leadership',
    program: 'Both',
    url: 'https://coachingdept.com/resources/leadership-culture',
    is_published: true,
  },

  // --- Templates ---
  {
    title: '90-Day Business Scorecard Template',
    description: 'Track revenue, profit, leads, conversion, and operational control week over week.',
    resource_type: 'Template',
    category: 'Operations',
    program: 'Both',
    url: 'https://coachingdept.com/resources/scorecard-template',
    is_published: true,
  },
  {
    title: 'Weekly Coaching Prep Sheet',
    description: 'Fill this out before every coaching call. Wins, blockers, and the one thing you need help with.',
    resource_type: 'Template',
    category: 'General',
    program: 'Both',
    url: 'https://coachingdept.com/resources/coaching-prep',
    is_published: true,
  },
  {
    title: 'Profit & Loss Tracker',
    description: 'Simple P&L spreadsheet designed for gym owners. Know your real profit every month.',
    resource_type: 'Template',
    category: 'Operations',
    program: 'Both',
    url: 'https://coachingdept.com/resources/pl-tracker',
    is_published: true,
  },
  {
    title: 'Sales Script — Intro Offer Close',
    description: 'Word-for-word script for converting intro offer leads into full memberships.',
    resource_type: 'Template',
    category: 'Sales',
    program: 'Freedom Formula',
    url: 'https://coachingdept.com/resources/intro-offer-script',
    is_published: true,
  },

  // --- SOPs ---
  {
    title: 'New Member Onboarding SOP',
    description: 'Step-by-step process from first contact to first 30 days. Reduces churn by setting expectations early.',
    resource_type: 'SOP',
    category: 'Operations',
    program: 'Both',
    url: 'https://coachingdept.com/resources/onboarding-sop',
    is_published: true,
  },
  {
    title: 'Cancellation Save SOP',
    description: 'What to say and do when a member wants to cancel. Save rate benchmarks included.',
    resource_type: 'SOP',
    category: 'Sales',
    program: 'Both',
    url: 'https://coachingdept.com/resources/cancel-save-sop',
    is_published: true,
  },
  {
    title: 'Daily Manager Checklist',
    description: 'The 15-minute daily review your manager should do every morning before the gym opens.',
    resource_type: 'SOP',
    category: 'Operations',
    program: 'Both',
    url: 'https://coachingdept.com/resources/manager-checklist',
    is_published: true,
  },

  // --- Worksheets ---
  {
    title: 'Vision & Non-Negotiables Worksheet',
    description: 'Define your 12-month vision, 3-year vision, and the standards you refuse to drop.',
    resource_type: 'Worksheet',
    category: 'Mindset',
    program: 'Both',
    url: 'https://coachingdept.com/resources/vision-worksheet',
    is_published: true,
  },
  {
    title: 'Org Chart Builder',
    description: 'Map your current team and identify the gaps. Who do you need to hire next?',
    resource_type: 'Worksheet',
    category: 'Leadership',
    program: 'Both',
    url: 'https://coachingdept.com/resources/org-chart',
    is_published: true,
  },
  {
    title: 'Ad Spend ROI Calculator',
    description: 'Input your ad spend, leads, and conversions to see your true cost per acquisition and ROI.',
    resource_type: 'Worksheet',
    category: 'Marketing',
    program: 'Both',
    url: 'https://coachingdept.com/resources/roi-calculator',
    is_published: true,
  },
];

async function seed() {
  console.log(`Seeding ${resources.length} CoachingResource records...`);

  let created = 0;
  let failed = 0;

  for (const resource of resources) {
    try {
      const result = await base44.upsertEntity('CoachingResource', { title: resource.title }, resource);
      console.log(`  ${result.created ? 'Created' : 'Updated'}: ${resource.title}`);
      created++;
    } catch (err) {
      console.error(`  FAILED: ${resource.title} — ${err.message}`);
      failed++;
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. ${created} succeeded, ${failed} failed.`);
}

seed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
