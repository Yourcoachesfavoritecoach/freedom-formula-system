/**
 * Rate Limiter
 * Throttles API calls to avoid hitting GHL/Google/Meta rate limits.
 * Uses a token bucket pattern per API provider.
 *
 * GHL: 100 requests/min per sub-account
 * Google Ads: 15,000/day (not a concern at our scale)
 * Meta: 200/hour per ad account
 */

class RateLimiter {
  /**
   * @param {number} maxPerWindow - Max requests allowed in the window
   * @param {number} windowMs - Time window in milliseconds
   */
  constructor(maxPerWindow, windowMs) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.tokens = maxPerWindow;
    this.lastRefill = Date.now();
    this.queue = [];
    this.processing = false;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor((elapsed / this.windowMs) * this.maxPerWindow);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxPerWindow, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  async acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._process();
    });
  }

  async _process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this._refill();

      if (this.tokens > 0) {
        this.tokens--;
        const resolve = this.queue.shift();
        resolve();
      } else {
        // Wait for next token
        const waitMs = Math.ceil(this.windowMs / this.maxPerWindow);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    this.processing = false;
  }
}

// Pre-configured limiters
// GHL: 80 req/min per location (leave 20% headroom from 100 limit)
const ghlLimiters = {};
function getGHLLimiter(locationId) {
  if (!ghlLimiters[locationId]) {
    ghlLimiters[locationId] = new RateLimiter(80, 60 * 1000);
  }
  return ghlLimiters[locationId];
}

// Global GHL limiter for cross-location total (conservative: 200/min)
const globalGHLLimiter = new RateLimiter(200, 60 * 1000);

// Meta: 150/hour per ad account (leave headroom from 200)
const metaLimiters = {};
function getMetaLimiter(adAccountId) {
  if (!metaLimiters[adAccountId]) {
    metaLimiters[adAccountId] = new RateLimiter(150, 60 * 60 * 1000);
  }
  return metaLimiters[adAccountId];
}

module.exports = {
  RateLimiter,
  getGHLLimiter,
  globalGHLLimiter,
  getMetaLimiter,
};
