/**
 * Run Lock
 * Prevents double-execution of scoring and other critical jobs.
 * Uses a lock file with PID and timestamp to detect stale locks.
 */

const fs = require('fs');
const path = require('path');

const LOCK_DIR = path.resolve(__dirname, '../setup');
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Acquire a named lock. Returns true if acquired, false if already held.
 * @param {string} name - Lock name (e.g., 'scoring', 'nightly-refresh')
 * @returns {boolean}
 */
function acquire(name) {
  const lockFile = path.join(LOCK_DIR, `${name}.lock`);

  if (fs.existsSync(lockFile)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const age = Date.now() - new Date(lock.timestamp).getTime();

      // Check if lock is stale (process crashed or hung)
      if (age < STALE_THRESHOLD_MS) {
        console.warn(`[LOCK] ${name} is already running (started ${Math.round(age / 1000)}s ago, PID ${lock.pid})`);
        return false;
      }

      // Stale lock, override it
      console.warn(`[LOCK] Overriding stale lock for ${name} (${Math.round(age / 60000)}min old)`);
    } catch (e) {
      // Corrupt lock file, override
      console.warn(`[LOCK] Corrupt lock file for ${name}, overriding`);
    }
  }

  // Write lock
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: process.pid,
    timestamp: new Date().toISOString(),
    name,
  }));

  return true;
}

/**
 * Release a named lock.
 * @param {string} name
 */
function release(name) {
  const lockFile = path.join(LOCK_DIR, `${name}.lock`);
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
  } catch (e) {
    console.warn(`[LOCK] Could not release lock ${name}: ${e.message}`);
  }
}

/**
 * Check if a lock is currently held (without acquiring).
 * @param {string} name
 * @returns {boolean}
 */
function isLocked(name) {
  const lockFile = path.join(LOCK_DIR, `${name}.lock`);
  if (!fs.existsSync(lockFile)) return false;

  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const age = Date.now() - new Date(lock.timestamp).getTime();
    return age < STALE_THRESHOLD_MS;
  } catch {
    return false;
  }
}

module.exports = { acquire, release, isLocked };
