/**
 * Client Intake API
 * Receives intake form submissions, creates/updates GHL contact,
 * writes custom fields, adds intake note, and tags the contact.
 */

const express = require('express');
const router = express.Router();
const ghl = require('../utils/ghl-api');
const base44 = require('../utils/base44-api');

const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;

router.post('/', async (req, res) => {
  try {
    const { full_name, email, phone, city, tags, customField } = req.body;

    if (!full_name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    // 1. Search for existing contact by email
    let contactId = null;
    try {
      const search = await ghl.searchContacts(COACHING_DEPT_ID, { query: email });
      const contacts = search.contacts || [];
      if (contacts.length > 0) {
        contactId = contacts[0].id;
        console.log(`Intake: Found existing contact ${contactId} for ${email}`);
      }
    } catch (searchErr) {
      console.log(`Intake: No existing contact found for ${email}, will create new`);
    }

    // 2. Split name
    const nameParts = full_name.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // 3. Create or update contact
    if (!contactId) {
      const created = await ghl.createContact(COACHING_DEPT_ID, {
        firstName,
        lastName,
        email,
        phone: phone || '',
        city: city || '',
        tags: tags || ['Freedom Formula', 'Intake Complete'],
        source: 'Client Intake Form',
      });
      contactId = created.contact ? created.contact.id : created.id;
      console.log(`Intake: Created new contact ${contactId} for ${full_name}`);
    } else {
      await ghl.updateContact(COACHING_DEPT_ID, contactId, {
        firstName,
        lastName,
        phone: phone || undefined,
        city: city || undefined,
      });
      // Add tags
      if (tags && tags.length > 0) {
        await ghl.addContactTag(COACHING_DEPT_ID, contactId, tags);
      }
      console.log(`Intake: Updated contact ${contactId} for ${full_name}`);
    }

    // 4. Write custom fields
    if (customField && Object.keys(customField).length > 0) {
      const fieldDefsResponse = await ghl.getCustomFields(COACHING_DEPT_ID);
      const fieldDefs = fieldDefsResponse.customFields || [];

      // Build field map: use human-readable names that match GHL custom field names
      const fieldMap = {};
      const fieldNameMapping = {
        preferred_name: 'Preferred Name',
        marital_status: 'Marital Status',
        children_ages: 'Children Ages',
        business_name: 'Business Name',
        current_role: 'Current Role',
        annual_income: 'Annual Income',
        monthly_take_home: 'Monthly Take Home',
        hours_per_week: 'Hours Per Week',
        rating_marriage: 'Rating Marriage',
        rating_parenting: 'Rating Parenting',
        rating_health: 'Rating Health',
        rating_leadership: 'Rating Leadership',
        rating_focus: 'Rating Focus',
        rating_peace: 'Rating Peace',
        energy_drain: 'Energy Drain',
        decision_avoiding: 'Decision Avoiding',
        undisciplined: 'Undisciplined',
        monthly_revenue: 'FF Monthly Revenue Baseline',
        monthly_profit: 'Monthly Profit',
        know_cac: 'Know CAC',
        cac_value: 'CAC Value',
        know_churn: 'Know Churn',
        churn_value: 'Churn Value',
        know_ltv: 'Know LTV',
        ltv_value: 'LTV Value',
        team_count: 'Team Count',
        wrong_team_member: 'Wrong Team Member',
        break_30_days: 'Break 30 Days',
        ff_program: 'FF Program',
        ff_revenue_tier: 'FF Revenue Tier',
        ff_active_members: 'FF Active Member Count',
        ff_monthly_cancellations: 'FF Monthly Cancellations',
        ff_monthly_leads: 'FF Monthly Lead Volume',
        ff_conversion_rate: 'FF Conversion Rate',
        ff_ad_spend: 'FF Ad Spend',
        ff_cpl: 'FF Cost Per Lead',
        ff_operational_control: 'FF Operational Control Rating',
        ff_hours_on_business: 'FF Hours On Business',
        vision_12mo: 'Vision 12 Months',
        vision_3yr: 'Vision 3 Years',
        leader_identity: 'Leader Identity',
        wife_feedback: 'Wife Feedback',
        team_feedback: 'Team Feedback',
        pattern_recurring: 'Pattern Recurring',
        pattern_quit: 'Pattern Quit',
        pattern_persist: 'Pattern Persist',
        pattern_excuses: 'Pattern Excuses',
        pattern_pressure: 'Pattern Pressure',
        non_negotiables: 'Non Negotiables',
        standards_gap: 'Standards Gap',
        one_habit: 'One Habit',
        why_now: 'Why Now',
        stay_the_same: 'Stay The Same',
        rev_90_input: 'Revenue Last 90 Days',
        schedule_input: 'Weekly Schedule',
        org_chart_input: 'Org Chart',
      };

      for (const [formKey, ghlName] of Object.entries(fieldNameMapping)) {
        const value = customField[formKey];
        if (value !== undefined && value !== null && value !== '') {
          fieldMap[ghlName] = value;
        }
      }

      if (Object.keys(fieldMap).length > 0) {
        await ghl.writeFieldsToContact(COACHING_DEPT_ID, contactId, fieldMap, fieldDefs);
        console.log(`Intake: Wrote ${Object.keys(fieldMap).length} custom fields for ${full_name}`);
      }
    }

    // 5. Add intake note with summary
    const noteBody = buildIntakeNote(full_name, req.body);
    await ghl.addContactNote(COACHING_DEPT_ID, contactId, noteBody);
    console.log(`Intake: Added intake note for ${full_name}`);

    // 6. Create/update UserProfile in Base44 to trigger book journey generation
    let base44Result = null;
    try {
      const profileData = buildUserProfile(full_name, email, phone, customField);
      base44Result = await base44.upsertUserProfile(email, profileData);
      console.log(`Intake: ${base44Result.created ? 'Created' : 'Updated'} Base44 UserProfile ${base44Result.id} for ${full_name}`);
    } catch (b44Err) {
      console.error(`Intake: Base44 UserProfile write failed for ${full_name}: ${b44Err.message}`);
      // Don't fail the intake — GHL is the primary record
    }

    res.json({
      success: true,
      message: 'Intake submitted successfully.',
      contactId,
      base44ProfileId: base44Result ? base44Result.id : null,
    });

  } catch (err) {
    console.error('Intake submission failed:', err.message);
    res.status(500).json({ error: 'Failed to process intake. Please try again.' });
  }
});

/**
 * Derive primary_goals, current_challenges, and experience_level
 * from raw intake form answers for Base44 book matching.
 */
function buildUserProfile(fullName, email, phone, cf) {
  cf = cf || {};
  const goals = [];
  const challenges = [];

  // --- Derive primary_goals from ratings and metrics ---
  const revenue = parseFloat(cf.monthly_revenue) || 0;
  const revTier = (cf.ff_revenue_tier || '').toLowerCase();

  if (revenue < 20000 || revTier.includes('under') || revTier.includes('0') || revTier.includes('10')) {
    goals.push('Revenue Growth');
  }
  if (revenue >= 20000 && revenue < 50000) {
    goals.push('Revenue Growth');
  }
  if (revenue >= 50000) {
    goals.push('Profit & Overhead Reduction');
  }

  const rLeadership = parseFloat(cf.rating_leadership) || 10;
  if (rLeadership < 6) goals.push('Leadership Development');

  const rFocus = parseFloat(cf.rating_focus) || 10;
  const rPeace = parseFloat(cf.rating_peace) || 10;
  if (rFocus < 6 || rPeace < 6) goals.push('Mindset & Discipline');

  const rHealth = parseFloat(cf.rating_health) || 10;
  if (rHealth < 6) goals.push('Health & Performance');

  const convRate = parseFloat(cf.ff_conversion_rate) || 100;
  if (convRate < 40) goals.push('Sales & Closing');

  const opControl = parseFloat(cf.ff_operational_control) || 10;
  if (opControl < 6) goals.push('Systems & Operations');

  const rMarriage = parseFloat(cf.rating_marriage) || 10;
  if (rMarriage < 6) goals.push('Faith & Purpose');

  // --- Derive current_challenges ---
  const teamCount = parseInt(cf.team_count) || 0;
  if (rLeadership < 6 || (teamCount > 0 && cf.wrong_team_member)) {
    challenges.push('Team & Leadership');
  }

  if (revenue < 20000 || convRate < 40) {
    challenges.push('Sales & Revenue');
  }

  if (revenue >= 50000 && parseFloat(cf.monthly_profit) < revenue * 0.15) {
    challenges.push('Profit & Overhead');
  }

  const hours = parseFloat(cf.ff_hours_on_business) || 0;
  if (hours > 50 || rFocus < 6 || opControl < 6) {
    challenges.push('Time & Focus');
  }

  if (rMarriage < 6) {
    challenges.push('Marriage & Family');
  }

  if (rPeace < 6 || cf.pattern_excuses || cf.pattern_quit) {
    challenges.push('Mindset & Confidence');
  }

  // --- Derive experience_level from revenue tier / program ---
  let experienceLevel = 'New Business Owner';
  if (revenue >= 50000 || revTier.includes('50') || revTier.includes('100')) {
    experienceLevel = 'Established Business 3+ years';
  } else if (revenue >= 20000 || revTier.includes('20') || revTier.includes('30')) {
    experienceLevel = 'Growing Business 1-3 years';
  }
  if ((cf.ff_program || '').toLowerCase().includes('black circle')) {
    experienceLevel = 'Advanced Operator';
  }

  // Deduplicate
  const uniqueGoals = [...new Set(goals)];
  const uniqueChallenges = [...new Set(challenges)];

  // Guarantee at least one goal/challenge for matching
  if (uniqueGoals.length === 0) uniqueGoals.push('Mindset & Discipline');
  if (uniqueChallenges.length === 0) uniqueChallenges.push('Mindset & Confidence');

  return {
    full_name: fullName,
    phone: phone || '',
    primary_goals: uniqueGoals,
    current_challenges: uniqueChallenges,
    experience_level: experienceLevel,
    // Store key intake metrics for coaching reference
    rating_marriage: cf.rating_marriage || null,
    rating_health: cf.rating_health || null,
    rating_leadership: cf.rating_leadership || null,
    rating_focus: cf.rating_focus || null,
    rating_peace: cf.rating_peace || null,
    rating_parenting: cf.rating_parenting || null,
    monthly_revenue: cf.monthly_revenue || null,
    ff_program: cf.ff_program || null,
    ff_revenue_tier: cf.ff_revenue_tier || null,
    ff_operational_control: cf.ff_operational_control || null,
    ff_hours_on_business: cf.ff_hours_on_business || null,
    // Intake baselines for scorecard comparison
    intake_revenue: cf.monthly_revenue || null,
    intake_profit: cf.monthly_profit || null,
    intake_members: cf.ff_active_members || null,
    intake_leads: cf.ff_monthly_leads || null,
    intake_conversion_rate: cf.ff_conversion_rate || null,
    intake_ad_spend: cf.ff_ad_spend || null,
    intake_cpl: cf.ff_cpl || null,
    intake_hours: cf.ff_hours_on_business || null,
    intake_date: new Date().toISOString().split('T')[0],
    is_active: true,
  };
}

function buildIntakeNote(name, data) {
  const cf = data.customField || {};
  const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  let note = `=== CLIENT INTAKE FORM ===\nSubmitted: ${now}\n\n`;

  // Business Baseline
  note += `--- BUSINESS BASELINE ---\n`;
  if (cf.ff_program) note += `Program: ${cf.ff_program}\n`;
  if (cf.ff_revenue_tier) note += `Revenue Tier: ${cf.ff_revenue_tier}\n`;
  if (cf.monthly_revenue) note += `Monthly Revenue: $${cf.monthly_revenue}\n`;
  if (cf.monthly_profit) note += `Monthly Profit: $${cf.monthly_profit}\n`;
  if (cf.ff_active_members) note += `Active Members: ${cf.ff_active_members}\n`;
  if (cf.ff_monthly_cancellations) note += `Monthly Cancellations: ${cf.ff_monthly_cancellations}\n`;
  if (cf.ff_monthly_leads) note += `Monthly Leads: ${cf.ff_monthly_leads}\n`;
  if (cf.ff_conversion_rate) note += `Conversion Rate: ${cf.ff_conversion_rate}%\n`;
  if (cf.ff_ad_spend) note += `Ad Spend: $${cf.ff_ad_spend}\n`;
  if (cf.ff_cpl) note += `CPL: $${cf.ff_cpl}\n`;
  if (cf.ff_operational_control) note += `Operational Control: ${cf.ff_operational_control}/10\n`;
  if (cf.ff_hours_on_business) note += `Hours ON Business: ${cf.ff_hours_on_business}/week\n`;

  // Self Ratings
  const ratings = ['marriage', 'parenting', 'health', 'leadership', 'focus', 'peace'];
  const hasRatings = ratings.some(r => cf[`rating_${r}`]);
  if (hasRatings) {
    note += `\n--- SELF RATINGS ---\n`;
    for (const r of ratings) {
      if (cf[`rating_${r}`]) note += `${r.charAt(0).toUpperCase() + r.slice(1)}: ${cf[`rating_${r}`]}/10\n`;
    }
  }

  // Current Reality
  if (cf.energy_drain || cf.decision_avoiding || cf.undisciplined) {
    note += `\n--- CURRENT REALITY ---\n`;
    if (cf.energy_drain) note += `Energy Drain: ${cf.energy_drain}\n`;
    if (cf.decision_avoiding) note += `Decision Avoiding: ${cf.decision_avoiding}\n`;
    if (cf.undisciplined) note += `Undisciplined: ${cf.undisciplined}\n`;
  }

  // Vision
  if (cf.vision_12mo || cf.vision_3yr) {
    note += `\n--- VISION ---\n`;
    if (cf.vision_12mo) note += `12-Month: ${cf.vision_12mo}\n`;
    if (cf.vision_3yr) note += `3-Year: ${cf.vision_3yr}\n`;
  }

  // Why Now
  if (cf.why_now) {
    note += `\n--- WHY NOW ---\n${cf.why_now}\n`;
  }

  return note;
}

module.exports = router;
