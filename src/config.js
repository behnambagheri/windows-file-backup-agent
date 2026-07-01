const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

let fileEnv = {};

function appDir() {
  if (process.env.AGENT_HOME) {
    return path.resolve(process.env.AGENT_HOME);
  }
  if (process.pkg && process.execPath) {
    return path.dirname(process.execPath);
  }
  if (fs.existsSync(path.join(process.cwd(), ".env"))) {
    return process.cwd();
  }
  return path.resolve(__dirname, "..");
}

function readEnvFile() {
  const configured = process.env.ENV_FILE;
  const candidates = [
    configured,
    path.join(process.cwd(), ".env"),
    path.join(appDir(), ".env")
  ].filter(Boolean);

  const envFile = candidates.find((candidate) => fs.existsSync(candidate));
  if (!envFile) {
    fileEnv = {};
    return { envFile: path.join(appDir(), ".env"), parsed: {} };
  }

  fileEnv = dotenv.parse(fs.readFileSync(envFile, "utf8"));
  return { envFile, parsed: fileEnv };
}

function firstEnv(names, fallback = "") {
  for (const name of names) {
    const value = fileEnv[name];
    if (value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return fallback;
}

function envBool(names, fallback = false) {
  const value = firstEnv(names, "");
  if (value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function envInt(names, fallback) {
  const raw = firstEnv(names, "");
  if (raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mode(names, fallback = "off") {
  const value = firstEnv(names, fallback).toLowerCase();
  if (["all", "success", "failures", "failure", "failed", "errors", "error", "off", "none", "false", "disabled"].includes(value)) {
    if (["failure", "failed", "errors", "error"].includes(value)) {
      return "failures";
    }
    if (["none", "false", "disabled"].includes(value)) {
      return "off";
    }
    return value;
  }
  return fallback;
}

function parseEmailList(value) {
  if (!value) {
    return [];
  }
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function disabledValue(value) {
  return ["", "off", "none", "false", "disabled"].includes(String(value || "").trim().toLowerCase());
}

function parseDurationMs(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (disabledValue(value)) {
    return null;
  }
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10) * 60 * 1000;
  }

  const match = value.match(/^(\d+)\s*([smhdw])$/);
  if (!match) {
    return Number.NaN;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };
  return amount > 0 ? amount * multipliers[unit] : Number.NaN;
}

function parsePositiveInt(raw) {
  const value = String(raw || "").trim();
  if (value === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && String(parsed) === value ? parsed : Number.NaN;
}

function retentionConfig() {
  const legacyMinutes = firstEnv(["RETENTION_MINUTES", "retention-minutes", "SOURCE_RETENTION_MINUTES", "source-retention-minutes"], "");
  const retentionTime = firstEnv(["RETENTION_TIME", "retention-time", "SOURCE_RETENTION_TIME", "source-retention-time"], legacyMinutes || "off");
  const retentionCountRaw = firstEnv(["RETENTION_COUNT", "retention-count", "SOURCE_RETENTION_COUNT", "source-retention-count"], "");
  const explicitPolicy = firstEnv(["RETENTION_POLICY", "retention-policy", "SOURCE_RETENTION_POLICY", "source-retention-policy"], "").toLowerCase();

  let policy = explicitPolicy;
  if (policy === "") {
    if (!disabledValue(retentionCountRaw)) {
      policy = "count";
    } else if (!disabledValue(retentionTime)) {
      policy = "time";
    } else {
      policy = "off";
    }
  }
  if (disabledValue(policy)) {
    policy = "off";
  }

  const timeMs = policy === "time" ? parseDurationMs(retentionTime) : null;
  const count = policy === "count" ? parsePositiveInt(retentionCountRaw) : null;
  return {
    policy,
    time: retentionTime,
    timeMs,
    minutes: Number.isFinite(timeMs) ? Math.ceil(timeMs / 60000) : null,
    count
  };
}

function loadConfig() {
  const { envFile } = readEnvFile();
  const directory = appDir();
  const logsDir = path.resolve(firstEnv(["LOG_DIR"], path.join(directory, "logs")));
  const stateDir = path.resolve(firstEnv(["STATE_DIR"], path.join(directory, "state")));
  const retention = retentionConfig();

  const telegramExplicitEnabled = firstEnv(["TELEGRAM_ENABLED"], "");
  const emailExplicitEnabled = firstEnv(["EMAIL_ENABLED"], "");

  const config = {
    app: {
      name: firstEnv(["APP_NAME"], "backup-agent"),
      hostname: firstEnv(["HOSTNAME", "hostname", "SOURCE_HOSTNAME", "source-hostname"], os.hostname()),
      envFile,
      appDir: directory,
      logsDir,
      stateDir,
      logLevel: firstEnv(["LOG_LEVEL"], "info").toLowerCase(),
      runOnce: envBool(["RUN_ONCE"], false),
      cron: firstEnv(["CRON_SCHEDULE", "SOURCE_CHECK_CRON"], "0 */5 * * * *"),
      runOnStart: envBool(["RUN_ON_START"], true),
      lockFile: path.join(stateDir, "agent.lock"),
      stateFile: path.join(stateDir, "transferred.json")
    },
    source: {
      dir: firstEnv(["SOURCE_DIR", "SOURCE_DIRECTORY"]),
      pattern: firstEnv(["SOURCE_FILE_PATTERN", "SOURCE_FORMAT", "SOURCE_FILE_FORMAT"], "*.bak"),
      latestOnly: envBool(["SOURCE_LATEST_ONLY", "LATEST_SOURCE_ONLY"], true),
      deleteOnSuccess: envBool(["DELETE_SOURCE_ON_SUCCESS", "DELETE_SOURCE_AFTER_SUCCESS"], false),
      skipAlreadyTransferred: envBool(["SKIP_ALREADY_TRANSFERRED"], true),
      minAgeSeconds: envInt(["SOURCE_MIN_AGE_SECONDS"], 10),
      retentionPolicy: retention.policy,
      retentionTime: retention.time,
      retentionTimeMs: retention.timeMs,
      retentionMinutes: retention.minutes,
      retentionCount: retention.count
    },
    compression: {
      enabled: envBool(["COMPRESSION", "COMPRESSION_ENABLED"], false),
      level: 9,
      tempDir: path.join(stateDir, "compressed")
    },
    metrics: {
      enabled: envBool(["METRICS_ENABLED", "metrics-enabled"], false),
      host: firstEnv(["METRICS_HOST", "metrics-host"], "0.0.0.0"),
      port: envInt(["METRICS_PORT", "metrics-port"], 9108),
      path: firstEnv(["METRICS_PATH", "metrics-path"], "/metrics"),
      firewallRule: envBool(["METRICS_FIREWALL_RULE", "metrics-firewall-rule"], false),
      firewallRuleName: firstEnv(["METRICS_FIREWALL_RULE_NAME", "metrics-firewall-rule-name"], "backup-agent metrics")
    },
    destination: {
      host: firstEnv(["DEST_HOST", "DESTINATION_ADDRESS", "DESTINATION_HOST"]),
      port: envInt(["DEST_PORT", "DESTINATION_PORT"], 22),
      remoteDir: firstEnv(["DEST_REMOTE_DIR", "DESTINATION_PATH", "DESTINATION_STORAGE_PATH"]),
      username: firstEnv(["DEST_USER", "DEST_USERNAME", "DESTINATION_USER"]),
      authMethod: firstEnv(["DEST_AUTH_METHOD", "DESTINATION_AUTH_METHOD"], "password").toLowerCase(),
      password: firstEnv(["DEST_PASSWORD", "DESTINATION_PASSWORD"]),
      privateKeyBase64: firstEnv(["DEST_PRIVATE_KEY_BASE64", "PRIVATE_KEY_BASE64", "DESTINATION_PRIVATE_KEY_BASE64"]),
      readyTimeoutMs: envInt(["SSH_READY_TIMEOUT_MS"], 30000),
      keepaliveIntervalMs: envInt(["SSH_KEEPALIVE_INTERVAL_MS"], 20000),
      socks5Enabled: envBool(["SSH_SOCKS5_ENABLED", "DEST_SOCKS5_ENABLED", "USE_SSH_SOCKS5_PROXY"], false),
      socks5Proxy: firstEnv(["SSH_SOCKS5_PROXY", "DEST_SOCKS5_PROXY", "SOCKS5_PROXY"]),
      createDir: envBool(["CREATE_DESTINATION_DIR", "create-destination-dir"], false),
      dirFormat: firstEnv(["DESTINATION_DIR_FORMAT", "destination-dir-format"], "date").toLowerCase()
    },
    update: {
      url: firstEnv(
        ["UPDATE_URL", "update-url"],
        "https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip"
      )
    },
    telegram: {
      mode: telegramExplicitEnabled !== ""
        ? (envBool(["TELEGRAM_ENABLED"], false) ? mode(["TELEGRAM_MODE", "TELEGRAM_SEND_MODE"], "all") : "off")
        : mode(["TELEGRAM_MODE", "TELEGRAM_SEND_MODE"], "off"),
      fallback: firstEnv(["TELEGRAM_FALLBACK"], "off").toLowerCase(),
      apiUrl: firstEnv(["TELEGRAM_API_URL"], "https://api.telegram.org"),
      useProxy: envBool(["TELEGRAM_USE_PROXY"], false),
      proxy: firstEnv(["TELEGRAM_PROXY"]),
      token: firstEnv(["TELEGRAM_BOT_TOKEN", "TELEGRAM_TOKEN"]),
      chatId: firstEnv(["TELEGRAM_CHAT_ID"]),
      topicId: firstEnv(["TELEGRAM_TOPIC_ID", "TELEGRAM_MESSAGE_THREAD_ID"])
    },
    email: {
      mode: emailExplicitEnabled !== ""
        ? (envBool(["EMAIL_ENABLED"], false) ? mode(["EMAIL_MODE", "EMAIL_SEND_MODE"], "all") : "off")
        : mode(["EMAIL_MODE", "EMAIL_SEND_MODE"], "off"),
      fallback: firstEnv(["EMAIL_FALLBACK"], "off").toLowerCase(),
      host: firstEnv(["SMTP_HOST", "EMAIL_SMTP_HOST"]),
      port: envInt(["SMTP_PORT", "EMAIL_SMTP_PORT"], 465),
      secure: envBool(["SMTP_SSL", "EMAIL_SMTP_SSL"], true),
      user: firstEnv(["SMTP_USER", "EMAIL_SMTP_USER"]),
      password: firstEnv(["SMTP_PASSWORD", "EMAIL_SMTP_PASSWORD"]),
      from: firstEnv(["EMAIL_FROM", "SMTP_FROM"]),
      to: parseEmailList(firstEnv(["EMAIL_TO"])),
      cc: parseEmailList(firstEnv(["EMAIL_CC"])),
      bcc: parseEmailList(firstEnv(["EMAIL_BCC"])),
      subjectPrefix: firstEnv(["EMAIL_SUBJECT_PREFIX"], "[backup-agent]")
    }
  };

  return config;
}

function validateDestinationConfig(config) {
  const errors = [];
  if (!config.destination.host) errors.push("DEST_HOST is required.");
  if (!Number.isInteger(config.destination.port) || config.destination.port < 1 || config.destination.port > 65535) {
    errors.push("DEST_PORT must be a TCP port from 1 to 65535.");
  }
  if (!config.destination.remoteDir) errors.push("DEST_REMOTE_DIR is required.");
  if (!config.destination.username) errors.push("DEST_USER is required.");
  if (!["password", "private_key", "key"].includes(config.destination.authMethod)) {
    errors.push("DEST_AUTH_METHOD must be password or private_key.");
  }
  if (config.destination.authMethod === "password" && !config.destination.password) {
    errors.push("DEST_PASSWORD is required when DEST_AUTH_METHOD=password.");
  }
  if (["private_key", "key"].includes(config.destination.authMethod) && !config.destination.privateKeyBase64) {
    errors.push("DEST_PRIVATE_KEY_BASE64 is required when DEST_AUTH_METHOD=private_key.");
  }
  if (config.destination.socks5Enabled && !config.destination.socks5Proxy) {
    errors.push("SSH_SOCKS5_PROXY is required when SSH_SOCKS5_ENABLED=true.");
  }
  if (config.destination.createDir && !["date", "hostname", "hostname+date"].includes(config.destination.dirFormat)) {
    errors.push("DESTINATION_DIR_FORMAT must be date, hostname, or hostname+date when CREATE_DESTINATION_DIR=true.");
  }
  return errors;
}

function validateTelegramConfig(config) {
  const errors = [];
  if (!config.telegram.token) errors.push("TELEGRAM_BOT_TOKEN is required.");
  if (!config.telegram.chatId) errors.push("TELEGRAM_CHAT_ID is required.");
  if (config.telegram.useProxy && !config.telegram.proxy) {
    errors.push("TELEGRAM_PROXY is required when TELEGRAM_USE_PROXY=true.");
  }
  return errors;
}

function validateEmailConfig(config) {
  const errors = [];
  if (!config.email.host) errors.push("SMTP_HOST is required.");
  if (!Number.isInteger(config.email.port) || config.email.port < 1 || config.email.port > 65535) {
    errors.push("SMTP_PORT must be a TCP port from 1 to 65535.");
  }
  if (!config.email.from) errors.push("EMAIL_FROM is required.");
  if (config.email.to.length === 0) errors.push("EMAIL_TO is required.");
  return errors;
}

function validateConfig(config) {
  const errors = [];

  if (!config.source.dir) errors.push("SOURCE_DIR is required.");
  if (!config.source.pattern) errors.push("SOURCE_FILE_PATTERN is required.");
  if (!["off", "time", "count"].includes(config.source.retentionPolicy)) {
    errors.push("RETENTION_POLICY must be off, time, or count.");
  }
  if (config.source.retentionPolicy === "time" && !Number.isFinite(config.source.retentionTimeMs)) {
    errors.push("RETENTION_TIME must be a duration such as 60m, 1d, 7d, or 3w.");
  }
  if (config.source.retentionPolicy === "count" && !Number.isFinite(config.source.retentionCount)) {
    errors.push("RETENTION_COUNT must be a positive integer when RETENTION_POLICY=count.");
  }
  if (config.metrics.enabled) {
    if (!Number.isInteger(config.metrics.port) || config.metrics.port < 1 || config.metrics.port > 65535) {
      errors.push("METRICS_PORT must be a TCP port from 1 to 65535.");
    }
    if (!config.metrics.path.startsWith("/")) {
      errors.push("METRICS_PATH must start with /.");
    }
  }
  errors.push(...validateDestinationConfig(config));
  if (!["off", "email"].includes(config.telegram.fallback)) {
    errors.push("TELEGRAM_FALLBACK must be off or email.");
  }
  if (!["off", "telegram"].includes(config.email.fallback)) {
    errors.push("EMAIL_FALLBACK must be off or telegram.");
  }
  if (config.telegram.mode !== "off") {
    errors.push(...validateTelegramConfig(config));
    if (config.telegram.fallback === "email") {
      errors.push(...validateEmailConfig(config));
    }
  }
  if (config.email.mode !== "off") {
    errors.push(...validateEmailConfig(config));
    if (config.email.fallback === "telegram") {
      errors.push(...validateTelegramConfig(config));
    }
  }

  return [...new Set(errors)];
}

module.exports = {
  appDir,
  loadConfig,
  validateConfig,
  validateDestinationConfig,
  validateTelegramConfig,
  validateEmailConfig
};
