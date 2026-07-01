const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig, validateConfig } = require("../src/config");

const DEFAULT_UPDATE_URL = "https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip";
const isolatedEnvironmentKeys = [
  "CONFIG_FILE",
  "BACKUP_AGENT_CONFIG",
  "AGENT_HOME",
  "RUN_ONCE",
  "RUN_ON_START",
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

function withTestConfig(content, callback, fileName = "config.yaml") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "backup-agent-config-"));
  const configFile = path.join(directory, fileName);
  fs.writeFileSync(configFile, content, "utf8");

  const originalEnvironment = new Map(
    isolatedEnvironmentKeys.map((key) => [key, process.env[key]])
  );
  for (const key of isolatedEnvironmentKeys) {
    delete process.env[key];
  }
  process.env.CONFIG_FILE = configFile;
  process.env.AGENT_HOME = directory;
  try {
    return callback(loadConfig());
  } finally {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function requiredYaml(sources = String.raw`
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
`) {
  return String.raw`
destination:
  host: '192.0.2.10'
  port: 22
  user: backup-user
  remote_dir: /backups
  auth_method: password
  password: secret
${sources}
`;
}

test("default update URL points to the latest GitHub release asset", () => {
  withTestConfig(requiredYaml(), (config) => {
    assert.equal(config.app.configKind, "yaml");
    assert.equal(config.update.url, DEFAULT_UPDATE_URL);
    assert.deepEqual(validateConfig(config), []);
  });
});

test("source defaults apply and item overrides win", () => {
  const sources = String.raw`
sources:
  defaults:
    mode: files
    source_file_pattern: '*.bak'
    latest_only: true
    min_age_seconds: 30
    delete_on_success: false
    compression: false
    retention_policy: time
    retention_time: 1d
    skip_already_transferred: true
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
    - name: log_archives
      source_dir: 'C:\Logs'
      source_file_pattern: '*.zip'
      latest_only: false
      compression: true
      retention_policy: count
      retention_count: 3
`;

  withTestConfig(requiredYaml(sources), (config) => {
    assert.equal(config.sources.length, 2);
    assert.equal(config.sources[0].name, "database_backups");
    assert.equal(config.sources[0].pattern, "*.bak");
    assert.equal(config.sources[0].latestOnly, true);
    assert.equal(config.sources[0].minAgeSeconds, 30);
    assert.equal(config.sources[0].retentionPolicy, "time");
    assert.equal(config.sources[0].retentionTime, "1d");
    assert.equal(config.sources[1].name, "log_archives");
    assert.equal(config.sources[1].pattern, "*.zip");
    assert.equal(config.sources[1].latestOnly, false);
    assert.equal(config.sources[1].compression.enabled, true);
    assert.equal(config.sources[1].retentionPolicy, "count");
    assert.equal(config.sources[1].retentionCount, 3);
    assert.deepEqual(validateConfig(config), []);
  });
});

test("directory source mode is accepted and can use compression object syntax", () => {
  const sources = String.raw`
sources:
  defaults:
    min_age_seconds: 5
    skip_already_transferred: true
  items:
    - name: app_data
      mode: directory
      source_dir: 'D:\AppData'
      compression:
        enabled: true
        level: 7
      retention_policy: off
`;

  withTestConfig(requiredYaml(sources), (config) => {
    assert.equal(config.sources[0].mode, "directory");
    assert.equal(config.sources[0].dir, "D:\\AppData");
    assert.equal(config.sources[0].compression.enabled, true);
    assert.equal(config.sources[0].compression.level, 7);
    assert.equal(config.sources[0].retentionPolicy, "off");
    assert.deepEqual(validateConfig(config), []);
  });
});

test("smart and perspective retention policies validate", () => {
  const sources = String.raw`
sources:
  defaults:
    source_file_pattern: '*.bak'
    retention_policy: smart
    retention_time: 5d
    retention_count: 30
  items:
    - name: smart_backups
      source_dir: 'C:\Backups'
    - name: perspective_backups
      source_dir: 'C:\Archives'
      retention_policy: perspective
      perspective_scope: day
`;

  withTestConfig(requiredYaml(sources), (config) => {
    assert.equal(config.sources[0].retentionPolicy, "smart");
    assert.equal(config.sources[0].retentionTime, "5d");
    assert.equal(config.sources[0].retentionCount, 30);
    assert.equal(config.sources[1].retentionPolicy, "perspective");
    assert.equal(config.sources[1].retentionPerspectiveScope, "day");
    assert.equal(config.sources[1].retentionTimeMs, null);
    assert.equal(config.sources[1].retentionCount, null);
    assert.deepEqual(validateConfig(config), []);
  });
});

test("smart retention can be inferred when both time and count are set", () => {
  const sources = String.raw`
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
      retention_time: 5d
      retention_count: 30
`;

  withTestConfig(requiredYaml(sources), (config) => {
    assert.equal(config.sources[0].retentionPolicy, "smart");
    assert.equal(config.sources[0].retentionTime, "5d");
    assert.equal(config.sources[0].retentionCount, 30);
    assert.deepEqual(validateConfig(config), []);
  });
});

test("perspective retention requires a valid scope", () => {
  const sources = String.raw`
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
      retention_policy: perspective
`;

  withTestConfig(requiredYaml(sources), (config) => {
    const errors = validateConfig(config);
    assert.ok(errors.includes("sources.items[0].perspective_scope must be hour, day, week, month, or year when retention_policy=perspective."));
  });
});

test("shared proxy fields are reused by update, destination, Telegram, and email", () => {
  const content = String.raw`
proxy:
  protocol: socks5
  host: proxy.example
  port: 1080
  username: proxy-user
  password: proxy-secret
update:
  use_proxy: on
destination:
  host: '192.0.2.10'
  port: 22
  user: backup-user
  remote_dir: /backups
  auth_method: password
  password: secret
  use_proxy: on
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
notifications:
  telegram:
    mode: all
    use_proxy: on
    bot_token: test-token
    chat_id: '1234'
  email:
    mode: all
    use_proxy: on
    smtp_host: smtp.example.com
    from: sender@example.com
    to:
      - receiver@example.com
`;

  withTestConfig(content, (config) => {
    assert.equal(config.proxy.protocol, "socks5");
    assert.equal(config.proxy.host, "proxy.example");
    assert.equal(config.proxy.port, 1080);
    assert.equal(config.proxy.username, "proxy-user");
    assert.equal(config.proxy.password, "proxy-secret");
    assert.equal(config.proxy.url, "socks5://proxy-user:proxy-secret@proxy.example:1080");
    assert.equal(config.update.useProxy, true);
    assert.equal(config.update.proxy, "socks5://proxy-user:proxy-secret@proxy.example:1080");
    assert.equal(config.destination.socks5Enabled, true);
    assert.equal(config.destination.socks5Proxy, "socks5://proxy-user:proxy-secret@proxy.example:1080");
    assert.equal(config.telegram.useProxy, true);
    assert.equal(config.telegram.proxy, "socks5://proxy-user:proxy-secret@proxy.example:1080");
    assert.equal(config.email.useProxy, true);
    assert.equal(config.email.proxy, "socks5://proxy-user:proxy-secret@proxy.example:1080");
    assert.deepEqual(validateConfig(config), []);
  });
});

test("shared proxy username and password are optional", () => {
  const content = String.raw`
proxy:
  protocol: socks5
  host: proxy.example
  port: 1080
destination:
  host: '192.0.2.10'
  port: 22
  user: backup-user
  remote_dir: /backups
  auth_method: password
  password: secret
  use_proxy: true
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
`;

  withTestConfig(content, (config) => {
    assert.equal(config.proxy.url, "socks5://proxy.example:1080");
    assert.equal(config.destination.socks5Proxy, "socks5://proxy.example:1080");
    assert.deepEqual(validateConfig(config), []);
  });
});

test("enabled destination proxy requires shared proxy host", () => {
  const content = String.raw`
destination:
  host: '192.0.2.10'
  port: 22
  user: backup-user
  remote_dir: /backups
  auth_method: password
  password: secret
  use_proxy: true
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
`;

  withTestConfig(content, (config) => {
    const errors = validateConfig(config);
    assert.ok(errors.includes("proxy.host is required when destination.use_proxy=true."));
  });
});

test("Telegram-to-email fallback requires valid email settings", () => {
  const content = String.raw`
destination:
  host: '192.0.2.10'
  port: 22
  user: backup-user
  remote_dir: /backups
  auth_method: password
  password: secret
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
notifications:
  telegram:
    mode: all
    fallback: email
    bot_token: test-token
    chat_id: '1234'
  email:
    mode: off
`;

  withTestConfig(content, (config) => {
    const errors = validateConfig(config);
    assert.ok(errors.includes("notifications.email.smtp_host is required."));
    assert.ok(errors.includes("notifications.email.from is required."));
    assert.ok(errors.includes("notifications.email.to is required."));
  });
});

test("email-to-Telegram fallback requires valid Telegram settings", () => {
  const content = String.raw`
destination:
  host: '192.0.2.10'
  port: 22
  user: backup-user
  remote_dir: /backups
  auth_method: password
  password: secret
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups'
notifications:
  email:
    mode: all
    fallback: telegram
    smtp_host: smtp.example.com
    smtp_port: 465
    smtp_ssl: true
    from: sender@example.com
    to:
      - receiver@example.com
  telegram:
    mode: off
`;

  withTestConfig(content, (config) => {
    const errors = validateConfig(config);
    assert.ok(errors.includes("notifications.telegram.bot_token is required."));
    assert.ok(errors.includes("notifications.telegram.chat_id is required."));
  });
});

test("YAML config must define at least one source item", () => {
  const content = String.raw`
destination:
  host: '192.0.2.10'
  port: 22
  user: backup-user
  remote_dir: /backups
  auth_method: password
  password: secret
sources:
  items: []
`;

  withTestConfig(content, (config) => {
    assert.equal(config.app.configKind, "yaml");
    assert.equal(config.sources.length, 0);
    assert.ok(validateConfig(config).includes("sources.items must contain at least one source."));
  });
});
