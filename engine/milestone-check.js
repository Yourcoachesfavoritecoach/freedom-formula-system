/**
 * Milestone Check
 * Runs every day at 8:00am via cron.
 * Checks FF Cycle Start Date for each client and triggers
 * 30-day, 60-day, and 90-day milestone actions.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ghl = require('../utils/ghl-api');
const { getScoreStatus } = require('../utils/score-calculator');
const { getCustomFieldValue } = require('../utils/rolling-averages');
const { onboardNewClients } = require('./onboard-client');

const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;

function loadRegistry() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);

  // Register each client's sub-account API key
  for (const client of registry.clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }

  return registry.clients.filter((c) => c.program === 'Freedom Formula' && c.ghl_location_id !== 'USMAN_FILLS_THIS');
}

function loadTemplate(name) {
  return fs.readFileSync(path.resolve(__dirname, `../templates/${name}`), 'utf8');
}

function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ─── Upgrade Criteria Check ───

function checkUpgradeCriteria(data) {
  const { revenueTier, weeklyRevenue, baseline, opControlRating, hoursRunningTotal, weeksActive, score } = data;
  const results = { criteria1: false, criteria2: false, criteria3: false, details: [] };

  // Criteria 1: Revenue target based on tier
  const revenueGain = weeklyRevenue - baseline;
  let revenueTarget = { min: 0, max: 0 };

  if (revenueTier === 'Under 20k') {
    revenueTarget = { min: 3000, max: 5000 };
  } else if (revenueTier === '20k-50k') {
    revenueTarget = { min: 5000, max: 10000 };
  } else if (revenueTier === '50k+') {
    revenueTarget = { min: 10000, max: 20000 };
  }

  if (revenueGain >= revenueTarget.min && revenueGain <= revenueTarget.max) {
    results.criteria1 = true;
    results.details.push(`Revenue gain: $${revenueGain} (target: $${revenueTarget.min}-$${revenueTarget.max})`);
  } else if (revenueGain > revenueTarget.max) {
    results.criteria1 = true;
    results.details.push(`Revenue gain: $${revenueGain} (exceeded target)`);
  } else {
    results.details.push(`Revenue gain: $${revenueGain} (below target of $${revenueTarget.min})`);
  }

  // Criteria 2: Operational floor
  const opControlStrong = opControlRating >= 7; // Rating 7+ indicates operational control
  const avgHoursPerWeek = weeksActive > 0 ? hoursRunningTotal / weeksActive : 0;
  let hoursTarget = 5;

  if (revenueTier === '20k-50k') hoursTarget = 10;
  else if (revenueTier === '50k+') hoursTarget = 15;

  if (opControlStrong && avgHoursPerWeek >= hoursTarget) {
    results.criteria2 = true;
    results.details.push(`Op control rating: ${opControlRating}/10. Avg hours reclaimed: ${avgHoursPerWeek.toFixed(1)}/wk (target: ${hoursTarget})`);
  } else {
    results.details.push(`Op control rating: ${opControlRating}/10 (need 7+). Avg hours: ${avgHoursPerWeek.toFixed(1)}/wk (need: ${hoursTarget})`);
  }

  // Criteria 3: Health score 75+
  if (score >= 75) {
    results.criteria3 = true;
    results.details.push(`Score: ${score} (threshold: 75)`);
  } else {
    results.details.push(`Score: ${score} (below 75 threshold)`);
  }

  results.allMet = results.criteria1 && results.criteria2 && results.criteria3;
  return results;
}

// ─── Milestone Actions ───

async function handle30Day(client, fieldDefs, cdFieldDefs) {
  const mirrorId = client.coaching_dept_mirror_contact_id;
  const loc = client.ghl_location_id;

  console.log(`  30-DAY MILESTONE: ${client.name}`);

  // Create task
  await ghl.createTask(COACHING_DEPT_ID, mirrorId, {
    title: `30-Day Review - ${client.name} - check org chart progress and hours reclaimed`,
    dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    completed: false,
  });

  // Read score for email
  const mirrorData = await ghl.getContact(COACHING_DEPT_ID, mirrorId);
  const score = parseFloat(getCustomFieldValue(mirrorData, 'FF Health Score This Week', cdFieldDefs) || 0);
  const status = getScoreStatus(score);

  // Send milestone email
  const template = loadTemplate('milestone-email.html');
  const contactData = await ghl.getContact(loc, client.ff_contact_id);
  const contact = contactData.contact || contactData;

  const html = template
    .replace(/\{\{CLIENT_NAME\}\}/g, client.name)
    .replace(/\{\{MILESTONE\}\}/g, '30')
    .replace(/\{\{SCORE\}\}/g, score)
    .replace(/\{\{STATUS_LABEL\}\}/g, `${status.label} / ${status.description}`)
    .replace(/\{\{STATUS_COLOR\}\}/g, status.color)
    .replace(/\{\{MILESTONE_BODY\}\}/g,
      `<p>You are 30 days into Freedom Formula. This is where the foundation gets tested.</p>
       <p>Your current score is <strong>${score}/100</strong>. Your org chart progress and hours reclaimed are the two metrics that tell us if you are building something real or just going through the motions.</p>
       <p>Stay locked in. The next 60 days determine everything.</p>`)
    .replace(/\{\{CLIENT_EMAIL\}\}/g, contact.email || '')
    .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, '{{unsubscribe_link}}');

  await ghl.sendEmail(COACHING_DEPT_ID, {
    type: 'Email',
    contactId: mirrorId,
    subject: `30 Days In - Here Is Where You Stand`,
    html,
    emailFrom: process.env.SENDER_EMAIL || 'team@thecoachingdept.com',
  });

  // Move pipeline stage to 30-Day Check-In
  try {
    const pipelines = await ghl.getPipelines(COACHING_DEPT_ID);
    const ffPipeline = (pipelines.pipelines || []).find((p) => p.name === 'Freedom Formula');
    if (ffPipeline) {
      const stage = ffPipeline.stages.find((s) => s.name.includes('30-Day'));
      if (stage) {
        const opps = await ghl.getOpportunitiesByContact(COACHING_DEPT_ID, mirrorId);
        if (opps.opportunities && opps.opportunities.length > 0) {
          await ghl.updateOpportunity(COACHING_DEPT_ID, opps.opportunities[0].id, {
            pipelineStageId: stage.id,
          });
        }
      }
    }
  } catch (err) {
    console.log(`  Warning: Could not update pipeline stage - ${err.message}`);
  }
}

async function handle60Day(client, fieldDefs, cdFieldDefs) {
  const mirrorId = client.coaching_dept_mirror_contact_id;
  const loc = client.ghl_location_id;

  console.log(`  60-DAY MILESTONE: ${client.name}`);

  // Create task assigned to Dave
  await ghl.createTask(COACHING_DEPT_ID, mirrorId, {
    title: `60-Day Review - ${client.name} - identify upgrade track or intervention need - assigned to Dave`,
    dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    completed: false,
  });

  // Check for danger zone trigger
  const mirrorData = await ghl.getContact(COACHING_DEPT_ID, mirrorId);
  const score = parseFloat(getCustomFieldValue(mirrorData, 'FF Health Score This Week', cdFieldDefs) || 0);
  const lastWeekScore = parseFloat(getCustomFieldValue(mirrorData, 'FF Health Score Last Week', cdFieldDefs) || 0);
  const dangerActive = getCustomFieldValue(mirrorData, 'FF Danger Zone Active', cdFieldDefs) === 'true';
  const status = getScoreStatus(score);

  // Danger trigger: below 60 for two consecutive weeks and not already active
  if (score < 60 && lastWeekScore < 60 && !dangerActive) {
    console.log(`  Triggering Danger Zone at 60-day mark`);
    await ghl.addContactTag(loc, client.ff_contact_id, ['FF-Danger']);
    await ghl.writeFieldsToContact(loc, client.ff_contact_id, {
      'FF Danger Zone Active': 'true',
    }, fieldDefs);
    await ghl.addContactNote(loc, client.ff_contact_id,
      `Danger Zone activated at 60-day milestone - Score below 60 for two weeks - ${todayStr()}`);
  }

  // Send email
  const template = loadTemplate('milestone-email.html');
  const contactData = await ghl.getContact(loc, client.ff_contact_id);
  const contact = contactData.contact || contactData;

  const html = template
    .replace(/\{\{CLIENT_NAME\}\}/g, client.name)
    .replace(/\{\{MILESTONE\}\}/g, '60')
    .replace(/\{\{SCORE\}\}/g, score)
    .replace(/\{\{STATUS_LABEL\}\}/g, `${status.label} / ${status.description}`)
    .replace(/\{\{STATUS_COLOR\}\}/g, status.color)
    .replace(/\{\{MILESTONE_BODY\}\}/g,
      `<p>60 days in. Your 90-day target is close.</p>
       <p>Your current score is <strong>${score}/100</strong>. At this point we are looking at whether you are on an upgrade track or need intervention.</p>
       <p>Here is your current standing. Make the next 30 days count.</p>`)
    .replace(/\{\{CLIENT_EMAIL\}\}/g, contact.email || '')
    .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, '{{unsubscribe_link}}');

  await ghl.sendEmail(COACHING_DEPT_ID, {
    type: 'Email',
    contactId: mirrorId,
    subject: `60 Days In - Your 90-Day Target Is Close`,
    html,
    emailFrom: process.env.SENDER_EMAIL || 'team@thecoachingdept.com',
  });

  // Move pipeline stage
  try {
    const pipelines = await ghl.getPipelines(COACHING_DEPT_ID);
    const ffPipeline = (pipelines.pipelines || []).find((p) => p.name === 'Freedom Formula');
    if (ffPipeline) {
      const stage = ffPipeline.stages.find((s) => s.name.includes('60-Day'));
      if (stage) {
        const opps = await ghl.getOpportunitiesByContact(COACHING_DEPT_ID, mirrorId);
        if (opps.opportunities && opps.opportunities.length > 0) {
          await ghl.updateOpportunity(COACHING_DEPT_ID, opps.opportunities[0].id, {
            pipelineStageId: stage.id,
          });
        }
      }
    }
  } catch (err) {
    console.log(`  Warning: Could not update pipeline stage - ${err.message}`);
  }
}

async function handle90Day(client, fieldDefs, cdFieldDefs) {
  const mirrorId = client.coaching_dept_mirror_contact_id;
  const loc = client.ghl_location_id;

  console.log(`  90-DAY REVIEW: ${client.name}`);

  // Move to Stage 7: 90-Day Review
  try {
    const pipelines = await ghl.getPipelines(COACHING_DEPT_ID);
    const ffPipeline = (pipelines.pipelines || []).find((p) => p.name === 'Freedom Formula');
    if (ffPipeline) {
      const stage = ffPipeline.stages.find((s) => s.name.includes('90-Day'));
      if (stage) {
        const opps = await ghl.getOpportunitiesByContact(COACHING_DEPT_ID, mirrorId);
        if (opps.opportunities && opps.opportunities.length > 0) {
          await ghl.updateOpportunity(COACHING_DEPT_ID, opps.opportunities[0].id, {
            pipelineStageId: stage.id,
          });
        }
      }
    }
  } catch (err) {
    console.log(`  Warning: Could not update pipeline stage - ${err.message}`);
  }

  // Create review task
  await ghl.createTask(COACHING_DEPT_ID, mirrorId, {
    title: `90-Day Review Call - schedule within 7 days - ${client.name}`,
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    completed: false,
  });

  // Read full data for upgrade check
  const mirrorData = await ghl.getContact(COACHING_DEPT_ID, mirrorId);
  const score = parseFloat(getCustomFieldValue(mirrorData, 'FF Health Score This Week', cdFieldDefs) || 0);
  const status = getScoreStatus(score);

  const contactData = await ghl.getContact(loc, client.ff_contact_id);
  const weeklyRevenue = parseFloat(getCustomFieldValue(contactData, 'FF Weekly Revenue', fieldDefs) || 0);
  const baseline = parseFloat(getCustomFieldValue(contactData, 'FF Monthly Revenue Baseline', fieldDefs) || 0);
  const revenueTier = getCustomFieldValue(contactData, 'FF Revenue Tier', fieldDefs) || 'Under 20k';
  const opControlRating = parseFloat(getCustomFieldValue(contactData, 'FF Operational Control Rating', fieldDefs) || 0);
  const hoursRunningTotal = parseFloat(getCustomFieldValue(contactData, 'FF Hours Reclaimed Running Total', fieldDefs) || 0);
  const cycleStartDate = getCustomFieldValue(contactData, 'FF Cycle Start Date', fieldDefs);
  const weeksActive = cycleStartDate ? Math.floor(daysBetween(cycleStartDate, new Date()) / 7) : 12;
  const cycleNumber = parseInt(getCustomFieldValue(contactData, 'FF Current Cycle Number', fieldDefs) || 1);

  // Log full score summary
  await ghl.addContactNote(loc, client.ff_contact_id,
    `90-Day Review Summary - ${todayStr()}\n` +
    `Score: ${score}/100 (${status.label})\n` +
    `Revenue: $${weeklyRevenue} (Baseline: $${baseline})\n` +
    `Revenue Tier: ${revenueTier}\n` +
    `Op Control: ${opControlRating}/10\n` +
    `Hours Reclaimed Total: ${hoursRunningTotal}\n` +
    `Cycle: ${cycleNumber}`);

  // Send client email
  const template = loadTemplate('milestone-email.html');
  const contact = contactData.contact || contactData;

  const html = template
    .replace(/\{\{CLIENT_NAME\}\}/g, client.name)
    .replace(/\{\{MILESTONE\}\}/g, '90')
    .replace(/\{\{SCORE\}\}/g, score)
    .replace(/\{\{STATUS_LABEL\}\}/g, `${status.label} / ${status.description}`)
    .replace(/\{\{STATUS_COLOR\}\}/g, status.color)
    .replace(/\{\{MILESTONE_BODY\}\}/g,
      `<p>Your 90-day review is here. Let us look at your numbers.</p>
       <p>Your current score is <strong>${score}/100</strong>. We will be reaching out to schedule your review call within the next 7 days.</p>
       <p>Come prepared to talk about what is working, what is not, and where you want to go next.</p>`)
    .replace(/\{\{CLIENT_EMAIL\}\}/g, contact.email || '')
    .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, '{{unsubscribe_link}}');

  await ghl.sendEmail(COACHING_DEPT_ID, {
    type: 'Email',
    contactId: mirrorId,
    subject: `Your 90-Day Review Is Here`,
    html,
    emailFrom: process.env.SENDER_EMAIL || 'team@thecoachingdept.com',
  });

  // ─── Check Upgrade Criteria ───

  const upgrade = checkUpgradeCriteria({
    revenueTier,
    weeklyRevenue,
    baseline,
    opControlRating,
    hoursRunningTotal,
    weeksActive,
    score,
  });

  console.log(`  Upgrade criteria: ${upgrade.allMet ? 'ALL MET' : 'NOT MET'}`);
  for (const detail of upgrade.details) {
    console.log(`    ${detail}`);
  }

  if (upgrade.allMet) {
    // ─── Upgrade Path ───
    console.log(`  Moving to Upgrade Eligible`);

    await ghl.addContactTag(loc, client.ff_contact_id, ['FF-Upgrade-Eligible']);
    await ghl.addContactTag(COACHING_DEPT_ID, mirrorId, ['FF-Upgrade-Eligible']);

    // Move to Stage 9
    try {
      const pipelines = await ghl.getPipelines(COACHING_DEPT_ID);
      const ffPipeline = (pipelines.pipelines || []).find((p) => p.name === 'Freedom Formula');
      if (ffPipeline) {
        const stage = ffPipeline.stages.find((s) => s.name.includes('Upgrade Eligible'));
        if (stage) {
          const opps = await ghl.getOpportunitiesByContact(COACHING_DEPT_ID, mirrorId);
          if (opps.opportunities && opps.opportunities.length > 0) {
            await ghl.updateOpportunity(COACHING_DEPT_ID, opps.opportunities[0].id, {
              pipelineStageId: stage.id,
            });
          }
        }
      }
    } catch (err) {
      console.log(`  Warning: Could not update pipeline stage - ${err.message}`);
    }

    // Create task for Dave
    await ghl.createTask(COACHING_DEPT_ID, mirrorId, {
      title: `Black Circle invite ready for Dave's review - ${client.name} - do not send without his approval`,
      dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      completed: false,
    });

    // Internal alert
    await ghl.addContactNote(COACHING_DEPT_ID, mirrorId,
      `UPGRADE ELIGIBLE - All 3 criteria met - ${todayStr()}\n${upgrade.details.join('\n')}`);

  } else {
    // ─── Renewal Path ───
    console.log(`  Moving to Renewal - Continuing`);

    // Move to Stage 8
    try {
      const pipelines = await ghl.getPipelines(COACHING_DEPT_ID);
      const ffPipeline = (pipelines.pipelines || []).find((p) => p.name === 'Freedom Formula');
      if (ffPipeline) {
        const stage = ffPipeline.stages.find((s) => s.name.includes('Renewal'));
        if (stage) {
          const opps = await ghl.getOpportunitiesByContact(COACHING_DEPT_ID, mirrorId);
          if (opps.opportunities && opps.opportunities.length > 0) {
            await ghl.updateOpportunity(COACHING_DEPT_ID, opps.opportunities[0].id, {
              pipelineStageId: stage.id,
            });
          }
        }
      }
    } catch (err) {
      console.log(`  Warning: Could not update pipeline stage - ${err.message}`);
    }

    // Increment cycle
    const newCycleNumber = cycleNumber + 1;
    await ghl.writeFieldsToContact(loc, client.ff_contact_id, {
      'FF Current Cycle Number': newCycleNumber,
      'FF Cycle Start Date': todayStr(),
      'FF Days Until Next Milestone': 90,
    }, fieldDefs);

    // Apply cycle tag
    const cycleTag = `FF-Cycle-${newCycleNumber}`;
    await ghl.addContactTag(loc, client.ff_contact_id, [cycleTag]);
    await ghl.addContactTag(COACHING_DEPT_ID, mirrorId, [cycleTag]);

    // Send renewal confirmation
    const renewalHtml = template
      .replace(/\{\{CLIENT_NAME\}\}/g, client.name)
      .replace(/\{\{MILESTONE\}\}/g, '90')
      .replace(/\{\{SCORE\}\}/g, score)
      .replace(/\{\{STATUS_LABEL\}\}/g, `${status.label} / ${status.description}`)
      .replace(/\{\{STATUS_COLOR\}\}/g, status.color)
      .replace(/\{\{MILESTONE_BODY\}\}/g,
        `<p>Your next 90-day cycle starts now. Cycle ${newCycleNumber} is locked in.</p>
         <p>You know the process. Keep executing. The score does not lie.</p>`)
      .replace(/\{\{CLIENT_EMAIL\}\}/g, contact.email || '')
      .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, '{{unsubscribe_link}}');

    await ghl.sendEmail(COACHING_DEPT_ID, {
      type: 'Email',
      contactId: mirrorId,
      subject: `Cycle ${newCycleNumber} Starts Now - Freedom Formula`,
      html: renewalHtml,
      emailFrom: process.env.SENDER_EMAIL || 'team@thecoachingdept.com',
    });

    await ghl.addContactNote(loc, client.ff_contact_id,
      `Renewed to Cycle ${newCycleNumber} - ${todayStr()}\nUpgrade criteria not met:\n${upgrade.details.join('\n')}`);
  }
}

// ─── Main Runner ───

async function run() {
  console.log('=== Daily Milestone Check ===');
  console.log(`Run time: ${new Date().toISOString()}`);

  // Auto-onboard any new clients added to registry
  await onboardNewClients();

  const clients = loadRegistry();
  console.log(`Checking ${clients.length} Freedom Formula clients`);

  if (clients.length === 0) {
    console.log('No clients in registry. Exiting.');
    return;
  }

  // Load Coaching Dept field defs once
  const cdFieldDefsResponse = await ghl.getCustomFields(COACHING_DEPT_ID);
  const cdFieldDefs = cdFieldDefsResponse.customFields || [];

  for (const client of clients) {
    try {
      const loc = client.ghl_location_id;

      // Load client field defs
      const fieldDefsResponse = await ghl.getCustomFields(loc);
      const fieldDefs = fieldDefsResponse.customFields || [];

      // Read cycle start date
      const contactData = await ghl.getContact(loc, client.ff_contact_id);
      const cycleStartDate = getCustomFieldValue(contactData, 'FF Cycle Start Date', fieldDefs);

      if (!cycleStartDate) {
        console.log(`  ${client.name}: No cycle start date set, skipping`);
        continue;
      }

      const daysIn = daysBetween(cycleStartDate, new Date());

      // Update days until next milestone
      let nextMilestone = 30;
      if (daysIn >= 30 && daysIn < 60) nextMilestone = 60;
      else if (daysIn >= 60 && daysIn < 90) nextMilestone = 90;
      else if (daysIn >= 90) nextMilestone = 0;

      const daysUntil = Math.max(0, nextMilestone - daysIn);
      await ghl.writeFieldsToContact(loc, client.ff_contact_id, {
        'FF Days Until Next Milestone': daysUntil,
      }, fieldDefs);
      await ghl.writeFieldsToContact(COACHING_DEPT_ID, client.coaching_dept_mirror_contact_id, {
        'FF Days Until Next Milestone': daysUntil,
      }, cdFieldDefs);

      console.log(`  ${client.name}: Day ${daysIn} of cycle (${daysUntil} days to next milestone)`);

      // Trigger milestones on exact days
      if (daysIn === 30) {
        await handle30Day(client, fieldDefs, cdFieldDefs);
      } else if (daysIn === 60) {
        await handle60Day(client, fieldDefs, cdFieldDefs);
      } else if (daysIn === 90) {
        await handle90Day(client, fieldDefs, cdFieldDefs);
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`  FAILED: ${client.name} - ${err.message}`);
    }
  }

  console.log('\n=== Milestone Check Complete ===');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Milestone check failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
