/**
 * Meta Ads Manager API Utility
 * Pulls lead volume and spend data per client ad account.
 */

const axios = require('axios');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = 'v19.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

/**
 * Get total leads and spend for a date range from Meta Ads Manager.
 * @param {string} adAccountId — Meta ad account ID (format: act_XXXXXXXXX)
 * @param {string} startDate — YYYY-MM-DD
 * @param {string} endDate — YYYY-MM-DD
 * @returns {{ leads: number, spend: number } | null}
 */
async function getWeeklyLeadsAndSpend(adAccountId, startDate, endDate) {
  try {
    const url = `${BASE_URL}/${adAccountId}/insights`;
    const res = await axios.get(url, {
      params: {
        access_token: META_ACCESS_TOKEN,
        fields: 'spend,actions',
        time_range: JSON.stringify({
          since: startDate,
          until: endDate,
        }),
        level: 'account',
      },
    });

    if (!res.data || !res.data.data || res.data.data.length === 0) {
      return { leads: 0, spend: 0 };
    }

    const insight = res.data.data[0];
    const spend = parseFloat(insight.spend || 0);

    // Count lead actions
    let leads = 0;
    if (insight.actions) {
      for (const action of insight.actions) {
        if (
          action.action_type === 'lead' ||
          action.action_type === 'onsite_conversion.lead_grouped' ||
          action.action_type === 'offsite_conversion.fb_pixel_lead'
        ) {
          leads += parseInt(action.value || 0, 10);
        }
      }
    }

    return { leads, spend };
  } catch (err) {
    console.error(`Meta Ads data pull failed for ${adAccountId}:`, err.message);
    return null; // null signals failure to the scoring engine
  }
}

module.exports = {
  getWeeklyLeadsAndSpend,
};
