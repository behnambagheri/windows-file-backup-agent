const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig, validateConfig } = require("../src/config");

const DEFAULT_UPDATE_URL = "https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip";
const isolatedEnvironmentKeys = [
  "PROXY_URL",
  "GLOBAL_PROXY_URL",
  "UPDATE_URL",
  "UPDATE_USE_PROXY",
  "UPDATE_DOWNLOAD_USE_PROXY",
  "UPDATE_PROXY",
  "UPDATE_DOWNLOAD_PROXY",
  "DESTINATION_USE_PROXY",
  "DESTINATION_PROXY",
  "DEST_USE_PROXY",
  "DEST_PROXY",
  "TRANSFER_USE_PROXY",
  "SSH_USE_PROXY",
  "SSH_SOCKS5_ENABLED",
  "SSH_SOCKS5_PROXY",
  "DEST_SOCKS5_ENABLED",
  "DEST_SOCKS5_PROXY",
  "USE_SSH_SOCKS5_PROXY",
  "SOCKS5_PROXY",
  "TELEGRAM_ENABLED",
  "TELEGRAM_MODE",
  "TELEGRAM_FALLBACK",
  "TELEGRAM_USE_PROXY",
  "TELEGRAM_PROXY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_TOKEN",
  "TELEGRAM_CHAT_ID",
  "EMAIL_ENABLED",
  "EMAIL_MODE",
  "EMAIL_FALLBACK",
  "EMAIL_USE_PROXY",
  "EMAIL_PROXY",
  "SMTP_USE_PROXY",
  "SMTP_PROXY",
  "SMTP_HOST",
  "EMAIL_FROM",
  "EMAIL_TO"
];

function withTestEnv(content, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "backup-agent-config-"));
  const envFile = path.join(directory, ".env");
  fs.writeFileSync(envFile, content, "utf8");

  const originalEnvFile = process.env.ENV_FILE;
  const originalAgentHome = process.env.AGENT_HOME;
  const originalEnvironment = new Map(
    isolatedEnvironmentKeys.map((key) => [key, process.env[key]])
  );
  for (const key of isolatedEnvironmentKeys) {
    delete process.env[key];
  }
  process.env.ENV_FILE = envFile;
  process.env.AGENT_HOME = directory;
  try {
    return callback(loadConfig());
  } finally {
    if (originalEnvFile === undefined) delete process.env.ENV_FILE;
    else process.env.ENV_FILE = originalEnvFile;
    if (originalAgentHome === undefined) delete process.env.AGENT_HOME;
    else process.env.AGENT_HOME = originalAgentHome;
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const requiredConfig = [
  "SOURCE_DIR=C:\\Backups",
  "SOURCE_FILE_PATTERN=*.bak",
  "DEST_HOST=192.0.2.10",
  "DEST_PORT=22",
  "DEST_USER=backup-user",
  "DEST_REMOTE_DIR=/backups",
  "DEST_AUTH_METHOD=password",
  "DEST_PASSWORD=secret"
].join("\n");

test("default update URL points to the latest GitHub release asset", () => {
  withTestEnv(requiredConfig, (config) => {
    assert.equal(config.update.url, DEFAULT_UPDATE_URL);
    assert.deepEqual(validateConfig(config), []);
  });
});

test("shared proxy URL is reused by update, destination, Telegram, and email", () => {
  const content = [
    requiredConfig,
    "PROXY_URL=socks5://proxy.example:1080",
    "UPDATE_USE_PROXY=on",
    "DESTINATION_USE_PROXY=on",
    "TELEGRAM_MODE=all",
    "TELEGRAM_USE_PROXY=on",
    "TELEGRAM_BOT_TOKEN=test-token",
    "TELEGRAM_CHAT_ID=1234",
    "EMAIL_MODE=all",
    "EMAIL_USE_PROXY=on",
    "SMTP_HOST=smtp.example.com",
    "EMAIL_FROM=sender@example.com",
    "EMAIL_TO=receiver@example.com"
  ].join("\n");

  withTestEnv(content, (config) => {
    assert.equal(config.proxy.url, "socks5://proxy.example:1080");
    assert.equal(config.update.useProxy, true);
    assert.equal(config.update.proxy, "socks5://proxy.example:1080");
    assert.equal(config.destination.socks5Enabled, true);
    assert.equal(config.destination.socks5Proxy, "socks5://proxy.example:1080");
    assert.equal(config.telegram.useProxy, true);
    assert.equal(config.telegram.proxy, "socks5://proxy.example:1080");
    assert.equal(config.email.useProxy, true);
    assert.equal(config.email.proxy, "socks5://proxy.example:1080");
    assert.deepEqual(validateConfig(config), []);
  });
});

test("enabled destination proxy requires a shared proxy URL", () => {
  const content = [
    requiredConfig,
    "DESTINATION_USE_PROXY=true"
  ].join("\n");

  withTestEnv(content, (config) => {
    const errors = validateConfig(config);
    assert.ok(errors.includes("PROXY_URL is required when DESTINATION_USE_PROXY=true."));
  });
});

test("Telegram-to-email fallback requires valid email settings", () => {
  const content = [
    requiredConfig,
    "TELEGRAM_MODE=all",
    "TELEGRAM_FALLBACK=email",
    "TELEGRAM_BOT_TOKEN=test-token",
    "TELEGRAM_CHAT_ID=1234",
    "EMAIL_MODE=off"
  ].join("\n");

  withTestEnv(content, (config) => {
    const errors = validateConfig(config);
    assert.ok(errors.includes("SMTP_HOST is required."));
    assert.ok(errors.includes("EMAIL_FROM is required."));
    assert.ok(errors.includes("EMAIL_TO is required."));
  });
});

test("email-to-Telegram fallback requires valid Telegram settings", () => {
  const content = [
    requiredConfig,
    "EMAIL_MODE=all",
    "EMAIL_FALLBACK=telegram",
    "SMTP_HOST=smtp.example.com",
    "SMTP_PORT=465",
    "SMTP_SSL=true",
    "EMAIL_FROM=sender@example.com",
    "EMAIL_TO=receiver@example.com",
    "TELEGRAM_MODE=off"
  ].join("\n");

  withTestEnv(content, (config) => {
    const errors = validateConfig(config);
    assert.ok(errors.includes("TELEGRAM_BOT_TOKEN is required."));
    assert.ok(errors.includes("TELEGRAM_CHAT_ID is required."));
  });
});
