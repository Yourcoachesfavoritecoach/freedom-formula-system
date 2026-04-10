/**
 * Google Ads API Utility
 * Uses the official google-ads-api package.
 * Pulls lead volume and spend data per client ad account.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { GoogleAdsApi } = require('google-ads-api');

const client = new GoogleAdsApi({
  client_id: process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');

/**
 * Get total leads and spend for a date range.
 * @param {string} customerId — Google Ads customer ID (no dashes)
 * @param {string} startDate — YYYY-MM-DD
 * @param {string} endDate — YYYY-MM-DD
 * @returns {{ leads: number, spend: number } | null}
 */
async function getWeeklyLeadsAndSpend(customerId, startDate, endDate) {
  try {
    const cleanId = customerId.replace(/-/g, '');

    const customer = client.Customer({
      customer_id: cleanId,
      login_customer_id: LOGIN_CUSTOMER_ID,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    });

    const rows = await customer.query(`
      SELECT
        metrics.conversions,
        metrics.cost_micros
      FROM campaign
      WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
        AND campaign.status = 'ENABLED'
    `);

    let totalLeads = 0;
    let totalSpendMicros = 0;

    for (const row of rows) {
      totalLeads += parseFloat(row.metrics.conversions || 0);
      totalSpendMicros += parseInt(row.metrics.cost_micros || 0, 10);
    }

    return {
      leads: Math.round(totalLeads),
      spend: totalSpendMicros / 1_000_000,
    };
  } catch (err) {
    console.error(`Google Ads data pull failed for ${customerId}:`, err.message);
    if (err.errors) {
      for (const e of err.errors) {
        console.error(`  ${e.message}`);
      }
    }
    return null;
  }
}

module.exports = {
  getWeeklyLeadsAndSpend,
};
