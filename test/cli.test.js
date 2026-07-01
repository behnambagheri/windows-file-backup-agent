const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const yaml = require("js-yaml");

function withTempConfig(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "backup-agent-cli-"));
  const configFile = path.join(directory, "config.yaml");
  fs.writeFileSync(configFile, String.raw`
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
metrics:
  enabled: false
  host: '0.0.0.0'
  port: 9108
  path: /metrics
  firewall_rule: false
`, "utf8");
  try {
    return callback({ directory, configFile });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runCli(configFile, directory, args) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "src", "cli.js"), ...args], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      CONFIG_FILE: configFile,
      AGENT_HOME: directory
    },
    encoding: "utf8"
  });
}

test("metrics CLI updates YAML config", () => {
  withTempConfig(({ directory, configFile }) => {
    const enable = runCli(configFile, directory, [
      "metrics",
      "enable",
      "--port",
      "9123",
      "--host",
      "127.0.0.1",
      "--path",
      "/agent-metrics",
      "--firewall"
    ]);
    assert.equal(enable.status, 0, enable.stderr || enable.stdout);

    const enabledConfig = yaml.load(fs.readFileSync(configFile, "utf8"));
    assert.equal(enabledConfig.metrics.enabled, true);
    assert.equal(enabledConfig.metrics.host, "127.0.0.1");
    assert.equal(enabledConfig.metrics.port, 9123);
    assert.equal(enabledConfig.metrics.path, "/agent-metrics");
    assert.equal(enabledConfig.metrics.firewall_rule, true);

    const disable = runCli(configFile, directory, ["metrics", "disable"]);
    assert.equal(disable.status, 0, disable.stderr || disable.stdout);

    const disabledConfig = yaml.load(fs.readFileSync(configFile, "utf8"));
    assert.equal(disabledConfig.metrics.enabled, false);
  });
});
