/**
 * Rolling Averages Utility
 * Maintains 4-week rolling averages for business performance metrics.
 * Uses GHL contact custom fields as storage.
 */

const ghl = require('./ghl-api');

/**
 * Update a 4-week rolling average for a metric.
 * Reads the current average, blends in the new week value, and writes back.
 *
 * Rolling average formula: ((oldAvg * 3) + newValue) / 4
 * This weights the new week at 25% and prior history at 75%.
 *
 * @param {string} locationId — client sub-account location ID
 * @param {string} contactId — client contact ID
 * @param {number} newValue — this week's value
 * @param {string} avgFieldName — name of the 4-week avg custom field
 * @param {Array} fieldDefs — custom field definitions array
 * @returns {number} the updated rolling average
 */
async function updateRollingAverage(locationId, contactId, newValue, avgFieldName, fieldDefs) {
  // Read current average from contact
  const contact = await ghl.getContact(locationId, contactId);
  const currentAvg = getCustomFieldValue(contact, avgFieldName, fieldDefs);

  let newAvg;
  if (currentAvg === null || currentAvg === undefined || currentAvg === 0) {
    // First data point — set average to current value
    newAvg = newValue;
  } else {
    // Weighted rolling: 75% history + 25% new
    newAvg = ((parseFloat(currentAvg) * 3) + parseFloat(newValue)) / 4;
  }

  // Round to 2 decimal places
  newAvg = Math.round(newAvg * 100) / 100;

  // Write updated average back
  await ghl.writeFieldsToContact(locationId, contactId, {
    [avgFieldName]: newAvg,
  }, fieldDefs);

  return newAvg;
}

/**
 * Update all four business performance rolling averages at once.
 * Returns the updated averages for use in scoring.
 */
async function updateAllRollingAverages(locationId, contactId, weekData, fieldDefs) {
  const averages = {};

  if (weekData.revenue !== null) {
    averages.revenue4WeekAvg = await updateRollingAverage(
      locationId, contactId, weekData.revenue,
      'FF Revenue 4-Week Avg', fieldDefs
    );
  }

  if (weekData.leads !== null) {
    averages.leadVolume4WeekAvg = await updateRollingAverage(
      locationId, contactId, weekData.leads,
      'FF Lead Volume 4-Week Avg', fieldDefs
    );
  }

  if (weekData.conversionRate !== null) {
    averages.conversionRate4WeekAvg = await updateRollingAverage(
      locationId, contactId, weekData.conversionRate,
      'FF Conversion Rate 4-Week Avg', fieldDefs
    );
  }

  if (weekData.blendedCPL !== null) {
    averages.blendedCPL4WeekAvg = await updateRollingAverage(
      locationId, contactId, weekData.blendedCPL,
      'FF Blended CPL 4-Week Avg', fieldDefs
    );
  }

  return averages;
}

/**
 * Read a custom field value from a contact object.
 */
function getCustomFieldValue(contactResponse, fieldName, fieldDefs) {
  const contact = contactResponse.contact || contactResponse;
  if (!contact.customFields) return null;

  const def = fieldDefs.find((f) => f.name === fieldName);
  if (!def) return null;

  const cf = contact.customFields.find((f) => f.id === def.id);
  return cf ? cf.value : null;
}

module.exports = {
  updateRollingAverage,
  updateAllRollingAverages,
  getCustomFieldValue,
};
