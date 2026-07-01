const fs = require("fs");
const path = require("path");
const posix = require("path").posix;
const crypto = require("crypto");
const zlib = require("zlib");
const tar = require("tar");
const { pipeline } = require("stream/promises");
const { Client } = require("ssh2");
const { SocksClient } = require("socks");
const { ProgressTracker } = require("./progress");

function wildcardToRegex(pattern) {
  const normalized = pattern.includes("*") || pattern.includes("?") ? pattern : `*${pattern}`;
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i");
}

async function statSafe(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

function makeFingerprint(filePath, stats) {
  const input = `${path.resolve(filePath)}|${stats.size}|${Math.floor(stats.mtimeMs)}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

function makeDirectoryFingerprint(rootDir, snapshot) {
  const hash = crypto.createHash("sha256");
  hash.update(`${path.resolve(rootDir)}|directory|`);
  for (const directory of snapshot.directories) {
    hash.update(`d|${directory.relativePath}|`);
  }
  for (const file of snapshot.files) {
    hash.update(`f|${file.relativePath}|${file.size}|${Math.floor(file.mtimeMs)}|`);
  }
  return hash.digest("hex");
}

function toPosixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function sourceLabel(source) {
  return source && source.name ? source.name : "default";
}

async function listSourceFiles(config, state, logger, source = config.source) {
  const dir = source.dir;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const matcher = wildcardToRegex(source.pattern);
  const now = Date.now();
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!matcher.test(entry.name)) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    const stats = await statSafe(filePath);
    if (!stats) {
      continue;
    }
    const ageSeconds = Math.floor((now - stats.mtimeMs) / 1000);
    if (ageSeconds < source.minAgeSeconds) {
      logger.debug("Skipping file because it is too new", {
        source: sourceLabel(source),
        file: filePath,
        ageSeconds
      });
      continue;
    }
    const fingerprint = makeFingerprint(filePath, stats);
    if (source.skipAlreadyTransferred && state.transferred[fingerprint]) {
      logger.debug("Skipping already transferred file", {
        source: sourceLabel(source),
        file: filePath,
        fingerprint
      });
      continue;
    }
    files.push({
      kind: "file",
      sourceName: sourceLabel(source),
      name: entry.name,
      path: filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      fingerprint
    });
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return source.latestOnly ? files.slice(0, 1) : files;
}

async function collectDirectorySnapshot(rootDir) {
  const rootStats = await fs.promises.stat(rootDir);
  const files = [];
  const directories = [];

  async function walk(currentDir, relativeDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        const directory = {
          path: fullPath,
          relativePath: toPosixPath(relativePath)
        };
        directories.push(directory);
        await walk(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stats = await statSafe(fullPath);
      if (!stats) {
        continue;
      }
      files.push({
        name: entry.name,
        path: fullPath,
        relativePath: toPosixPath(relativePath),
        size: stats.size,
        mtimeMs: stats.mtimeMs
      });
    }
  }

  await walk(rootDir, "");

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const newestMtimeMs = files.reduce(
    (newest, file) => Math.max(newest, file.mtimeMs),
    rootStats.mtimeMs
  );
  const oldestMtimeMs = files.reduce(
    (oldest, file) => Math.min(oldest, file.mtimeMs),
    rootStats.mtimeMs
  );

  return {
    rootStats,
    files,
    directories,
    fileCount: files.length,
    directoryCount: directories.length,
    totalSize,
    newestMtimeMs,
    oldestMtimeMs
  };
}

async function listDirectorySource(config, state, logger, source = config.source) {
  const sourcePath = path.resolve(source.dir);
  const rootStats = await statSafe(sourcePath);
  if (!rootStats || !rootStats.isDirectory()) {
    logger.error("Directory source is not readable", {
      source: sourceLabel(source),
      dir: source.dir
    });
    return [];
  }

  const snapshot = await collectDirectorySnapshot(sourcePath);
  const ageSeconds = Math.floor((Date.now() - snapshot.newestMtimeMs) / 1000);
  if (ageSeconds < source.minAgeSeconds) {
    logger.debug("Skipping directory because it has recent changes", {
      source: sourceLabel(source),
      dir: sourcePath,
      ageSeconds
    });
    return [];
  }

  const fingerprint = makeDirectoryFingerprint(sourcePath, snapshot);
  if (source.skipAlreadyTransferred && state.transferred[fingerprint]) {
    logger.debug("Skipping already transferred directory snapshot", {
      source: sourceLabel(source),
      dir: sourcePath,
      fingerprint
    });
    return [];
  }

  return [{
    kind: "directory",
    sourceName: sourceLabel(source),
    name: safePathSegment(path.basename(sourcePath) || sourceLabel(source)),
    path: sourcePath,
    size: snapshot.totalSize,
    mtimeMs: snapshot.newestMtimeMs,
    fingerprint,
    files: snapshot.files,
    directories: snapshot.directories,
    fileCount: snapshot.fileCount,
    directoryCount: snapshot.directoryCount
  }];
}

async function listSourceItems(config, state, logger, source = config.source) {
  if (source.mode === "directory") {
    return listDirectorySource(config, state, logger, source);
  }
  return listSourceFiles(config, state, logger, source);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function timestampForDirectory(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + "_" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("-");
}

function safePathSegment(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "unknown";
}

function destinationDirForFile(config, date) {
  const base = config.destination.remoteDir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (!config.destination.createDir) {
    return base;
  }

  const hostname = safePathSegment(config.app.hostname);
  const timestamp = timestampForDirectory(date);
  if (config.destination.dirFormat === "hostname") {
    return posix.join(base, hostname);
  }
  if (config.destination.dirFormat === "hostname+date") {
    return posix.join(base, hostname, timestamp);
  }
  return posix.join(base, timestamp);
}

function parseSocksUrl(proxyUrl) {
  const parsed = new URL(proxyUrl);
  const protocol = parsed.protocol.replace(":", "");
  if (!["socks4", "socks4a", "socks5", "socks5h"].includes(protocol)) {
    throw new Error(`Unsupported SOCKS proxy protocol: ${parsed.protocol}`);
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 1080;
  const proxy = {
    host: parsed.hostname,
    port,
    type: protocol.startsWith("socks4") ? 4 : 5
  };
  if (parsed.username) {
    proxy.userId = decodeURIComponent(parsed.username);
    proxy.password = decodeURIComponent(parsed.password || "");
  }
  return proxy;
}

async function createSocksSocket(config) {
  const proxy = parseSocksUrl(config.destination.socks5Proxy);
  const result = await SocksClient.createConnection({
    proxy,
    command: "connect",
    destination: {
      host: config.destination.host,
      port: config.destination.port
    },
    timeout: config.destination.readyTimeoutMs
  });
  return result.socket;
}

async function connectSsh(config) {
  const conn = new Client();
  const connectionOptions = {
    host: config.destination.host,
    port: config.destination.port,
    username: config.destination.username,
    readyTimeout: config.destination.readyTimeoutMs,
    keepaliveInterval: config.destination.keepaliveIntervalMs
  };

  if (["private_key", "key"].includes(config.destination.authMethod)) {
    connectionOptions.privateKey = Buffer.from(config.destination.privateKeyBase64, "base64").toString("utf8");
    if (config.destination.password) {
      connectionOptions.passphrase = config.destination.password;
    }
  } else {
    connectionOptions.password = config.destination.password;
  }

  if (config.destination.socks5Enabled) {
    connectionOptions.sock = await createSocksSocket(config);
  }

  return new Promise((resolve, reject) => {
    conn.once("ready", () => resolve(conn));
    conn.once("error", reject);
    conn.connect(connectionOptions);
  });
}

async function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function sftpStat(sftp, target) {
  return new Promise((resolve) => {
    sftp.stat(target, (error, stats) => {
      if (error) resolve(null);
      else resolve(stats);
    });
  });
}

function sftpMkdir(sftp, target) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(target, (error) => {
      if (error && error.code !== 4) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function ensureRemoteDir(sftp, remoteDir) {
  const normalized = posix.normalize(remoteDir).replace(/\/+$/, "") || "/";
  if (normalized === "/") {
    return;
  }

  const absolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  let current = absolute ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : (current ? posix.join(current, part) : part);
    const stats = await sftpStat(sftp, current);
    if (!stats) {
      await sftpMkdir(sftp, current);
    }
  }
}

function uploadFile(sftp, localPath, remotePath, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath, { flags: "w", mode: 0o600 });

    readStream.once("error", reject);
    writeStream.once("error", reject);
    writeStream.once("close", resolve);
    readStream.on("data", (chunk) => onProgress(chunk.length));
    readStream.pipe(writeStream);
  });
}

function writeRemoteFile(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const writeStream = sftp.createWriteStream(remotePath, { flags: "wx", mode: 0o600 });
    writeStream.once("error", reject);
    writeStream.once("close", resolve);
    writeStream.end(content);
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpRename(sftp, from, to) {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function prepareUploadFile(config, item, source, logger, tracker) {
  const compression = source.compression || { enabled: false, level: 9 };
  if (!compression.enabled) {
    return {
      localPath: item.path,
      remoteName: item.name,
      uploadSize: item.size,
      compressed: false,
      directory: item.kind === "directory",
      directories: item.directories || [],
      files: item.files || [],
      cleanup: async () => {}
    };
  }

  await fs.promises.mkdir(compression.tempDir, { recursive: true });
  if (tracker) {
    tracker.setCurrentPhase("compressing", {
      detail: item.kind === "directory" ? "creating tar.gz archive" : "creating gzip file"
    }, true);
  }

  if (item.kind === "directory") {
    const archiveName = `${safePathSegment(item.name)}.tar.gz`;
    const archivePath = path.join(
      compression.tempDir,
      `${item.fingerprint.slice(0, 16)}-${archiveName}`
    );

    logger.info("Compressing source directory before upload", {
      source: sourceLabel(source),
      dir: item.path,
      compressed: archivePath,
      level: compression.level
    });

    await tar.c({
      cwd: path.dirname(item.path),
      file: archivePath,
      gzip: { level: compression.level },
      portable: true
    }, [path.basename(item.path)]);

    const stats = await fs.promises.stat(archivePath);
    logger.info("Directory compression completed", {
      source: sourceLabel(source),
      dir: item.path,
      compressed: archivePath,
      originalSize: item.size,
      compressedSize: stats.size,
      fileCount: item.fileCount
    });

    return {
      localPath: archivePath,
      remoteName: archiveName,
      uploadSize: stats.size,
      compressed: true,
      compressionFormat: "tar.gz",
      directory: false,
      cleanup: async () => {
        await fs.promises.unlink(archivePath).catch(() => {});
      }
    };
  }

  const compressedName = `${item.name}.gz`;
  const compressedPath = path.join(
    compression.tempDir,
    `${item.fingerprint.slice(0, 16)}-${compressedName}`
  );

  logger.info("Compressing source file before upload", {
    source: sourceLabel(source),
    file: item.path,
    compressed: compressedPath,
    level: compression.level
  });

  await pipeline(
    fs.createReadStream(item.path),
    zlib.createGzip({ level: compression.level }),
    fs.createWriteStream(compressedPath)
  );

  const stats = await fs.promises.stat(compressedPath);
  logger.info("Compression completed", {
    source: sourceLabel(source),
    file: item.path,
    compressed: compressedPath,
    originalSize: item.size,
    compressedSize: stats.size
  });

  return {
    localPath: compressedPath,
    remoteName: compressedName,
    uploadSize: stats.size,
    compressed: true,
    compressionFormat: "gzip",
    directory: false,
    cleanup: async () => {
      await fs.promises.unlink(compressedPath).catch(() => {});
    }
  };
}

async function uploadDirectory(sftp, prepared, remoteRoot, logger, source, item, tracker) {
  await ensureRemoteDir(sftp, remoteRoot);
  for (const directory of prepared.directories) {
    await ensureRemoteDir(sftp, posix.join(remoteRoot, directory.relativePath));
  }

  let index = 0;
  for (const file of prepared.files) {
    const remotePath = posix.join(remoteRoot, file.relativePath);
    await ensureRemoteDir(sftp, posix.dirname(remotePath));
    const tempPath = `${remotePath}.part-${process.pid}-${Date.now()}-${index}`;
    logger.debug("Uploading directory file", {
      source: sourceLabel(source),
      local: file.path,
      remote: remotePath,
      size: file.size
    });
    if (tracker) {
      tracker.setCurrentPhase("uploading", { detail: file.relativePath });
    }
    await uploadFile(sftp, file.path, tempPath, (bytes) => {
      if (tracker) {
        tracker.addBytes(source, item, bytes);
      }
    });
    await sftpRename(sftp, tempPath, remotePath);
    index += 1;
  }
}

async function deleteTransferredSource(item, source, logger) {
  if (!source.deleteOnSuccess) {
    return;
  }
  if (item.kind === "directory") {
    await fs.promises.rm(item.path, { recursive: true, force: false });
    logger.info("Source directory deleted after successful transfer", {
      source: sourceLabel(source),
      dir: item.path
    });
    return;
  }
  await fs.promises.unlink(item.path);
  logger.info("Source file deleted after successful transfer", {
    source: sourceLabel(source),
    file: item.path
  });
}

async function transferOne(config, item, source, logger, tracker) {
  let conn;
  let prepared;
  let remotePath;
  try {
    if (tracker) {
      tracker.startItem(source, item);
    }
    prepared = await prepareUploadFile(config, item, source, logger, tracker);
    const remoteDir = destinationDirForFile(config, new Date());
    remotePath = posix.join(remoteDir, prepared.remoteName);
    if (tracker) {
      tracker.setCurrentPhase("connecting", {
        remotePath,
        bytesTotal: prepared.uploadSize,
        compressed: prepared.compressed
      }, true);
    }
    conn = await connectSsh(config);
    const sftp = await openSftp(conn);
    await ensureRemoteDir(sftp, remoteDir);

    if (prepared.directory) {
      if (tracker) {
        tracker.setUpload(source, item, remotePath, prepared.uploadSize, prepared.compressed);
      }
      logger.info("Starting recursive SFTP directory upload", {
        source: sourceLabel(source),
        local: item.path,
        remote: remotePath,
        files: prepared.files.length,
        size: prepared.uploadSize
      });
      await uploadDirectory(sftp, prepared, remotePath, logger, source, item, tracker);
    } else {
      const tempPath = `${remotePath}.part-${process.pid}-${Date.now()}`;
      if (tracker) {
        tracker.setUpload(source, item, remotePath, prepared.uploadSize, prepared.compressed);
      }
      logger.info("Starting SFTP upload", {
        source: sourceLabel(source),
        local: prepared.localPath,
        sourcePath: item.path,
        remote: remotePath,
        size: prepared.uploadSize,
        compressed: prepared.compressed
      });
      await uploadFile(sftp, prepared.localPath, tempPath, (bytes) => {
        if (tracker) {
          tracker.addBytes(source, item, bytes);
        }
      });
      await sftpRename(sftp, tempPath, remotePath);
    }

    if (tracker) {
      tracker.setCurrentPhase("deleting", {}, true);
    }
    await deleteTransferredSource(item, source, logger);

    const result = {
      success: true,
      sourceName: sourceLabel(source),
      sourceMode: source.mode,
      file: item,
      remotePath,
      compressed: prepared.compressed,
      compressionFormat: prepared.compressionFormat,
      uploadSize: prepared.uploadSize
    };
    if (tracker) {
      tracker.finishItem(source, item, result);
    }
    return result;
  } catch (error) {
    const result = {
      success: false,
      sourceName: sourceLabel(source),
      sourceMode: source.mode,
      file: item,
      error,
      remotePath,
      compressed: prepared ? prepared.compressed : !!(source.compression && source.compression.enabled),
      compressionFormat: prepared ? prepared.compressionFormat : undefined,
      uploadSize: prepared ? prepared.uploadSize : undefined
    };
    if (tracker) {
      tracker.failItem(source, item, result);
    }
    return result;
  } finally {
    if (prepared) {
      await prepared.cleanup();
    }
    if (conn) {
      conn.end();
    }
  }
}

async function testDestination(config, logger, connect = connectSsh) {
  let conn;
  let sftp;
  let remotePath;
  const remoteDir = config.destination.remoteDir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const marker = Buffer.from(`backup-agent destination write test ${new Date().toISOString()}\n`, "utf8");

  try {
    logger.info("Testing SSH destination connection", {
      host: config.destination.host,
      port: config.destination.port,
      remoteDir
    });
    conn = await connect(config);
    sftp = await openSftp(conn);
    await ensureRemoteDir(sftp, remoteDir);

    const randomSuffix = crypto.randomBytes(6).toString("hex");
    remotePath = posix.join(
      remoteDir,
      `.backup-agent-write-test-${process.pid}-${Date.now()}-${randomSuffix}.tmp`
    );
    await writeRemoteFile(sftp, remotePath, marker);

    const stats = await sftpStat(sftp, remotePath);
    if (!stats || stats.size !== marker.length) {
      throw new Error(`Remote write verification failed for ${remotePath}.`);
    }

    await sftpUnlink(sftp, remotePath);
    remotePath = null;
    logger.info("SSH destination connection and write test passed", {
      host: config.destination.host,
      port: config.destination.port,
      remoteDir
    });
    return {
      host: config.destination.host,
      port: config.destination.port,
      remoteDir
    };
  } finally {
    if (sftp && remotePath) {
      try {
        await sftpUnlink(sftp, remotePath);
      } catch (cleanupError) {
        logger.warn("Could not remove destination test file", {
          remotePath,
          error: cleanupError.message
        });
      }
    }
    if (sftp && typeof sftp.end === "function") {
      sftp.end();
    }
    if (conn) {
      conn.end();
    }
  }
}

async function runRetentionCleanup(config, logger, protectedFingerprints = new Set(), source = config.source) {
  if (source.retentionPolicy === "off") {
    return { deleted: 0, failed: 0 };
  }

  if (source.mode === "directory") {
    logger.warn("Retention cleanup skipped for directory source", {
      source: sourceLabel(source),
      retentionPolicy: source.retentionPolicy
    });
    return { deleted: 0, failed: 0 };
  }

  const matcher = wildcardToRegex(source.pattern);
  let deleted = 0;
  let failed = 0;
  const candidates = [];

  let entries;
  try {
    entries = await fs.promises.readdir(source.dir, { withFileTypes: true });
  } catch (error) {
    logger.error("Retention cleanup could not read source directory", {
      source: sourceLabel(source),
      dir: source.dir,
      error: error.message
    });
    return { deleted, failed: failed + 1 };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !matcher.test(entry.name)) {
      continue;
    }
    const filePath = path.join(source.dir, entry.name);
    const stats = await statSafe(filePath);
    if (!stats) {
      continue;
    }
    const fingerprint = makeFingerprint(filePath, stats);
    candidates.push({
      name: entry.name,
      path: filePath,
      stats,
      fingerprint
    });
  }

  let deleteCandidates = [];
  if (source.retentionPolicy === "time") {
    const cutoffMs = Date.now() - source.retentionTimeMs;
    deleteCandidates = candidates.filter((candidate) => candidate.stats.mtimeMs < cutoffMs);
  } else if (source.retentionPolicy === "count") {
    const sorted = [...candidates].sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
    deleteCandidates = sorted.slice(source.retentionCount);
  }

  for (const candidate of deleteCandidates) {
    const stats = candidate.stats;
    if (protectedFingerprints.has(candidate.fingerprint)) {
      logger.warn("Retention cleanup kept a failed-transfer file", {
        source: sourceLabel(source),
        file: candidate.path,
        retentionPolicy: source.retentionPolicy
      });
      continue;
    }
    try {
      await fs.promises.unlink(candidate.path);
      deleted += 1;
      logger.info("Retention cleanup deleted source file", {
        source: sourceLabel(source),
        file: candidate.path,
        ageMinutes: Math.floor((Date.now() - stats.mtimeMs) / 60000),
        retentionPolicy: source.retentionPolicy,
        retentionTime: source.retentionPolicy === "time" ? source.retentionTime : undefined,
        retentionCount: source.retentionPolicy === "count" ? source.retentionCount : undefined
      });
    } catch (error) {
      failed += 1;
      logger.error("Retention cleanup failed to delete source file", {
        source: sourceLabel(source),
        file: candidate.path,
        error: error.message
      });
    }
  }

  if (deleted > 0 || failed > 0) {
    logger.info("Retention cleanup finished", {
      source: sourceLabel(source),
      deleted,
      failed,
      retentionPolicy: source.retentionPolicy,
      matchingFiles: candidates.length
    });
  }
  return { deleted, failed };
}

function loadState(config) {
  try {
    if (fs.existsSync(config.app.stateFile)) {
      const data = JSON.parse(fs.readFileSync(config.app.stateFile, "utf8"));
      return {
        transferred: data.transferred || {}
      };
    }
  } catch {
    // Start with an empty state when the file is corrupt.
  }
  return { transferred: {} };
}

function saveState(config, state) {
  fs.mkdirSync(path.dirname(config.app.stateFile), { recursive: true });
  fs.writeFileSync(config.app.stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function runSourceItems(config, state, logger, source, items, tracker) {
  if (items.length === 0) {
    logger.info("No matching source items found", { source: sourceLabel(source), mode: source.mode });
    await runRetentionCleanup(config, logger, new Set(), source);
    return [];
  }

  const results = [];
  for (const item of items) {
    const result = await transferOne(config, item, source, logger, tracker);
    if (result.success) {
      state.transferred[item.fingerprint] = {
        source: sourceLabel(source),
        mode: source.mode,
        path: item.path,
        size: item.size,
        mtimeMs: item.mtimeMs,
        remotePath: result.remotePath,
        compressed: result.compressed,
        compressionFormat: result.compressionFormat,
        uploadSize: result.uploadSize,
        transferredAt: new Date().toISOString()
      };
      saveState(config, state);
      logger.info("SFTP upload completed", {
        source: sourceLabel(source),
        local: item.path,
        remote: result.remotePath
      });
    } else {
      logger.error("SFTP upload failed", {
        source: sourceLabel(source),
        local: item.path,
        remote: result.remotePath,
        compressed: result.compressed,
        error: result.error.message
      });
    }
    results.push(result);
  }

  const protectedFingerprints = new Set(
    results
      .filter((result) => !result.success && result.file)
      .map((result) => result.file.fingerprint)
  );
  await runRetentionCleanup(config, logger, protectedFingerprints, source);
  return results;
}

async function runSource(config, state, logger, source, tracker) {
  const items = await listSourceItems(config, state, logger, source);
  return runSourceItems(config, state, logger, source, items, tracker);
}

async function runTransferCycle(config, logger) {
  const state = loadState(config);
  const sources = Array.isArray(config.sources) && config.sources.length > 0
    ? config.sources
    : [config.source].filter(Boolean);
  const tracker = new ProgressTracker(config, logger);
  tracker.startCycle(sources);
  const plannedBySource = [];
  const plannedItems = [];
  const results = [];

  try {
    for (const source of sources) {
      const items = await listSourceItems(config, state, logger, source);
      plannedBySource.push({ source, items });
      for (const item of items) {
        plannedItems.push({ source, item });
      }
    }

    tracker.setQueue(plannedItems);

    for (const { source, items } of plannedBySource) {
      const sourceResults = await runSourceItems(config, state, logger, source, items, tracker);
      results.push(...sourceResults);
    }
    tracker.finishCycle(results.every((result) => result.success));
  } catch (error) {
    tracker.finishCycle(false);
    throw error;
  }

  return results;
}

module.exports = {
  runTransferCycle,
  listSourceFiles,
  listDirectorySource,
  listSourceItems,
  runRetentionCleanup,
  loadState,
  saveState,
  testDestination
};
