const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ProgressTracker, readProgress, formatProgress } = require("../src/progress");

function logger() {
  return {
    warn: () => {}
  };
}

function source() {
  return {
    name: "database_backups",
    mode: "files",
    dir: "C:\\Backups",
    pattern: "*.bak"
  };
}

function item() {
  return {
    kind: "file",
    name: "db.bak",
    path: "C:\\Backups\\db.bak",
    size: 100,
    fingerprint: "abc123"
  };
}

test("progress tracker writes queue, current item, bytes, and completion state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "backup-agent-progress-"));
  try {
    const config = {
      app: {
        name: "backup-agent",
        progressFile: path.join(directory, "state", "progress.json")
      }
    };
    const tracker = new ProgressTracker(config, logger());
    const testSource = source();
    const testItem = item();

    tracker.startCycle([testSource]);
    tracker.setQueue([{ source: testSource, item: testItem }]);
    tracker.startItem(testSource, testItem);
    tracker.setUpload(testSource, testItem, "/backups/db.bak", 100, false);
    tracker.addBytes(testSource, testItem, 40);
    tracker.flush(true);

    const running = readProgress(config);
    assert.equal(running.status, "running");
    assert.equal(running.current.name, "db.bak");
    assert.equal(running.totals.bytesTransferred, 40);
    assert.equal(running.totals.percent, 40);

    tracker.finishItem(testSource, testItem, {
      remotePath: "/backups/db.bak",
      uploadSize: 100,
      compressed: false
    });
    tracker.finishCycle(true);

    const completed = readProgress(config);
    assert.equal(completed.status, "completed");
    assert.equal(completed.current, null);
    assert.equal(completed.totals.completed, 1);
    assert.equal(completed.totals.percent, 100);
    assert.match(formatProgress(completed), /database_backups \| db\.bak/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
