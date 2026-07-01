const fs = require("fs");
const path = require("path");

const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function createLogger(config) {
  ensureDir(config.app.logsDir);
  const logFile = path.join(config.app.logsDir, "agent.log");
  const minLevel = levels[config.app.logLevel] || levels.info;

  function write(level, message, meta) {
    if ((levels[level] || levels.info) < minLevel) {
      return;
    }

    const row = {
      time: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {})
    };
    const line = JSON.stringify(row);
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
    const printable = `[${row.time}] ${level.toUpperCase()} ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`;
    if (level === "error") {
      console.error(printable);
    } else {
      console.log(printable);
    }
  }

  return {
    file: logFile,
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta)
  };
}

module.exports = {
  createLogger,
  ensureDir
};
