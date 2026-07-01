const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { listSourceFiles, listDirectorySource } = require("../src/transfer");

function logger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}

function source(overrides = {}) {
  return {
    name: "test_source",
    mode: "files",
    dir: "",
    pattern: "*.bak",
    latestOnly: false,
    minAgeSeconds: 0,
    deleteOnSuccess: false,
    skipAlreadyTransferred: true,
    retentionPolicy: "off",
    retentionTime: "off",
    retentionTimeMs: null,
    retentionMinutes: null,
    retentionCount: null,
    compression: {
      enabled: false,
      level: 9,
      tempDir: ""
    },
    ...overrides
  };
}

async function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "backup-agent-transfer-"));
  try {
    return await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writeFile(filePath, content, mtime = new Date(Date.now() - 60000)) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, mtime, mtime);
}

test("file source lists matching files and skips already transferred fingerprints", async () => {
  await withTempDir(async (directory) => {
    writeFile(path.join(directory, "database.bak"), "backup");
    writeFile(path.join(directory, "ignore.txt"), "ignore");
    const state = { transferred: {} };
    const config = { source: source({ dir: directory }) };

    const files = await listSourceFiles(config, state, logger(), config.source);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "database.bak");
    assert.equal(files[0].sourceName, "test_source");

    state.transferred[files[0].fingerprint] = { transferredAt: new Date().toISOString() };
    const skipped = await listSourceFiles(config, state, logger(), config.source);
    assert.equal(skipped.length, 0);
  });
});

test("file source latest_only returns the newest matching file", async () => {
  await withTempDir(async (directory) => {
    writeFile(path.join(directory, "old.bak"), "old", new Date(Date.now() - 120000));
    writeFile(path.join(directory, "new.bak"), "new", new Date(Date.now() - 60000));
    const config = { source: source({ dir: directory, latestOnly: true }) };

    const files = await listSourceFiles(config, { transferred: {} }, logger(), config.source);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "new.bak");
  });
});

test("directory source produces one recursive transfer item", async () => {
  await withTempDir(async (directory) => {
    writeFile(path.join(directory, "root.txt"), "root");
    writeFile(path.join(directory, "nested", "child.txt"), "child");
    fs.mkdirSync(path.join(directory, "empty"), { recursive: true });
    const config = { source: source({ name: "app_data", mode: "directory", dir: directory }) };

    const items = await listDirectorySource(config, { transferred: {} }, logger(), config.source);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "directory");
    assert.equal(items[0].sourceName, "app_data");
    assert.equal(items[0].files.length, 2);
    assert.ok(items[0].directories.some((entry) => entry.relativePath === "empty"));
    assert.ok(items[0].directories.some((entry) => entry.relativePath === "nested"));
    assert.ok(items[0].fingerprint);
  });
});
