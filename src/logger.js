'use strict';

function ts() {
  return new Date().toISOString();
}

function line(level, tag, msg, extra) {
  const parts = [ts(), level.padEnd(5), `[${tag}]`, msg];
  if (extra !== undefined) {
    try {
      parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra));
    } catch {
      parts.push(String(extra));
    }
  }
  return parts.join(' ');
}

const logger = {
  info: (tag, msg, extra) => console.log(line('INFO', tag, msg, extra)),
  warn: (tag, msg, extra) => console.warn(line('WARN', tag, msg, extra)),
  error: (tag, msg, extra) => console.error(line('ERROR', tag, msg, extra)),
};

module.exports = logger;
