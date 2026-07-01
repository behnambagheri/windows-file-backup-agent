#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { loadConfig, validateConfig } = require("./config");
const { createLogger, ensureDir } = require("./logger");
const { Metrics } = require("./metrics");
const { notify } = require("./notifications");
const { runTransferCycle } = require("./transfer");

let active = false;
let shuttingDown = false;
let metrics;

function isProcessRunning(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(config, logger) {
  ensureDir(config.app.stateDir);
  try {
    const fd = fs.openSync(config.app.lockFile, "wx");
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    }), "utf8");
    return () => {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors during shutdown.
      }
      try {
        fs.unlinkSync(config.app.lockFile);
      } catch {
        // Ignore missing lock during shutdown.
      }
    };
  } catch (error) {
    if (error.code === "EEXIST") {
      try {
        const lock = JSON.parse(fs.readFileSync(config.app.lockFile, "utf8"));
        if (!isProcessRunning(lock.pid)) {
          logger.warn("Removing stale agent lock", { lockFile: config.app.lockFile, pid: lock.pid });
          fs.unlinkSync(config.app.lockFile);
          return acquireLock(config, logger);
        }
      } catch {
        logger.warn("Removing unreadable agent lock", { lockFile: config.app.lockFile });
        fs.unlinkSync(config.app.lockFile);
        return acquireLock(config, logger);
      }
    }
    logger.error("Another agent instance appears to be running", {
      lockFile: config.app.lockFile,
      error: error.message
    });
    process.exit(2);
  }
}

async function runCycle(config, logger) {
  if (active) {
    logger.warn("Previous transfer cycle is still running; skipping this tick");
    return;
  }

  active = true;
  if (metrics) {
    metrics.cycleStarted();
  }
  try {
    logger.info("Transfer cycle started");
    const results = await runTransferCycle(config, logger);
    for (const result of results) {
      await notify(config, result, logger);
    }
    if (metrics) {
      metrics.cycleFinished(results.every((result) => result.success), results);
    }
    logger.info("Transfer cycle finished", { resultCount: results.length });
  } catch (error) {
    logger.error("Transfer cycle crashed", { error: error.stack || error.message });
    if (metrics) {
      metrics.cycleCrashed();
    }
    await notify(config, { success: false, error }, logger);
  } finally {
    active = false;
  }
}

async function main() {
  const config = loadConfig();
  ensureDir(config.app.logsDir);
  ensureDir(config.app.stateDir);
  const logger = createLogger(config);
  const releaseLock = acquireLock(config, logger);

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("Agent shutting down", { signal });
    if (metrics) {
      metrics.stop();
    }
    releaseLock();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error: error.stack || error.message });
    releaseLock();
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    logger.error("Unhandled rejection", { error: error.stack || String(error) });
  });

  const errors = validateConfig(config);
  if (errors.length > 0) {
    logger.error("Invalid configuration", { envFile: config.app.envFile, errors });
    releaseLock();
    process.exit(1);
  }

  logger.info("Agent started", {
    envFile: config.app.envFile,
    logFile: logger.file,
    sourceDir: config.source.dir,
    sourcePattern: config.source.pattern,
    sourceHost: config.app.hostname,
    destinationHost: config.destination.host,
    destinationDir: config.destination.remoteDir,
    createDestinationDir: config.destination.createDir,
    destinationDirFormat: config.destination.dirFormat,
    retentionPolicy: config.source.retentionPolicy,
    retentionTime: config.source.retentionPolicy === "time" ? config.source.retentionTime : "off",
    retentionCount: config.source.retentionPolicy === "count" ? config.source.retentionCount : "off",
    metricsEnabled: config.metrics.enabled,
    metricsHost: config.metrics.host,
    metricsPort: config.metrics.port,
    metricsPath: config.metrics.path,
    cron: config.app.cron
  });

  metrics = new Metrics(config);
  metrics.start(logger);

  if (config.app.runOnStart || config.app.runOnce) {
    await runCycle(config, logger);
  }

  if (config.app.runOnce) {
    releaseLock();
    process.exit(0);
  }

  if (!cron.validate(config.app.cron)) {
    logger.error("Invalid CRON_SCHEDULE", { cron: config.app.cron });
    releaseLock();
    process.exit(1);
  }

  cron.schedule(config.app.cron, () => {
    runCycle(config, logger);
  });

  logger.info("Cron scheduler registered", { cron: config.app.cron });

  setInterval(() => {
    logger.debug("Agent heartbeat");
  }, 60000).unref();
}

main();
