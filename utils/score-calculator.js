/**
 * Score Calculator
 * Implements the 11-metric Freedom Formula scoring model.
 * Total: 100 points across 3 categories.
 */

/**
 * Calculate the complete health score for a client.
 * @param {object} data — All metric inputs collected by the scoring engine
 * @returns {{ total: number, breakdown: object, dangerTriggers: string[] }}
 */
function calculateScore(data) {
  const breakdown = {};
  const dangerTriggers = [];

  // ─── CATEGORY 1: ENGAGEMENT (25 pts) ───

  // Metric 1: Weekly form submitted (10 pts)
  breakdown.formSubmission = scoreFormSubmission(data.formSubmittedTimestamp, data.scoringWindowEnd);

  // Metric 2: Coaching call attendance (10 pts)
  breakdown.coachingCall = scoreCoachingCall(data.appointmentDisposition);

  // Metric 3: Outreach response (5 pts)
  breakdown.outreachResponse = scoreOutreachResponse(
    data.lastOutboundTimestamp,
    data.lastInboundTimestamp,
    data.outreachSentThisWeek
  );

  // ─── CATEGORY 2: OPERATIONAL PROGRESS (35 pts) ───

  // Metric 4: Operational control rating (10 pts)
  breakdown.opControl = scoreOpControl(data.operationalControlRating);

  // Metric 5: Weekly KPIs populated (10 pts)
  breakdown.weeklyKPIs = scoreWeeklyKPIs(data.kpiFields);

  // Metric 6: Action item completion (10 pts)
  breakdown.actionCompletion = scoreActionCompletion(data.actionCompletionRate);

  // Metric 7: Hours reclaimed (5 pts)
  breakdown.hoursReclaimed = scoreHoursReclaimed(data.hoursReclaimedThisWeek);

  // ─── CATEGORY 3: BUSINESS PERFORMANCE (40 pts) ───

  // Metric 8: Revenue vs baseline (15 pts)
  breakdown.revenue = scoreRevenueTrend(data.weeklyRevenue, data.revenue4WeekAvg);

  // Metric 9: Lead volume trend (10 pts)
  breakdown.leadVolume = scoreLeadVolume(data.weeklyLeads, data.leadVolume4WeekAvg);

  // Metric 10: Conversion rate (10 pts)
  breakdown.conversionRate = scoreConversionRate(
    data.conversionRateThisWeek,
    data.conversionRate4WeekAvg
  );

  // Metric 11: Blended CPL trend (5 pts)
  breakdown.blendedCPL = scoreBlendedCPL(data.blendedCPLThisWeek, data.blendedCPL4WeekAvg);

  // ─── TOTAL ───
  const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

  // ─── DANGER ZONE TRIGGERS ───
  if (total < 40) {
    dangerTriggers.push(`Score below 40 (${total})`);
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

  return { total, breakdown, dangerTriggers };
}

// ─── Individual Metric Scorers ───

function scoreFormSubmission(submittedTimestamp, scoringWindowEnd) {
  if (!submittedTimestamp) return 0;

  const submitted = new Date(submittedTimestamp);
  const windowEnd = new Date(scoringWindowEnd);

  // Calculate Wednesday 11:59pm of the scoring week
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

function scoreOutreachResponse(lastOutbound, lastInbound, outreachSentThisWeek) {
  if (!outreachSentThisWeek) return 5; // no outreach sent = auto 5

  if (!lastOutbound) return 5;
  if (!lastInbound) return 0;

  const outTime = new Date(lastOutbound).getTime();
  const inTime = new Date(lastInbound).getTime();
  const hoursDiff = (inTime - outTime) / (1000 * 60 * 60);

  if (hoursDiff <= 48) return 5;
  if (hoursDiff > 48) return 2;
  return 0;
}

function scoreOpControl(rating) {
  if (rating === null || rating === undefined || rating === '') return 0;
  const r = Number(rating);
  if (r >= 8) return 10;
  if (r >= 6) return 7;
  if (r >= 4) return 4;
  if (r >= 1) return 2;
  return 0;
}

function scoreWeeklyKPIs(kpiFields) {
  // kpiFields: { revenue, leads, newMembers, cancellations, activeMemberCount }
  if (!kpiFields) return 0;
  let populated = 0;
  for (const val of Object.values(kpiFields)) {
    if (val !== null && val !== undefined && val !== '') populated++;
  }
  if (populated >= 5) return 10;
  if (populated >= 3) return 5;
  return 0;
}

function scoreActionCompletion(completionRate) {
  // completionRate: 0-1 ratio of completed/total action items from Base44
  if (completionRate === null || completionRate === undefined) return 0; // no actions assigned
  if (completionRate >= 1) return 10;   // all items complete
  if (completionRate >= 0.75) return 8;  // 75%+ complete
  if (completionRate >= 0.5) return 5;   // 50%+ complete
  if (completionRate > 0) return 2;      // started but less than half
  return 0;                              // nothing complete
}

function scoreHoursReclaimed(hours) {
  if (hours === null || hours === undefined || hours === '') return 0;
  const h = Number(hours);
  if (h >= 5) return 5;
  if (h >= 1) return 3;
  return 0;
}

function scoreRevenueTrend(weeklyRevenue, avg4Week) {
  if (weeklyRevenue === null || avg4Week === null || avg4Week === 0) return 8;
  const change = (weeklyRevenue - avg4Week) / avg4Week;
  if (change > 0) return 15;
  if (Math.abs(change) <= 0.05) return 8;
  return 0;
}

function scoreLeadVolume(weeklyLeads, avg4Week) {
  if (weeklyLeads === null || avg4Week === null || avg4Week === 0) return 6;
  const change = (weeklyLeads - avg4Week) / avg4Week;
  if (change > 0) return 10;
  if (Math.abs(change) <= 0.10) return 6;
  return 0;
}

function scoreConversionRate(thisWeek, avg4Week) {
  if (thisWeek === null || avg4Week === null || avg4Week === 0) return 6;
  const change = (thisWeek - avg4Week) / avg4Week;
  if (change > 0) return 10;
  if (Math.abs(change) <= 0.05) return 6;
  return 0;
}

function scoreBlendedCPL(thisWeek, avg4Week) {
  if (thisWeek === null || avg4Week === null || avg4Week === 0) return 5;
  const change = (thisWeek - avg4Week) / avg4Week;
  if (change <= 0) return 5; // improved or stable
  if (change <= 0.20) return 2;
  return 0;
}

/**
 * Determine score status label and color.
 */
function getScoreStatus(score) {
  if (score >= 80) return { label: 'Green', description: 'Thriving', color: '#22C55E' };
  if (score >= 60) return { label: 'Yellow', description: 'Watch', color: '#EAB308' };
  if (score >= 40) return { label: 'Orange', description: 'At Risk', color: '#F97316' };
  return { label: 'Red', description: 'Danger Zone', color: '#EF4444' };
}

module.exports = {
  calculateScore,
  getScoreStatus,
};
