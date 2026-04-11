/**
 * Structured Logger
 * Centralized logging with levels, timestamps, and optional alerting.
 * Replaces raw console.log throughout the system.
 */

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
const LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'INFO'] || LOG_LEVELS.INFO;

function timestamp() {
  return new Date().toISOString();
}

function formatMsg(level, context, message, meta = null) {
  const parts = [`[${timestamp()}] [${level}]`];
  if (context) parts.push(`[${context}]`);
  parts.push(message);
  if (meta && Object.keys(meta).length > 0) {
    parts.push(JSON.stringify(meta));
  }
  return parts.join(' ');
}

function debug(context, message, meta) {
  if (LEVEL <= LOG_LEVELS.DEBUG) console.log(formatMsg('DEBUG', context, message, meta));
}

function info(context, message, meta) {
  if (LEVEL <= LOG_LEVELS.INFO) console.log(formatMsg('INFO', context, message, meta));
}

function warn(context, message, meta) {
  if (LEVEL <= LOG_LEVELS.WARN) console.warn(formatMsg('WARN', context, message, meta));
}

function error(context, message, meta) {
  if (LEVEL <= LOG_LEVELS.ERROR) console.error(formatMsg('ERROR', context, message, meta));
  // Collect critical errors for alerting
  _recentErrors.push({ timestamp: timestamp(), context, message, meta });
  if (_recentErrors.length > 50) _recentErrors.shift();
}

function fatal(context, message, meta) {
  console.error(formatMsg('FATAL', context, message, meta));
  _recentErrors.push({ timestamp: timestamp(), context, message, meta, fatal: true });
  if (_recentErrors.length > 50) _recentErrors.shift();
}

// Error collection for health check / alerting
const _recentErrors = [];

function getRecentErrors(count = 20) {
  return _recentErrors.slice(-count);
}

function clearErrors() {
  _recentErrors.length = 0;
}

module.exports = {
  debug,
  info,
  warn,
  error,
  fatal,
  getRecentErrors,
  clearErrors,
};
