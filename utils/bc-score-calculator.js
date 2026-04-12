/**
 * Black Circle Score Calculator
 * Implements the 11-metric Black Circle scoring model.
 * Total: 100 points across 3 categories.
 *
 * Black Circle is the premium tier for gym owners who graduated from
 * Freedom Formula. The focus shifts from operational basics to scaling,
 * leadership, and building a business that grows without them.
 */

/**
 * Calculate the complete health score for a Black Circle client.
 * @param {object} data — All metric inputs collected by the scoring engine
 * @returns {{ total: number, breakdown: object, dangerTriggers: string[] }}
 */
function calculateBCScore(data) {
  const breakdown = {};
  const dangerTriggers = [];

  // ─── CATEGORY 1: LEADERSHIP & GROWTH (35 pts) ───

  // Metric 1: Action item completion (15 pts)
  // Did they execute the assignments from their coaching call?
  breakdown.actionCompletion = scoreActionCompletion(data.actionCompletionRate);

  // Metric 2: Team development score (10 pts)
  // Self-reported: are they building leaders, not just managing staff?
  breakdown.teamDevelopment = scoreTeamDevelopment(data.teamDevelopmentRating);

  // Metric 3: Owner hours in CEO role (10 pts)
  // Time spent ON the business (strategy, leadership) vs IN it (operations)
  breakdown.ceoHours = scoreCEOHours(data.ceoHoursThisWeek);

  // ─── CATEGORY 2: FINANCIAL PERFORMANCE (40 pts) ───

  // Metric 4: Revenue growth vs target (15 pts)
  // Higher bar than FF — measuring growth trajectory, not just stability
  breakdown.revenueGrowth = scoreRevenueGrowth(data.weeklyRevenue, data.revenueTarget);

  // Metric 5: Profit margin trend (10 pts)
  // Not just top line — are they building a profitable machine?
  breakdown.profitMargin = scoreProfitMargin(data.profitMarginThisWeek, data.profitMargin4WeekAvg);

  // Metric 6: Lead volume & conversion (10 pts)
  // Combined metric — condensed from FF's separate lead + conversion metrics
  breakdown.leadConversion = scoreLeadConversion(
    data.weeklyLeads,
    data.leadVolume4WeekAvg,
    data.conversionRateThisWeek,
    data.conversionRate4WeekAvg
  );

  // Metric 7: LTV / retention (5 pts)
  // Member lifetime value via retention rate — are they keeping clients?
  breakdown.retention = scoreRetention(data.memberRetentionRate);

  // ─── CATEGORY 3: ACCOUNTABILITY & ENGAGEMENT (25 pts) ───

  // Metric 8: Weekly check-in submitted (10 pts)
  breakdown.formSubmission = scoreFormSubmission(data.formSubmittedTimestamp, data.scoringWindowEnd);

  // Metric 9: Coaching call attendance (10 pts)
  breakdown.coachingCall = scoreCoachingCall(data.appointmentDisposition);

  // Metric 10: Peer contribution (5 pts)
  // "Who did you help this week?" — Black Circle members give back
  breakdown.peerContribution = scorePeerContribution(data.peerContributionResponse);

  // ─── TOTAL ───
  const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

  // ─── DANGER ZONE TRIGGERS ───
  // BC has higher thresholds — these are advanced operators
  if (total < 45) {
    dangerTriggers.push(`Score below 45 (${total})`);
  }
  if (data.lastWeekScore !== null && data.lastWeekScore < 60 && total < 60) {
    dangerTriggers.push(`Score below 60 for two consecutive weeks (${data.lastWeekScore} -> ${total})`);
  }
  if (data.consecutiveMissedForms >= 2) {
    dangerTriggers.push(`Consecutive missed forms: ${data.consecutiveMissedForms}`);
  }
  if (data.consecutiveMissedCalls >= 2) {
    dangerTriggers.push(`Consecutive missed calls: ${data.consecutiveMissedCalls}`);
  }
  // BC-specific: revenue below target for 3+ weeks
  if (data.weeksUnderRevenueTarget >= 3) {
    dangerTriggers.push(`Revenue below target for ${data.weeksUnderRevenueTarget} consecutive weeks`);
  }

  return { total, breakdown, dangerTriggers };
}

// ─── Individual Metric Scorers ───

// CATEGORY 1: LEADERSHIP & GROWTH

function scoreActionCompletion(completionRate) {
  // completionRate: 0-1 ratio of completed/total action items from Base44
  if (completionRate === null || completionRate === undefined) return 0;
  if (completionRate >= 1) return 15;    // all items complete
  if (completionRate >= 0.75) return 12;  // 75%+ complete
  if (completionRate >= 0.5) return 8;    // 50%+ complete
  if (completionRate > 0) return 4;       // started but less than half
  return 0;                               // nothing complete
}

function scoreTeamDevelopment(rating) {
  if (rating === null || rating === undefined || rating === '') return 0;
  const r = Number(rating);
  if (r >= 8) return 10;
  if (r >= 6) return 7;
  if (r >= 4) return 4;
  if (r >= 1) return 2;
  return 0;
}

function scoreCEOHours(hours) {
  if (hours === null || hours === undefined || hours === '') return 0;
  const h = Number(hours);
  if (h >= 15) return 10; // 15+ hours in CEO/strategy mode
  if (h >= 10) return 7;
  if (h >= 5) return 4;
  if (h >= 1) return 2;
  return 0;
}

// CATEGORY 2: FINANCIAL PERFORMANCE

function scoreRevenueGrowth(weeklyRevenue, revenueTarget) {
  if (weeklyRevenue === null || revenueTarget === null || revenueTarget === 0) return 8;
  const pctOfTarget = weeklyRevenue / revenueTarget;
  if (pctOfTarget >= 1.0) return 15;  // Hit or exceeded target
  if (pctOfTarget >= 0.90) return 10; // Within 10% of target
  if (pctOfTarget >= 0.75) return 5;  // Within 25%
  return 0;
}

function scoreProfitMargin(thisWeek, avg4Week) {
  if (thisWeek === null || avg4Week === null || avg4Week === 0) return 5;
  const change = (thisWeek - avg4Week) / avg4Week;
  if (change > 0) return 10;         // Margin improving
  if (Math.abs(change) <= 0.05) return 5; // Stable (within 5%)
  return 0;                           // Margin declining
}

function scoreLeadConversion(weeklyLeads, leadAvg, convRate, convAvg) {
  let points = 0;

  // Lead volume component (5 pts)
  if (weeklyLeads === null || leadAvg === null || leadAvg === 0) {
    points += 3;
  } else {
    const leadChange = (weeklyLeads - leadAvg) / leadAvg;
    if (leadChange > 0) points += 5;
    else if (Math.abs(leadChange) <= 0.10) points += 3;
  }

  // Conversion rate component (5 pts)
  if (convRate === null || convAvg === null || convAvg === 0) {
    points += 3;
  } else {
    const convChange = (convRate - convAvg) / convAvg;
    if (convChange > 0) points += 5;
    else if (Math.abs(convChange) <= 0.05) points += 3;
  }

  return points;
}

function scoreRetention(retentionRate) {
  if (retentionRate === null || retentionRate === undefined || retentionRate === '') return 3;
  const r = Number(retentionRate);
  if (r >= 90) return 5;  // 90%+ retention is elite
  if (r >= 80) return 3;
  if (r >= 70) return 1;
  return 0;
}

// CATEGORY 3: ACCOUNTABILITY & ENGAGEMENT

function scoreFormSubmission(submittedTimestamp, scoringWindowEnd) {
  if (!submittedTimestamp) return 0;

  const submitted = new Date(submittedTimestamp);
  const windowEnd = new Date(scoringWindowEnd);

  // Wednesday 11:59pm deadline
  const wednesday = new Date(windowEnd);
  wednesday.setDate(wednesday.getDate() - (wednesday.getDay() === 0 ? 4 : wednesday.getDay() - 3));
  wednesday.setHours(23, 59, 59, 999);

  // Sunday 9:00am deadline
  const sundayDeadline = new Date(windowEnd);
  sundayDeadline.setHours(9, 0, 0, 0);

  if (submitted <= wednesday) return 10;
  if (submitted <= sundayDeadline) return 5;
  return 0;
}

function scoreCoachingCall(disposition) {
  if (!disposition) return 0;
  const d = disposition.toLowerCase();
  if (d === 'attended' || d === 'completed' || d === 'showed') return 10;
  if (d === 'rescheduled') return 5;
  return 0; // no-show, same-day cancel, etc.
}

function scorePeerContribution(response) {
  if (!response || response.trim() === '') return 0;
  // Any substantive answer earns full points — they're engaging with the community
  if (response.trim().length >= 10) return 5;
  return 2; // minimal response
}

/**
 * Determine score status label and color.
 * Same thresholds as FF for consistency in dashboards.
 */
function getBCScoreStatus(score) {
  if (score >= 80) return { label: 'Green', description: 'Scaling', color: '#22C55E' };
  if (score >= 60) return { label: 'Yellow', description: 'Watch', color: '#EAB308' };
  if (score >= 40) return { label: 'Orange', description: 'At Risk', color: '#F97316' };
  return { label: 'Red', description: 'Danger Zone', color: '#EF4444' };
}

module.exports = {
  calculateBCScore,
  getBCScoreStatus,
};
