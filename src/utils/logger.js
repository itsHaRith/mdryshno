/**
 * Configurable Production Logging Utility
 * Supports LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error'
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function getActiveLogLevel() {
  const envLevel = (process.env.LOG_LEVEL || (process.env.DEBUG === 'true' ? 'debug' : 'info')).toLowerCase();
  return LOG_LEVELS[envLevel] !== undefined ? LOG_LEVELS[envLevel] : LOG_LEVELS.info;
}

export const logger = {
  debug(...args) {
    if (getActiveLogLevel() <= LOG_LEVELS.debug) {
      console.log(...args);
    }
  },

  info(...args) {
    if (getActiveLogLevel() <= LOG_LEVELS.info) {
      console.log(...args);
    }
  },

  warn(...args) {
    if (getActiveLogLevel() <= LOG_LEVELS.warn) {
      console.warn(...args);
    }
  },

  error(...args) {
    if (getActiveLogLevel() <= LOG_LEVELS.error) {
      console.error(...args);
    }
  }
};
