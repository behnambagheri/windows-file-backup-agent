const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig, validateConfig } = require("../src/config");

const DEFAULT_UPDATE_URL = "https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip";
const isolatedEnvironmentKeys = [
  "UPDATE_URL",
  "TELEGRAM_ENABLED",
  "TELEGRAM_MODE",
  "TELEGRAM_FALLBACK",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_TOKEN",
  "TELEGRAM_CHAT_ID",
  "EMAIL_ENABLED",
  "EMAIL_MODE",
  "EMAIL_FALLBACK",
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
