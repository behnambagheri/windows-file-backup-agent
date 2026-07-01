const fs = require("fs");
const path = require("path");

function sourceLabel(source) {
  return source && source.name ? source.name : "default";
}

function nowIso() {
  return new Date().toISOString();
}

function percent(transferred, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return transferred > 0 ? 100 : 0;
  }
  return Math.min(100, Math.max(0, (transferred / total) * 100));
}

function itemId(source, item, index = 0) {
  const sourceName = sourceLabel(source);
  const key = item && (item.fingerprint || item.path || item.name) ? item.fingerprint || item.path || item.name : index;
  return `${sourceName}:${key}`;
}

function itemName(item) {
  if (!item) {
    return "";
  }
  return item.kind === "directory" ? `${item.name}/` : item.name;
}

function itemPath(item) {
  return item && item.path ? item.path : "";
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function recomputeTotals(progress) {
  const queue = Array.isArray(progress.queue) ? progress.queue : [];
  const bytesTotal = queue.reduce((sum, item) => sum + (Number.isFinite(item.bytesTotal) ? item.bytesTotal : 0), 0);
  const bytesTransferred = queue.reduce((sum, item) => sum + (Number.isFinite(item.bytesTransferred) ? item.bytesTransferred : 0), 0);
  progress.totals = {
    items: queue.length,
    queued: queue.filter((item) => item.status === "queued").length,
    running: queue.filter((item) => item.status === "running").length,
    completed: queue.filter((item) => item.status === "completed").length,
    failed: queue.filter((item) => item.status === "failed").length,
    bytesTotal,
    bytesTransferred,
    bytesRemaining: Math.max(0, bytesTotal - bytesTransferred),
    percent: percent(bytesTransferred, bytesTotal)
  };
}

class ProgressTracker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.progressFile = config.app.progressFile;
    this.lastFlushMs = 0;
    this.writeErrorLogged = false;
    this.progress = {
      version: 1,
      app: config.app.name || "backup-agent",
      status: "idle",
      cycleId: null,
      pid: process.pid,
      startedAt: null,
      updatedAt: nowIso(),
      finishedAt: null,
      sources: [],
      totals: {
        items: 0,
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        bytesTotal: 0,
        bytesTransferred: 0,
        bytesRemaining: 0,
        percent: 0
      },
      current: null,
      queue: []
    };
  }

  flush(force = false) {
    const currentMs = Date.now();
    if (!force && currentMs - this.lastFlushMs < 1000) {
      return;
    }
    this.progress.updatedAt = nowIso();
    try {
      writeJsonAtomic(this.progressFile, this.progress);
      this.lastFlushMs = currentMs;
    } catch (error) {
      if (!this.writeErrorLogged && this.logger && typeof this.logger.warn === "function") {
        this.logger.warn("Could not write progress state", {
          progressFile: this.progressFile,
          error: error.message
        });
      }
      this.writeErrorLogged = true;
    }
  }

  startCycle(sources) {
    const startedAt = nowIso();
    this.progress = {
      ...this.progress,
      status: "planning",
      cycleId: `${Date.now()}-${process.pid}`,
      pid: process.pid,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      sources: (sources || []).map((source) => ({
        name: sourceLabel(source),
        mode: source.mode || "files",
        dir: source.dir || "",
        pattern: source.mode === "files" ? source.pattern : undefined
      })),
      current: null,
      queue: []
    };
    recomputeTotals(this.progress);
    this.flush(true);
  }

  setQueue(plannedItems = []) {
    this.progress.status = plannedItems.length > 0 ? "running" : "completed";
    this.progress.queue = plannedItems.map(({ source, item }, index) => ({
      id: itemId(source, item, index),
      source: sourceLabel(source),
      name: itemName(item),
      path: itemPath(item),
      kind: item.kind || "file",
      status: "queued",
      phase: "queued",
      remotePath: "",
      detail: "",
      bytesTotal: Number.isFinite(item.size) ? item.size : 0,
      bytesTransferred: 0,
      percent: 0,
      error: "",
      compressed: false,
      startedAt: null,
      finishedAt: null
    }));
    if (plannedItems.length === 0) {
      this.progress.finishedAt = nowIso();
    }
    recomputeTotals(this.progress);
    this.flush(true);
  }

  findQueueItem(source, item) {
    const id = itemId(source, item);
    return this.progress.queue.find((entry) => entry.id === id);
  }

  startItem(source, item) {
    const entry = this.findQueueItem(source, item);
    if (!entry) {
      return;
    }
    entry.status = "running";
    entry.phase = "preparing";
    entry.startedAt = nowIso();
    entry.error = "";
    this.progress.status = "running";
    this.progress.current = { ...entry };
    recomputeTotals(this.progress);
    this.flush(true);
  }

  setCurrentPhase(phase, extra = {}, force = false) {
    if (!this.progress.current) {
      return;
    }
    const entry = this.progress.queue.find((item) => item.id === this.progress.current.id);
    if (entry) {
      entry.phase = phase;
      Object.assign(entry, extra);
      entry.percent = percent(entry.bytesTransferred, entry.bytesTotal);
      this.progress.current = { ...entry };
    } else {
      this.progress.current = {
        ...this.progress.current,
        ...extra,
        phase
      };
    }
    recomputeTotals(this.progress);
    this.flush(force);
  }

  setUpload(source, item, remotePath, bytesTotal, compressed = false) {
    const entry = this.findQueueItem(source, item);
    if (!entry) {
      return;
    }
    entry.phase = "uploading";
    entry.remotePath = remotePath || "";
    entry.bytesTotal = Number.isFinite(bytesTotal) ? bytesTotal : entry.bytesTotal;
    entry.percent = percent(entry.bytesTransferred, entry.bytesTotal);
    entry.compressed = !!compressed;
    this.progress.current = { ...entry };
    recomputeTotals(this.progress);
    this.flush(true);
  }

  addBytes(source, item, bytes) {
    const entry = this.findQueueItem(source, item);
    if (!entry) {
      return;
    }
    const amount = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    entry.bytesTransferred = Math.min(entry.bytesTotal || entry.bytesTransferred + amount, entry.bytesTransferred + amount);
    entry.percent = percent(entry.bytesTransferred, entry.bytesTotal);
    this.progress.current = { ...entry };
    recomputeTotals(this.progress);
    this.flush();
  }

  finishItem(source, item, result) {
    const entry = this.findQueueItem(source, item);
    if (!entry) {
      return;
    }
    entry.status = "completed";
    entry.phase = "completed";
    entry.remotePath = result.remotePath || entry.remotePath;
    entry.bytesTotal = Number.isFinite(result.uploadSize) ? result.uploadSize : entry.bytesTotal;
    entry.bytesTransferred = entry.bytesTotal;
    entry.percent = 100;
    entry.compressed = !!result.compressed;
    entry.finishedAt = nowIso();
    this.progress.current = null;
    recomputeTotals(this.progress);
    this.flush(true);
  }

  failItem(source, item, result) {
    const entry = this.findQueueItem(source, item);
    if (!entry) {
      return;
    }
    entry.status = "failed";
    entry.phase = "failed";
    entry.remotePath = result.remotePath || entry.remotePath;
    entry.error = result.error ? result.error.message : "Unknown transfer error";
    entry.finishedAt = nowIso();
    entry.percent = percent(entry.bytesTransferred, entry.bytesTotal);
    this.progress.current = null;
    recomputeTotals(this.progress);
    this.flush(true);
  }

  finishCycle(success) {
    this.progress.status = success ? "completed" : "failed";
    this.progress.current = null;
    this.progress.finishedAt = nowIso();
    recomputeTotals(this.progress);
    this.flush(true);
  }
}

function readProgress(config) {
  const filePath = config.app.progressFile;
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function formatBytes(value) {
  const bytes = Number.isFinite(value) ? value : 0;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

function formatPercent(value) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
}

function formatQueueLine(item) {
  const progress = `${formatBytes(item.bytesTransferred)} / ${formatBytes(item.bytesTotal)} (${formatPercent(item.percent)})`;
  const remote = item.remotePath ? ` -> ${item.remotePath}` : "";
  const detail = item.detail ? ` (${item.detail})` : "";
  const error = item.error ? ` ERROR: ${item.error}` : "";
  return `[${item.status}:${item.phase}] ${item.source} | ${item.name} | ${progress}${remote}${detail}${error}`;
}

function appendItems(lines, title, items, maxItems) {
  if (items.length === 0) {
    return;
  }
  lines.push(title);
  for (const item of items.slice(0, maxItems)) {
    lines.push(`  ${formatQueueLine(item)}`);
  }
  if (items.length > maxItems) {
    lines.push(`  ... ${items.length - maxItems} more items hidden. Use --json for the full queue.`);
  }
}

function formatProgress(progress, options = {}) {
  const maxItems = options.maxItems || 50;
  const totals = progress.totals || {};
  const queue = Array.isArray(progress.queue) ? progress.queue : [];
  const lines = [
    "backup-agent progress",
    `Status: ${progress.status || "unknown"}`,
    `Cycle: ${progress.cycleId || "none"}`,
    `Started: ${progress.startedAt || "n/a"}`,
    `Updated: ${progress.updatedAt || "n/a"}`,
    `Finished: ${progress.finishedAt || "n/a"}`,
    `Items: ${totals.items || 0} total, ${totals.completed || 0} completed, ${totals.running || 0} running, ${totals.queued || 0} queued, ${totals.failed || 0} failed`,
    `Bytes: ${formatBytes(totals.bytesTransferred)} / ${formatBytes(totals.bytesTotal)} (${formatPercent(totals.percent)}), remaining ${formatBytes(totals.bytesRemaining)}`
  ];

  if (progress.current) {
    lines.push("Current:");
    lines.push(`  ${formatQueueLine(progress.current)}`);
  }

  appendItems(lines, "Queued:", queue.filter((item) => item.status === "queued"), maxItems);
  appendItems(lines, "Running:", queue.filter((item) => item.status === "running"), maxItems);
  appendItems(lines, "Completed:", queue.filter((item) => item.status === "completed"), maxItems);
  appendItems(lines, "Failed:", queue.filter((item) => item.status === "failed"), maxItems);

  return lines.join("\n");
}

module.exports = {
  ProgressTracker,
  readProgress,
  formatProgress,
  writeJsonAtomic
};
