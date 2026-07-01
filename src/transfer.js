const fs = require("fs");
const path = require("path");
const posix = require("path").posix;
const crypto = require("crypto");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Client } = require("ssh2");
const { SocksClient } = require("socks");

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

async function listSourceFiles(config, state, logger) {
  const dir = config.source.dir;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const matcher = wildcardToRegex(config.source.pattern);
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
    if (ageSeconds < config.source.minAgeSeconds) {
      logger.debug("Skipping file because it is too new", { file: filePath, ageSeconds });
      continue;
    }
    const fingerprint = makeFingerprint(filePath, stats);
    if (config.source.skipAlreadyTransferred && state.transferred[fingerprint]) {
      logger.debug("Skipping already transferred file", { file: filePath, fingerprint });
      continue;
    }
    files.push({
      name: entry.name,
      path: filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      fingerprint
    });
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return config.source.latestOnly ? files.slice(0, 1) : files;
}

function makeFingerprint(filePath, stats) {
  const input = `${path.resolve(filePath)}|${stats.size}|${Math.floor(stats.mtimeMs)}`;
  return crypto.createHash("sha256").update(input).digest("hex");
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

function uploadFile(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath, { flags: "w", mode: 0o600 });

    readStream.once("error", reject);
    writeStream.once("error", reject);
    writeStream.once("close", resolve);
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

async function prepareUploadFile(config, file, logger) {
  if (!config.compression.enabled) {
    return {
      localPath: file.path,
      remoteName: file.name,
      uploadSize: file.size,
      compressed: false,
      cleanup: async () => {}
    };
  }

  await fs.promises.mkdir(config.compression.tempDir, { recursive: true });
  const compressedName = `${file.name}.gz`;
  const compressedPath = path.join(
    config.compression.tempDir,
    `${file.fingerprint.slice(0, 16)}-${compressedName}`
  );

  logger.info("Compressing source file before upload", {
    file: file.path,
    compressed: compressedPath,
    level: config.compression.level
  });

  await pipeline(
    fs.createReadStream(file.path),
    zlib.createGzip({ level: config.compression.level }),
    fs.createWriteStream(compressedPath)
  );

  const stats = await fs.promises.stat(compressedPath);
  logger.info("Compression completed", {
    file: file.path,
    compressed: compressedPath,
    originalSize: file.size,
    compressedSize: stats.size
  });

  return {
    localPath: compressedPath,
    remoteName: compressedName,
    uploadSize: stats.size,
    compressed: true,
    compressionFormat: "gzip",
    cleanup: async () => {
      await fs.promises.unlink(compressedPath).catch(() => {});
    }
  };
}

async function transferOne(config, file, logger) {
  let conn;
  let prepared;
  let remotePath;
  try {
    prepared = await prepareUploadFile(config, file, logger);
    const remoteDir = destinationDirForFile(config, new Date());
    remotePath = posix.join(remoteDir, prepared.remoteName);
    conn = await connectSsh(config);
    const sftp = await openSftp(conn);
    await ensureRemoteDir(sftp, remoteDir);
    const tempPath = `${remotePath}.part-${process.pid}-${Date.now()}`;

    logger.info("Starting SFTP upload", {
      local: prepared.localPath,
      source: file.path,
      remote: remotePath,
      size: prepared.uploadSize,
      compressed: prepared.compressed
    });
    await uploadFile(sftp, prepared.localPath, tempPath);
    await sftpRename(sftp, tempPath, remotePath);

    if (config.source.deleteOnSuccess) {
      await fs.promises.unlink(file.path);
      logger.info("Source file deleted after successful transfer", { file: file.path });
    }

    return {
      success: true,
      file,
      remotePath,
      compressed: prepared.compressed,
      compressionFormat: prepared.compressionFormat,
      uploadSize: prepared.uploadSize
    };
  } catch (error) {
    return {
      success: false,
      file,
      error,
      remotePath,
      compressed: prepared ? prepared.compressed : config.compression.enabled,
      compressionFormat: prepared ? prepared.compressionFormat : undefined,
      uploadSize: prepared ? prepared.uploadSize : undefined
    };
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

async function runRetentionCleanup(config, logger, protectedFingerprints = new Set()) {
  if (config.source.retentionPolicy === "off") {
    return { deleted: 0, failed: 0 };
  }

  const matcher = wildcardToRegex(config.source.pattern);
  let deleted = 0;
  let failed = 0;
  const candidates = [];

  let entries;
  try {
    entries = await fs.promises.readdir(config.source.dir, { withFileTypes: true });
  } catch (error) {
    logger.error("Retention cleanup could not read source directory", {
      dir: config.source.dir,
      error: error.message
    });
    return { deleted, failed: failed + 1 };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !matcher.test(entry.name)) {
      continue;
    }
    const filePath = path.join(config.source.dir, entry.name);
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
  if (config.source.retentionPolicy === "time") {
    const cutoffMs = Date.now() - config.source.retentionTimeMs;
    deleteCandidates = candidates.filter((candidate) => candidate.stats.mtimeMs < cutoffMs);
  } else if (config.source.retentionPolicy === "count") {
    const sorted = [...candidates].sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
    deleteCandidates = sorted.slice(config.source.retentionCount);
  }

  for (const candidate of deleteCandidates) {
    const stats = candidate.stats;
    if (protectedFingerprints.has(candidate.fingerprint)) {
      logger.warn("Retention cleanup kept a failed-transfer file", {
        file: candidate.path,
        retentionPolicy: config.source.retentionPolicy
      });
      continue;
    }
    try {
      await fs.promises.unlink(candidate.path);
      deleted += 1;
      logger.info("Retention cleanup deleted source file", {
        file: candidate.path,
        ageMinutes: Math.floor((Date.now() - stats.mtimeMs) / 60000),
        retentionPolicy: config.source.retentionPolicy,
        retentionTime: config.source.retentionPolicy === "time" ? config.source.retentionTime : undefined,
        retentionCount: config.source.retentionPolicy === "count" ? config.source.retentionCount : undefined
      });
    } catch (error) {
      failed += 1;
      logger.error("Retention cleanup failed to delete source file", {
        file: candidate.path,
        error: error.message
      });
    }
  }

  if (deleted > 0 || failed > 0) {
    logger.info("Retention cleanup finished", {
      deleted,
      failed,
      retentionPolicy: config.source.retentionPolicy,
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

async function runTransferCycle(config, logger) {
  const state = loadState(config);
  const files = await listSourceFiles(config, state, logger);
  if (files.length === 0) {
    logger.info("No matching source files found");
    await runRetentionCleanup(config, logger);
    return [];
  }

  const results = [];
  for (const file of files) {
    const result = await transferOne(config, file, logger);
    if (result.success) {
      state.transferred[file.fingerprint] = {
        file: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        remotePath: result.remotePath,
        compressed: result.compressed,
        uploadSize: result.uploadSize,
        transferredAt: new Date().toISOString()
      };
      saveState(config, state);
      logger.info("SFTP upload completed", { local: file.path, remote: result.remotePath });
    } else {
      logger.error("SFTP upload failed", {
        local: file.path,
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
  await runRetentionCleanup(config, logger, protectedFingerprints);
  return results;
}

module.exports = {
  runTransferCycle,
  listSourceFiles,
  runRetentionCleanup,
  loadState,
  saveState,
  testDestination
};
