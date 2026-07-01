const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readProgress } = require("../src/progress");
const { listSourceFiles, listDirectorySource, runTransferCycle, runRetentionCleanup } = require("../src/transfer");

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
    retentionPerspectiveScope: "",
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

function listNames(directory) {
  return fs.readdirSync(directory).sort((a, b) => a.localeCompare(b));
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

test("transfer cycle writes completed progress when no source items match", async () => {
  await withTempDir(async (directory) => {
    const stateDir = path.join(directory, "state");
    const testSource = source({ dir: directory, pattern: "*.bak" });
    const config = {
      app: {
        name: "backup-agent",
        stateDir,
        stateFile: path.join(stateDir, "transferred.json"),
        progressFile: path.join(stateDir, "progress.json")
      },
      source: testSource,
      sources: [testSource]
    };

    const results = await runTransferCycle(config, logger());
    const progress = readProgress(config);

    assert.deepEqual(results, []);
    assert.equal(progress.status, "completed");
    assert.equal(progress.totals.items, 0);
  });
});

test("smart retention keeps the larger set from count or time", async () => {
  await withTempDir(async (directory) => {
    const now = new Date("2026-07-15T12:00:00");
    for (let index = 0; index < 40; index += 1) {
      writeFile(
        path.join(directory, `recent-${String(index).padStart(2, "0")}.bak`),
        "recent",
        new Date(now.getTime() - (index + 1) * 60 * 1000)
      );
    }
    for (let index = 0; index < 20; index += 1) {
      writeFile(
        path.join(directory, `old-${String(index).padStart(2, "0")}.bak`),
        "old",
        new Date(now.getTime() - (10 * 24 * 60 * 60 * 1000) - (index + 1) * 60 * 1000)
      );
    }

    const testSource = source({
      dir: directory,
      retentionPolicy: "smart",
      retentionTime: "5d",
      retentionTimeMs: 5 * 24 * 60 * 60 * 1000,
      retentionMinutes: 5 * 24 * 60,
      retentionCount: 30
    });
    const result = await runRetentionCleanup({ source: testSource }, logger(), new Set(), testSource, now);
    const remaining = listNames(directory);

    assert.equal(result.deleted, 20);
    assert.equal(remaining.length, 40);
    assert.ok(remaining.every((name) => name.startsWith("recent-")));
  });

  await withTempDir(async (directory) => {
    const now = new Date("2026-07-15T12:00:00");
    for (let index = 0; index < 10; index += 1) {
      writeFile(
        path.join(directory, `recent-${String(index).padStart(2, "0")}.bak`),
        "recent",
        new Date(now.getTime() - (index + 1) * 60 * 1000)
      );
    }
    for (let index = 0; index < 20; index += 1) {
      writeFile(
        path.join(directory, `old-${String(index).padStart(2, "0")}.bak`),
        "old",
        new Date(now.getTime() - (10 * 24 * 60 * 60 * 1000) - (index + 1) * 60 * 1000)
      );
    }

    const testSource = source({
      dir: directory,
      retentionPolicy: "smart",
      retentionTime: "5d",
      retentionTimeMs: 5 * 24 * 60 * 60 * 1000,
      retentionMinutes: 5 * 24 * 60,
      retentionCount: 20
    });
    const result = await runRetentionCleanup({ source: testSource }, logger(), new Set(), testSource, now);

    assert.equal(result.deleted, 10);
    assert.equal(listNames(directory).length, 20);
  });
});

test("perspective retention keeps current scope and oldest calendar representatives", async () => {
  await withTempDir(async (directory) => {
    const now = new Date("2026-07-15T12:00:00");
    const files = [
      ["today-a.bak", "2026-07-15T10:00:00"],
      ["today-b.bak", "2026-07-15T11:00:00"],
      ["july-week-1-oldest.bak", "2026-07-01T01:00:00"],
      ["july-week-1-newer.bak", "2026-07-02T01:00:00"],
      ["july-week-2-oldest.bak", "2026-07-08T01:00:00"],
      ["feb-oldest.bak", "2026-02-01T01:00:00"],
      ["feb-newer.bak", "2026-02-02T01:00:00"],
      ["march-oldest.bak", "2026-03-01T01:00:00"],
      ["year-2024-oldest.bak", "2024-01-01T01:00:00"],
      ["year-2024-newer.bak", "2024-06-01T01:00:00"],
      ["year-2025-oldest.bak", "2025-01-01T01:00:00"]
    ];
    for (const [name, mtime] of files) {
      writeFile(path.join(directory, name), name, new Date(mtime));
    }

    const testSource = source({
      dir: directory,
      retentionPolicy: "perspective",
      retentionPerspectiveScope: "day"
    });
    const result = await runRetentionCleanup({ source: testSource }, logger(), new Set(), testSource, now);
    const remaining = listNames(directory);

    assert.equal(result.deleted, 3);
    assert.deepEqual(remaining, [
      "feb-oldest.bak",
      "july-week-1-oldest.bak",
      "july-week-2-oldest.bak",
      "march-oldest.bak",
      "today-a.bak",
      "today-b.bak",
      "year-2024-oldest.bak",
      "year-2025-oldest.bak"
    ]);
  });
});
