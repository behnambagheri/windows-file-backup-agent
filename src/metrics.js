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
    this.files = { success: 0, failure: 0 };
    this.originalBytes = 0;
    this.uploadBytes = 0;
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
      this.files[status] += 1;
      this.lastTransferTimestamp = this.lastCycleEnd;
      if (!result.success) {
        this.lastErrorTimestamp = this.lastCycleEnd;
        continue;
      }
      this.originalBytes += result.file ? result.file.size || 0 : 0;
      this.uploadBytes += result.uploadSize || (result.file ? result.file.size || 0 : 0);
    }
  }

  cycleCrashed() {
    this.cycleFinished(false, []);
  }

  async sourceStats() {
    const matcher = wildcardToRegex(this.config.source.pattern || "*");
    const now = Date.now();
    let count = 0;
    let oldestAgeSeconds = 0;
    try {
      const entries = await fs.promises.readdir(this.config.source.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !matcher.test(entry.name)) {
          continue;
        }
        const stats = await fs.promises.stat(path.join(this.config.source.dir, entry.name));
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
    const source = await this.sourceStats();
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
      "# HELP backup_agent_files_total Files attempted by status.",
      "# TYPE backup_agent_files_total counter",
      metricLine("backup_agent_files_total", this.files.success, { ...labels, status: "success" }),
      metricLine("backup_agent_files_total", this.files.failure, { ...labels, status: "failure" }),
      "# HELP backup_agent_original_bytes_total Original source bytes successfully uploaded.",
      "# TYPE backup_agent_original_bytes_total counter",
      metricLine("backup_agent_original_bytes_total", this.originalBytes, labels),
      "# HELP backup_agent_uploaded_bytes_total Uploaded bytes after optional compression.",
      "# TYPE backup_agent_uploaded_bytes_total counter",
      metricLine("backup_agent_uploaded_bytes_total", this.uploadBytes, labels),
      "# HELP backup_agent_last_cycle_timestamp_seconds Last transfer cycle completion timestamp.",
      "# TYPE backup_agent_last_cycle_timestamp_seconds gauge",
      metricLine("backup_agent_last_cycle_timestamp_seconds", Math.floor(this.lastCycleEnd / 1000), labels),
      "# HELP backup_agent_last_cycle_duration_seconds Last transfer cycle duration.",
      "# TYPE backup_agent_last_cycle_duration_seconds gauge",
      metricLine("backup_agent_last_cycle_duration_seconds", this.lastCycleDurationSeconds, labels),
      "# HELP backup_agent_last_cycle_success Whether the last transfer cycle succeeded.",
      "# TYPE backup_agent_last_cycle_success gauge",
      metricLine("backup_agent_last_cycle_success", this.lastCycleSuccess, labels),
      "# HELP backup_agent_last_transfer_timestamp_seconds Last file transfer attempt timestamp.",
      "# TYPE backup_agent_last_transfer_timestamp_seconds gauge",
      metricLine("backup_agent_last_transfer_timestamp_seconds", Math.floor(this.lastTransferTimestamp / 1000), labels),
      "# HELP backup_agent_last_error_timestamp_seconds Last error timestamp.",
      "# TYPE backup_agent_last_error_timestamp_seconds gauge",
      metricLine("backup_agent_last_error_timestamp_seconds", Math.floor(this.lastErrorTimestamp / 1000), labels),
      "# HELP backup_agent_config_compression_enabled Whether upload compression is enabled.",
      "# TYPE backup_agent_config_compression_enabled gauge",
      metricLine("backup_agent_config_compression_enabled", this.config.compression.enabled ? 1 : 0, labels),
      "# HELP backup_agent_config_create_destination_dir_enabled Whether dynamic destination directories are enabled.",
      "# TYPE backup_agent_config_create_destination_dir_enabled gauge",
      metricLine("backup_agent_config_create_destination_dir_enabled", this.config.destination.createDir ? 1 : 0, {
        ...labels,
        format: this.config.destination.dirFormat
      }),
      "# HELP backup_agent_config_retention_policy Configured retention policy. Value is always 1 with policy label.",
      "# TYPE backup_agent_config_retention_policy gauge",
      metricLine("backup_agent_config_retention_policy", 1, { ...labels, policy: this.config.source.retentionPolicy }),
      "# HELP backup_agent_config_retention_minutes Configured time retention in minutes, or 0 when disabled.",
      "# TYPE backup_agent_config_retention_minutes gauge",
      metricLine("backup_agent_config_retention_minutes", this.config.source.retentionMinutes || 0, labels),
      "# HELP backup_agent_config_retention_count Configured count retention, or 0 when disabled.",
      "# TYPE backup_agent_config_retention_count gauge",
      metricLine("backup_agent_config_retention_count", this.config.source.retentionCount || 0, labels),
      "# HELP backup_agent_source_directory_available Whether the source directory can be read.",
      "# TYPE backup_agent_source_directory_available gauge",
      metricLine("backup_agent_source_directory_available", source.available, labels),
      "# HELP backup_agent_source_matching_files Number of files matching SOURCE_FILE_PATTERN.",
      "# TYPE backup_agent_source_matching_files gauge",
      metricLine("backup_agent_source_matching_files", source.count, labels),
      "# HELP backup_agent_source_oldest_matching_file_age_seconds Age of the oldest matching source file.",
      "# TYPE backup_agent_source_oldest_matching_file_age_seconds gauge",
      metricLine("backup_agent_source_oldest_matching_file_age_seconds", source.oldestAgeSeconds, labels)
    ];
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
