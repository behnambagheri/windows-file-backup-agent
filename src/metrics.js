const fs = require("fs");
const http = require("http");
const path = require("path");
const packageInfo = require("../package.json");

function wildcardToRegex(pattern) {
  const normalized = pattern.includes("*") || pattern.includes("?") ? pattern : `*${pattern}`;
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i");
}

function labelValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function metricLine(name, value, labels = {}) {
  const labelEntries = Object.entries(labels);
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([key, val]) => `${key}="${labelValue(val)}"`).join(",")}}`
    : "";
  return `${name}${labelText} ${Number.isFinite(value) ? value : 0}`;
}

function sourceLabels(labels, source) {
  return {
    ...labels,
    source: source.name || "default",
    mode: source.mode || "files"
  };
}

function ensureBucket(map, key) {
  if (!map[key]) {
    map[key] = { success: 0, failure: 0 };
  }
  return map[key];
}

async function walkDirectoryFiles(rootDir, visitor) {
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectoryFiles(fullPath, visitor);
    } else if (entry.isFile()) {
      await visitor(fullPath);
    }
  }
}

class Metrics {
  constructor(config) {
    this.config = config;
    this.startedAt = Date.now();
    this.server = null;
    this.active = 0;
    this.lastCycleStart = 0;
    this.lastCycleEnd = 0;
    this.lastCycleDurationSeconds = 0;
    this.lastCycleSuccess = 1;
    this.lastTransferTimestamp = 0;
    this.cycles = { success: 0, failure: 0 };
    this.items = {};
    this.originalBytes = {};
    this.uploadBytes = {};
    this.lastErrorTimestamp = 0;
  }

  cycleStarted() {
    this.active = 1;
    this.lastCycleStart = Date.now();
  }

  cycleFinished(success, results = []) {
    this.active = 0;
    this.lastCycleEnd = Date.now();
    this.lastCycleDurationSeconds = this.lastCycleStart
      ? (this.lastCycleEnd - this.lastCycleStart) / 1000
      : 0;
    this.lastCycleSuccess = success ? 1 : 0;
    this.cycles[success ? "success" : "failure"] += 1;
    if (!success) {
      this.lastErrorTimestamp = this.lastCycleEnd;
    }

    for (const result of results) {
      const status = result.success ? "success" : "failure";
      const sourceName = result.sourceName || (result.file ? result.file.sourceName : "") || "default";
      ensureBucket(this.items, sourceName)[status] += 1;
      this.lastTransferTimestamp = this.lastCycleEnd;
      if (!result.success) {
        this.lastErrorTimestamp = this.lastCycleEnd;
        continue;
      }
      this.originalBytes[sourceName] = (this.originalBytes[sourceName] || 0) + (result.file ? result.file.size || 0 : 0);
      this.uploadBytes[sourceName] = (this.uploadBytes[sourceName] || 0) + (result.uploadSize || (result.file ? result.file.size || 0 : 0));
    }
  }

  cycleCrashed() {
    this.cycleFinished(false, []);
  }

  async sourceStats(source) {
    const now = Date.now();
    let count = 0;
    let oldestAgeSeconds = 0;
    try {
      if (source.mode === "directory") {
        const rootStats = await fs.promises.stat(source.dir);
        if (!rootStats.isDirectory()) {
          return { available: 0, count: 0, oldestAgeSeconds: 0 };
        }
        await walkDirectoryFiles(source.dir, async (filePath) => {
          const stats = await fs.promises.stat(filePath);
          count += 1;
          oldestAgeSeconds = Math.max(oldestAgeSeconds, Math.floor((now - stats.mtimeMs) / 1000));
        });
        return { available: 1, count, oldestAgeSeconds };
      }

      const matcher = wildcardToRegex(source.pattern || "*");
      const entries = await fs.promises.readdir(source.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !matcher.test(entry.name)) {
          continue;
        }
        const stats = await fs.promises.stat(path.join(source.dir, entry.name));
        count += 1;
        oldestAgeSeconds = Math.max(oldestAgeSeconds, Math.floor((now - stats.mtimeMs) / 1000));
      }
    } catch {
      return { available: 0, count: 0, oldestAgeSeconds: 0 };
    }
    return { available: 1, count, oldestAgeSeconds };
  }

  async render() {
    const memory = process.memoryUsage();
    const sources = Array.isArray(this.config.sources) && this.config.sources.length > 0
      ? this.config.sources
      : [this.config.source];
    const stats = await Promise.all(sources.map(async (source) => ({
      source,
      stats: await this.sourceStats(source)
    })));
    const labels = {
      app: this.config.app.name,
      hostname: this.config.app.hostname
    };
    const lines = [
      "# HELP backup_agent_up Whether the backup-agent process is running.",
      "# TYPE backup_agent_up gauge",
      metricLine("backup_agent_up", 1, labels),
      "# HELP backup_agent_build_info Build and host information.",
      "# TYPE backup_agent_build_info gauge",
      metricLine("backup_agent_build_info", 1, { ...labels, version: packageInfo.version }),
      "# HELP backup_agent_process_uptime_seconds Process uptime in seconds.",
      "# TYPE backup_agent_process_uptime_seconds gauge",
      metricLine("backup_agent_process_uptime_seconds", Math.floor(process.uptime()), labels),
      "# HELP backup_agent_process_resident_memory_bytes Resident memory size in bytes.",
      "# TYPE backup_agent_process_resident_memory_bytes gauge",
      metricLine("backup_agent_process_resident_memory_bytes", memory.rss, labels),
      "# HELP backup_agent_transfer_cycle_active Whether a transfer cycle is currently running.",
      "# TYPE backup_agent_transfer_cycle_active gauge",
      metricLine("backup_agent_transfer_cycle_active", this.active, labels),
      "# HELP backup_agent_transfer_cycles_total Transfer cycles by status.",
      "# TYPE backup_agent_transfer_cycles_total counter",
      metricLine("backup_agent_transfer_cycles_total", this.cycles.success, { ...labels, status: "success" }),
      metricLine("backup_agent_transfer_cycles_total", this.cycles.failure, { ...labels, status: "failure" }),
      "# HELP backup_agent_items_total Transfer items attempted by source and status.",
      "# TYPE backup_agent_items_total counter",
      "# HELP backup_agent_original_bytes_total Original source bytes successfully uploaded by source.",
      "# TYPE backup_agent_original_bytes_total counter",
      "# HELP backup_agent_uploaded_bytes_total Uploaded bytes after optional compression by source.",
      "# TYPE backup_agent_uploaded_bytes_total counter"
    ];

    for (const source of sources) {
      const sourceName = source.name || "default";
      const sourceMetricLabels = sourceLabels(labels, source);
      const itemBucket = this.items[sourceName] || { success: 0, failure: 0 };
      lines.push(metricLine("backup_agent_items_total", itemBucket.success, { ...sourceMetricLabels, status: "success" }));
      lines.push(metricLine("backup_agent_items_total", itemBucket.failure, { ...sourceMetricLabels, status: "failure" }));
      lines.push(metricLine("backup_agent_original_bytes_total", this.originalBytes[sourceName] || 0, sourceMetricLabels));
      lines.push(metricLine("backup_agent_uploaded_bytes_total", this.uploadBytes[sourceName] || 0, sourceMetricLabels));
    }

    lines.push(
      "# HELP backup_agent_last_cycle_timestamp_seconds Last transfer cycle completion timestamp.",
      "# TYPE backup_agent_last_cycle_timestamp_seconds gauge",
      metricLine("backup_agent_last_cycle_timestamp_seconds", Math.floor(this.lastCycleEnd / 1000), labels),
      "# HELP backup_agent_last_cycle_duration_seconds Last transfer cycle duration.",
      "# TYPE backup_agent_last_cycle_duration_seconds gauge",
      metricLine("backup_agent_last_cycle_duration_seconds", this.lastCycleDurationSeconds, labels),
      "# HELP backup_agent_last_cycle_success Whether the last transfer cycle succeeded.",
      "# TYPE backup_agent_last_cycle_success gauge",
      metricLine("backup_agent_last_cycle_success", this.lastCycleSuccess, labels),
      "# HELP backup_agent_last_transfer_timestamp_seconds Last transfer item attempt timestamp.",
      "# TYPE backup_agent_last_transfer_timestamp_seconds gauge",
      metricLine("backup_agent_last_transfer_timestamp_seconds", Math.floor(this.lastTransferTimestamp / 1000), labels),
      "# HELP backup_agent_last_error_timestamp_seconds Last error timestamp.",
      "# TYPE backup_agent_last_error_timestamp_seconds gauge",
      metricLine("backup_agent_last_error_timestamp_seconds", Math.floor(this.lastErrorTimestamp / 1000), labels),
      "# HELP backup_agent_config_compression_enabled Whether upload compression is enabled by source.",
      "# TYPE backup_agent_config_compression_enabled gauge"
    );

    for (const source of sources) {
      const sourceMetricLabels = sourceLabels(labels, source);
      lines.push(metricLine(
        "backup_agent_config_compression_enabled",
        source.compression && source.compression.enabled ? 1 : 0,
        sourceMetricLabels
      ));
    }

    lines.push(
      "# HELP backup_agent_config_create_destination_dir_enabled Whether dynamic destination directories are enabled.",
      "# TYPE backup_agent_config_create_destination_dir_enabled gauge",
      metricLine("backup_agent_config_create_destination_dir_enabled", this.config.destination.createDir ? 1 : 0, {
        ...labels,
        format: this.config.destination.dirFormat
      }),
      "# HELP backup_agent_config_retention_policy Configured retention policy by source. Value is always 1 with policy label.",
      "# TYPE backup_agent_config_retention_policy gauge",
      "# HELP backup_agent_config_retention_minutes Configured time retention in minutes by source, or 0 when disabled.",
      "# TYPE backup_agent_config_retention_minutes gauge",
      "# HELP backup_agent_config_retention_count Configured count retention by source, or 0 when disabled.",
      "# TYPE backup_agent_config_retention_count gauge"
    );

    for (const source of sources) {
      const sourceMetricLabels = sourceLabels(labels, source);
      lines.push(metricLine("backup_agent_config_retention_policy", 1, {
        ...sourceMetricLabels,
        policy: source.retentionPolicy
      }));
      lines.push(metricLine("backup_agent_config_retention_minutes", source.retentionMinutes || 0, sourceMetricLabels));
      lines.push(metricLine("backup_agent_config_retention_count", source.retentionCount || 0, sourceMetricLabels));
    }

    lines.push(
      "# HELP backup_agent_source_directory_available Whether the source directory can be read.",
      "# TYPE backup_agent_source_directory_available gauge",
      "# HELP backup_agent_source_matching_items Number of matching files or files inside a directory source.",
      "# TYPE backup_agent_source_matching_items gauge",
      "# HELP backup_agent_source_oldest_matching_item_age_seconds Age of the oldest matching source item.",
      "# TYPE backup_agent_source_oldest_matching_item_age_seconds gauge"
    );

    for (const item of stats) {
      const sourceMetricLabels = sourceLabels(labels, item.source);
      lines.push(metricLine("backup_agent_source_directory_available", item.stats.available, sourceMetricLabels));
      lines.push(metricLine("backup_agent_source_matching_items", item.stats.count, sourceMetricLabels));
      lines.push(metricLine("backup_agent_source_oldest_matching_item_age_seconds", item.stats.oldestAgeSeconds, sourceMetricLabels));
    }

    return `${lines.join("\n")}\n`;
  }

  start(logger) {
    if (!this.config.metrics.enabled) {
      return;
    }

    this.server = http.createServer(async (request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok\n");
        return;
      }
      if (request.url !== this.config.metrics.path) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found\n");
        return;
      }

      try {
        const body = await this.render();
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        response.end(body);
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(`metrics error: ${error.message}\n`);
      }
    });

    this.server.listen(this.config.metrics.port, this.config.metrics.host, () => {
      logger.info("Prometheus metrics server started", {
        host: this.config.metrics.host,
        port: this.config.metrics.port,
        path: this.config.metrics.path
      });
    });
    this.server.on("error", (error) => {
      logger.error("Prometheus metrics server failed", { error: error.message });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = {
  Metrics
};
