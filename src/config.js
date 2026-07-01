const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const yaml = require("js-yaml");

const DEFAULT_UPDATE_URL = "https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip";

function appDir() {
  if (process.env.AGENT_HOME) {
    return path.resolve(process.env.AGENT_HOME);
  }
  if (process.pkg && process.execPath) {
    return path.dirname(process.execPath);
  }
  if (
    fs.existsSync(path.join(process.cwd(), "config.yaml")) ||
    fs.existsSync(path.join(process.cwd(), "config.yml")) ||
    fs.existsSync(path.join(process.cwd(), ".env"))
  ) {
    return process.cwd();
  }
  return path.resolve(__dirname, "..");
}

function readConfigFile() {
  const directory = appDir();
  const configured = process.env.CONFIG_FILE || process.env.BACKUP_AGENT_CONFIG || process.env.ENV_FILE;
  const candidates = [
    configured,
    path.join(process.cwd(), "config.yaml"),
    path.join(process.cwd(), "config.yml"),
    path.join(directory, "config.yaml"),
    path.join(directory, "config.yml"),
    path.join(process.cwd(), ".env"),
    path.join(directory, ".env")
  ].filter(Boolean);

  const configFile = candidates.find((candidate) => fs.existsSync(candidate));
  if (!configFile) {
    return {
      configFile: path.join(directory, "config.yaml"),
      kind: "yaml",
      data: {}
    };
  }

  const content = fs.readFileSync(configFile, "utf8");
  if (isYamlConfigFile(configFile)) {
    return {
      configFile,
      kind: "yaml",
      data: yaml.load(content) || {}
    };
  }

  return {
    configFile,
    kind: "env",
    data: dotenv.parse(content)
  };
}

function isYamlConfigFile(configFile) {
  return /\.ya?ml($|\.)/i.test(path.basename(configFile));
}

function isSet(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function setting(primary, fallback, aliases, defaultValue = "") {
  for (const alias of aliases) {
    if (primary && isSet(primary[alias])) {
      return primary[alias];
    }
  }
  for (const alias of aliases) {
    if (fallback && isSet(fallback[alias])) {
      return fallback[alias];
    }
  }
  return defaultValue;
}

function envSetting(names, defaultValue = "") {
  for (const name of names) {
    if (isSet(process.env[name])) {
      return process.env[name];
    }
  }
  return defaultValue;
}

function stringValue(value, fallback = "") {
  if (!isSet(value)) {
    return fallback;
  }
  return String(value).trim();
}

function boolValue(value, fallback = false) {
  if (!isSet(value)) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function intValue(value, fallback) {
  if (!isSet(value)) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function modeValue(value, fallback = "off") {
  const normalized = stringValue(value, fallback).toLowerCase();
  if (["all", "success", "failures", "failure", "failed", "errors", "error", "off", "none", "false", "disabled"].includes(normalized)) {
    if (["failure", "failed", "errors", "error"].includes(normalized)) {
      return "failures";
    }
    if (["none", "false", "disabled"].includes(normalized)) {
      return "off";
    }
    return normalized;
  }
  return fallback;
}

function parseEmailList(value) {
  if (!isSet(value)) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringValue(item)).filter(Boolean);
  }
  return String(value).split(/[;,]/).map((item) => item.trim()).filter(Boolean);
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
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };
  return amount > 0 ? amount * multipliers[match[2]] : Number.NaN;
}

function parsePositiveInt(raw) {
  if (!isSet(raw)) {
    return null;
  }
  const value = String(raw).trim();
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && String(parsed) === value ? parsed : Number.NaN;
}

function retentionConfig(primary, fallback) {
  const legacyMinutes = setting(primary, fallback, [
    "retention_minutes",
    "RETENTION_MINUTES",
    "SOURCE_RETENTION_MINUTES"
  ], "");
  const retentionTime = setting(primary, fallback, [
    "retention_time",
    "RETENTION_TIME",
    "SOURCE_RETENTION_TIME"
  ], legacyMinutes || "off");
  const retentionCountRaw = setting(primary, fallback, [
    "retention_count",
    "RETENTION_COUNT",
    "SOURCE_RETENTION_COUNT"
  ], "");
  const explicitPolicy = stringValue(setting(primary, fallback, [
    "retention_policy",
    "RETENTION_POLICY",
    "SOURCE_RETENTION_POLICY"
  ], "")).toLowerCase();

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
    time: stringValue(retentionTime, "off"),
    timeMs,
    minutes: Number.isFinite(timeMs) ? Math.ceil(timeMs / 60000) : null,
    count
  };
}

function objectSetting(primary, fallback, aliases) {
  for (const alias of aliases) {
    if (primary && primary[alias] && typeof primary[alias] === "object" && !Array.isArray(primary[alias])) {
      return primary[alias];
    }
  }
  for (const alias of aliases) {
    if (fallback && fallback[alias] && typeof fallback[alias] === "object" && !Array.isArray(fallback[alias])) {
      return fallback[alias];
    }
  }
  return null;
}

function compressionConfig(primary, fallback, stateDir, safeName) {
  const compressionObject = objectSetting(primary, fallback, ["compression", "COMPRESSION"]);
  const rawEnabled = compressionObject
    ? setting(compressionObject, {}, ["enabled"], false)
    : setting(primary, fallback, ["compression", "compression_enabled", "COMPRESSION", "COMPRESSION_ENABLED"], false);
  const rawLevel = compressionObject
    ? setting(compressionObject, {}, ["level"], 9)
    : setting(primary, fallback, ["compression_level", "COMPRESSION_LEVEL"], 9);
  const rawTempDir = compressionObject
    ? setting(compressionObject, {}, ["temp_dir", "tempDir"], "")
    : setting(primary, fallback, ["compression_temp_dir", "COMPRESSION_TEMP_DIR"], "");
  const level = intValue(rawLevel, 9);
  return {
    enabled: boolValue(rawEnabled, false),
    level: Math.min(9, Math.max(1, level)),
    tempDir: path.resolve(stringValue(rawTempDir, path.join(stateDir, "compressed", safeName)))
  };
}

function proxyUrl(root, names = []) {
  const proxy = root.proxy || {};
  return stringValue(setting(proxy, root, ["url", "PROXY_URL", "GLOBAL_PROXY_URL", ...names, "SOCKS5_PROXY"]));
}

function sourceItems(root) {
  const sources = root.sources || root.source_files || root.sourceFiles || {};
  if (Array.isArray(sources)) {
    return { defaults: {}, items: sources };
  }
  const items = sources.items || sources.files || sources.source_files || sources.sourceFiles || [];
  return {
    defaults: sources.defaults || sources.global || {},
    items: Array.isArray(items) ? items : []
  };
}

function normalizeSource(root, defaults, item, index, stateDir) {
  const name = stringValue(setting(item, {}, ["name", "NAME"], `source_${index + 1}`));
  const mode = stringValue(setting(item, defaults, ["mode", "type", "source_type", "SOURCE_MODE"], "files")).toLowerCase();
  const sourceDir = stringValue(setting(item, defaults, ["source_dir", "dir", "directory", "SOURCE_DIR", "SOURCE_DIRECTORY"]));
  const pattern = stringValue(setting(item, defaults, [
    "source_file_pattern",
    "file_pattern",
    "pattern",
    "SOURCE_FILE_PATTERN",
    "SOURCE_FORMAT",
    "SOURCE_FILE_FORMAT"
  ], "*.bak"));
  const retention = retentionConfig(item, defaults);
  const safeName = String(name || `source_${index + 1}`)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || `source_${index + 1}`;

  const compression = compressionConfig(item, defaults, stateDir, safeName);

  return {
    name,
    mode,
    dir: sourceDir,
    pattern,
    latestOnly: boolValue(setting(item, defaults, ["latest_only", "SOURCE_LATEST_ONLY", "LATEST_SOURCE_ONLY"], true), true),
    minAgeSeconds: intValue(setting(item, defaults, ["min_age_seconds", "SOURCE_MIN_AGE_SECONDS"], 10), 10),
    deleteOnSuccess: boolValue(setting(item, defaults, ["delete_on_success", "DELETE_SOURCE_ON_SUCCESS", "DELETE_SOURCE_AFTER_SUCCESS"], false), false),
    skipAlreadyTransferred: boolValue(setting(item, defaults, ["skip_already_transferred", "SKIP_ALREADY_TRANSFERRED"], true), true),
    retentionPolicy: retention.policy,
    retentionTime: retention.time,
    retentionTimeMs: retention.timeMs,
    retentionMinutes: retention.minutes,
    retentionCount: retention.count,
    compression
  };
}

function legacySourceFromEnv(root, stateDir) {
  return normalizeSource(root, {
    source_dir: setting(root, {}, ["SOURCE_DIR", "SOURCE_DIRECTORY"]),
    source_file_pattern: setting(root, {}, ["SOURCE_FILE_PATTERN", "SOURCE_FORMAT", "SOURCE_FILE_FORMAT"], "*.bak"),
    latest_only: setting(root, {}, ["SOURCE_LATEST_ONLY", "LATEST_SOURCE_ONLY"], true),
    min_age_seconds: setting(root, {}, ["SOURCE_MIN_AGE_SECONDS"], 10),
    delete_on_success: setting(root, {}, ["DELETE_SOURCE_ON_SUCCESS", "DELETE_SOURCE_AFTER_SUCCESS"], false),
    compression: setting(root, {}, ["COMPRESSION", "COMPRESSION_ENABLED"], false),
    retention_policy: setting(root, {}, ["RETENTION_POLICY", "SOURCE_RETENTION_POLICY"], "off"),
    retention_time: setting(root, {}, ["RETENTION_TIME", "SOURCE_RETENTION_TIME", "RETENTION_MINUTES", "SOURCE_RETENTION_MINUTES"], "off"),
    retention_count: setting(root, {}, ["RETENTION_COUNT", "SOURCE_RETENTION_COUNT"], ""),
    skip_already_transferred: setting(root, {}, ["SKIP_ALREADY_TRANSFERRED"], true)
  }, { name: "default" }, 0, stateDir);
}

function loadConfig() {
  const { configFile, kind, data } = readConfigFile();
  const root = data || {};
  const directory = appDir();
  const app = root.app || root.application || {};
  const logging = root.logging || {};
  const schedule = root.schedule || {};
  const metrics = root.metrics || {};
  const destination = root.destination || root.dest || {};
  const update = root.update || {};
  const notifications = root.notifications || {};
  const telegram = notifications.telegram || root.telegram || {};
  const email = notifications.email || root.email || {};
  const proxy = root.proxy || {};

  const logsDir = path.resolve(stringValue(setting(logging, app, ["dir", "log_dir", "LOG_DIR"], path.join(directory, "logs"))));
  const stateDir = path.resolve(stringValue(setting(root.state || {}, app, ["dir", "state_dir", "STATE_DIR"], path.join(directory, "state"))));

  const runOnceOverride = envSetting(["RUN_ONCE"], "");
  const runOnStartOverride = envSetting(["RUN_ON_START"], "");
  const { defaults, items } = sourceItems(root);
  const normalizedSources = items.length > 0
    ? items.map((item, index) => normalizeSource(root, defaults, item || {}, index, stateDir))
    : [legacySourceFromEnv(root, stateDir)];

  const config = {
    app: {
      name: stringValue(setting(app, root, ["name", "APP_NAME"], "backup-agent")),
      hostname: stringValue(setting(app, root, ["hostname", "HOSTNAME", "SOURCE_HOSTNAME"], os.hostname()), os.hostname()),
      configFile,
      envFile: configFile,
      configKind: kind,
      appDir: directory,
      logsDir,
      stateDir,
      logLevel: stringValue(setting(logging, app, ["level", "log_level", "LOG_LEVEL"], "info")).toLowerCase(),
      runOnce: boolValue(runOnceOverride || setting(schedule, root, ["run_once", "RUN_ONCE"], false), false),
      cron: stringValue(setting(schedule, root, ["cron", "cron_schedule", "CRON_SCHEDULE", "SOURCE_CHECK_CRON"], "0 */5 * * * *")),
      runOnStart: boolValue(runOnStartOverride || setting(schedule, root, ["run_on_start", "RUN_ON_START"], true), true),
      lockFile: path.join(stateDir, "agent.lock"),
      stateFile: path.join(stateDir, "transferred.json")
    },
    sources: normalizedSources,
    source: normalizedSources[0],
    compression: normalizedSources[0].compression,
    metrics: {
      enabled: boolValue(setting(metrics, root, ["enabled", "METRICS_ENABLED"], false), false),
      host: stringValue(setting(metrics, root, ["host", "METRICS_HOST"], "0.0.0.0")),
      port: intValue(setting(metrics, root, ["port", "METRICS_PORT"], 9108), 9108),
      path: stringValue(setting(metrics, root, ["path", "METRICS_PATH"], "/metrics")),
      firewallRule: boolValue(setting(metrics, root, ["firewall_rule", "METRICS_FIREWALL_RULE"], false), false),
      firewallRuleName: stringValue(setting(metrics, root, ["firewall_rule_name", "METRICS_FIREWALL_RULE_NAME"], "backup-agent metrics"))
    },
    proxy: {
      url: proxyUrl(root)
    },
    destination: {
      host: stringValue(setting(destination, root, ["host", "address", "DEST_HOST", "DESTINATION_ADDRESS", "DESTINATION_HOST"])),
      port: intValue(setting(destination, root, ["port", "DEST_PORT", "DESTINATION_PORT"], 22), 22),
      remoteDir: stringValue(setting(destination, root, ["remote_dir", "path", "DEST_REMOTE_DIR", "DESTINATION_PATH", "DESTINATION_STORAGE_PATH"])),
      username: stringValue(setting(destination, root, ["user", "username", "DEST_USER", "DEST_USERNAME", "DESTINATION_USER"])),
      authMethod: stringValue(setting(destination, root, ["auth_method", "DEST_AUTH_METHOD", "DESTINATION_AUTH_METHOD"], "password")).toLowerCase(),
      password: stringValue(setting(destination, root, ["password", "DEST_PASSWORD", "DESTINATION_PASSWORD"])),
      privateKeyBase64: stringValue(setting(destination, root, ["private_key_base64", "DEST_PRIVATE_KEY_BASE64", "PRIVATE_KEY_BASE64", "DESTINATION_PRIVATE_KEY_BASE64"])),
      readyTimeoutMs: intValue(setting(destination, root, ["ready_timeout_ms", "SSH_READY_TIMEOUT_MS"], 30000), 30000),
      keepaliveIntervalMs: intValue(setting(destination, root, ["keepalive_interval_ms", "SSH_KEEPALIVE_INTERVAL_MS"], 20000), 20000),
      socks5Enabled: boolValue(setting(destination, root, [
        "use_proxy",
        "DESTINATION_USE_PROXY",
        "DEST_USE_PROXY",
        "TRANSFER_USE_PROXY",
        "SSH_USE_PROXY",
        "SSH_SOCKS5_ENABLED",
        "DEST_SOCKS5_ENABLED",
        "USE_SSH_SOCKS5_PROXY"
      ], false), false),
      socks5Proxy: proxyUrl(root, ["DESTINATION_PROXY", "DEST_PROXY", "SSH_SOCKS5_PROXY", "DEST_SOCKS5_PROXY"]),
      createDir: boolValue(setting(destination, root, ["create_dir", "CREATE_DESTINATION_DIR"], false), false),
      dirFormat: stringValue(setting(destination, root, ["dir_format", "DESTINATION_DIR_FORMAT"], "date")).toLowerCase()
    },
    update: {
      url: stringValue(setting(update, root, ["url", "UPDATE_URL"], DEFAULT_UPDATE_URL)),
      useProxy: boolValue(setting(update, root, ["use_proxy", "UPDATE_USE_PROXY", "UPDATE_DOWNLOAD_USE_PROXY"], false), false),
      proxy: proxyUrl(root, ["UPDATE_PROXY", "UPDATE_DOWNLOAD_PROXY"])
    },
    telegram: {
      mode: modeValue(setting(telegram, root, ["mode", "TELEGRAM_MODE", "TELEGRAM_SEND_MODE"], setting(telegram, root, ["enabled", "TELEGRAM_ENABLED"], "") !== "" ? "all" : "off")),
      fallback: stringValue(setting(telegram, root, ["fallback", "TELEGRAM_FALLBACK"], "off")).toLowerCase(),
      apiUrl: stringValue(setting(telegram, root, ["api_url", "TELEGRAM_API_URL"], "https://api.telegram.org")),
      useProxy: boolValue(setting(telegram, root, ["use_proxy", "TELEGRAM_USE_PROXY"], false), false),
      proxy: proxyUrl(root, ["TELEGRAM_PROXY"]),
      token: stringValue(setting(telegram, root, ["bot_token", "token", "TELEGRAM_BOT_TOKEN", "TELEGRAM_TOKEN"])),
      chatId: stringValue(setting(telegram, root, ["chat_id", "TELEGRAM_CHAT_ID"])),
      topicId: stringValue(setting(telegram, root, ["topic_id", "message_thread_id", "TELEGRAM_TOPIC_ID", "TELEGRAM_MESSAGE_THREAD_ID"]))
    },
    email: {
      mode: modeValue(setting(email, root, ["mode", "EMAIL_MODE", "EMAIL_SEND_MODE"], setting(email, root, ["enabled", "EMAIL_ENABLED"], "") !== "" ? "all" : "off")),
      fallback: stringValue(setting(email, root, ["fallback", "EMAIL_FALLBACK"], "off")).toLowerCase(),
      host: stringValue(setting(email, root, ["smtp_host", "host", "SMTP_HOST", "EMAIL_SMTP_HOST"])),
      port: intValue(setting(email, root, ["smtp_port", "port", "SMTP_PORT", "EMAIL_SMTP_PORT"], 465), 465),
      secure: boolValue(setting(email, root, ["smtp_ssl", "ssl", "secure", "SMTP_SSL", "EMAIL_SMTP_SSL"], true), true),
      user: stringValue(setting(email, root, ["smtp_user", "user", "SMTP_USER", "EMAIL_SMTP_USER"])),
      password: stringValue(setting(email, root, ["smtp_password", "password", "SMTP_PASSWORD", "EMAIL_SMTP_PASSWORD"])),
      from: stringValue(setting(email, root, ["from", "EMAIL_FROM", "SMTP_FROM"])),
      to: parseEmailList(setting(email, root, ["to", "EMAIL_TO"])),
      cc: parseEmailList(setting(email, root, ["cc", "EMAIL_CC"])),
      bcc: parseEmailList(setting(email, root, ["bcc", "EMAIL_BCC"])),
      useProxy: boolValue(setting(email, root, ["use_proxy", "EMAIL_USE_PROXY", "SMTP_USE_PROXY"], false), false),
      proxy: proxyUrl(root, ["EMAIL_PROXY", "SMTP_PROXY"]),
      subjectPrefix: stringValue(setting(email, root, ["subject_prefix", "EMAIL_SUBJECT_PREFIX"], "[backup-agent]"))
    }
  };

  return config;
}

function validateSocksProxyUrl(value) {
  const errors = [];
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return ["PROXY_URL must be a SOCKS proxy URL such as socks5://127.0.0.1:1080."];
  }

  if (!["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(parsed.protocol)) {
    errors.push("PROXY_URL must use socks4://, socks4a://, socks5://, or socks5h://.");
  }
  if (!parsed.hostname) {
    errors.push("PROXY_URL must include a proxy host.");
  }
  if (parsed.port && (!Number.isInteger(Number.parseInt(parsed.port, 10)) || Number.parseInt(parsed.port, 10) < 1 || Number.parseInt(parsed.port, 10) > 65535)) {
    errors.push("PROXY_URL proxy port must be from 1 to 65535.");
  }
  return errors;
}

function validateProxyRequirement(enabled, proxy, enabledName) {
  if (!enabled) {
    return [];
  }
  if (!proxy) {
    return [`PROXY_URL is required when ${enabledName}=true.`];
  }
  return validateSocksProxyUrl(proxy);
}

function validateSourceConfig(source, index) {
  const label = `sources.items[${index}]`;
  const errors = [];
  if (!source.name) errors.push(`${label}.name is required.`);
  if (!["files", "directory"].includes(source.mode)) {
    errors.push(`${label}.mode must be files or directory.`);
  }
  if (!source.dir) errors.push(`${label}.source_dir is required.`);
  if (source.mode === "files" && !source.pattern) {
    errors.push(`${label}.source_file_pattern is required when mode=files.`);
  }
  if (!Number.isInteger(source.minAgeSeconds) || source.minAgeSeconds < 0) {
    errors.push(`${label}.min_age_seconds must be a non-negative integer.`);
  }
  if (!["off", "time", "count"].includes(source.retentionPolicy)) {
    errors.push(`${label}.retention_policy must be off, time, or count.`);
  }
  if (source.retentionPolicy === "time" && !Number.isFinite(source.retentionTimeMs)) {
    errors.push(`${label}.retention_time must be a duration such as 60m, 1d, 7d, or 3w.`);
  }
  if (source.retentionPolicy === "count" && !Number.isFinite(source.retentionCount)) {
    errors.push(`${label}.retention_count must be a positive integer when retention_policy=count.`);
  }
  return errors;
}

function validateDestinationConfig(config) {
  const errors = [];
  if (!config.destination.host) errors.push("destination.host is required.");
  if (!Number.isInteger(config.destination.port) || config.destination.port < 1 || config.destination.port > 65535) {
    errors.push("destination.port must be a TCP port from 1 to 65535.");
  }
  if (!config.destination.remoteDir) errors.push("destination.remote_dir is required.");
  if (!config.destination.username) errors.push("destination.user is required.");
  if (!["password", "private_key", "key"].includes(config.destination.authMethod)) {
    errors.push("destination.auth_method must be password or private_key.");
  }
  if (config.destination.authMethod === "password" && !config.destination.password) {
    errors.push("destination.password is required when destination.auth_method=password.");
  }
  if (["private_key", "key"].includes(config.destination.authMethod) && !config.destination.privateKeyBase64) {
    errors.push("destination.private_key_base64 is required when destination.auth_method=private_key.");
  }
  errors.push(...validateProxyRequirement(
    config.destination.socks5Enabled,
    config.destination.socks5Proxy,
    "destination.use_proxy"
  ));
  if (config.destination.createDir && !["date", "hostname", "hostname+date"].includes(config.destination.dirFormat)) {
    errors.push("destination.dir_format must be date, hostname, or hostname+date when destination.create_dir=true.");
  }
  return errors;
}

function validateTelegramConfig(config) {
  const errors = [];
  if (!config.telegram.token) errors.push("notifications.telegram.bot_token is required.");
  if (!config.telegram.chatId) errors.push("notifications.telegram.chat_id is required.");
  errors.push(...validateProxyRequirement(config.telegram.useProxy, config.telegram.proxy, "notifications.telegram.use_proxy"));
  return errors;
}

function validateEmailConfig(config) {
  const errors = [];
  if (!config.email.host) errors.push("notifications.email.smtp_host is required.");
  if (!Number.isInteger(config.email.port) || config.email.port < 1 || config.email.port > 65535) {
    errors.push("notifications.email.smtp_port must be a TCP port from 1 to 65535.");
  }
  if (!config.email.from) errors.push("notifications.email.from is required.");
  if (config.email.to.length === 0) errors.push("notifications.email.to is required.");
  errors.push(...validateProxyRequirement(config.email.useProxy, config.email.proxy, "notifications.email.use_proxy"));
  return errors;
}

function validateConfig(config) {
  const errors = [];

  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    errors.push("sources.items must contain at least one source.");
  } else {
    const names = new Set();
    config.sources.forEach((source, index) => {
      errors.push(...validateSourceConfig(source, index));
      if (names.has(source.name)) {
        errors.push(`sources.items[${index}].name must be unique.`);
      }
      names.add(source.name);
    });
  }
  if (config.metrics.enabled) {
    if (!Number.isInteger(config.metrics.port) || config.metrics.port < 1 || config.metrics.port > 65535) {
      errors.push("metrics.port must be a TCP port from 1 to 65535.");
    }
    if (!config.metrics.path.startsWith("/")) {
      errors.push("metrics.path must start with /.");
    }
  }
  errors.push(...validateDestinationConfig(config));
  if (!["off", "email"].includes(config.telegram.fallback)) {
    errors.push("notifications.telegram.fallback must be off or email.");
  }
  if (!["off", "telegram"].includes(config.email.fallback)) {
    errors.push("notifications.email.fallback must be off or telegram.");
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
  validateSourceConfig,
  validateDestinationConfig,
  validateTelegramConfig,
  validateEmailConfig
};
