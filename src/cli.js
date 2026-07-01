#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  loadConfig,
  validateConfig,
  validateDestinationConfig,
  validateTelegramConfig,
  validateEmailConfig,
  appDir
} = require("./config");
const { createLogger } = require("./logger");
const { testTelegram, testEmail } = require("./notifications");
const { testDestination } = require("./transfer");
const packageInfo = require("../package.json");

const TASK_NAME = process.env.BACKUP_AGENT_TASK_NAME || "backup-agent";

function usage() {
  return `backup-agent command line

Usage:
  backup-agent help
  backup-agent status
  backup-agent health
  backup-agent logs [--lines 100]
  backup-agent logs -f [--lines 100]
  backup-agent start
  backup-agent stop
  backup-agent restart
  backup-agent reload-env
  backup-agent edit-env
  backup-agent metrics status
  backup-agent metrics enable [--port 9108] [--host 0.0.0.0] [--path /metrics] [--firewall]
  backup-agent metrics disable
  backup-agent firewall status
  backup-agent firewall add [--port 9108]
  backup-agent firewall remove
  backup-agent test telegram
  backup-agent test email
  backup-agent test destination
  backup-agent update
  backup-agent run-once
  backup-agent uninstall [--remove-data]
  backup-agent version

Notes:
  edit-env opens the active .env in elevated Notepad.
  Notification tests send a real test message even when the notification mode is off.
  The destination test writes, verifies, and removes a temporary file over SFTP.
  start, stop, restart, reload-env, update, and uninstall should be run from an
  elevated PowerShell window when the Scheduled Task was installed as SYSTEM.`;
}

function isWindows() {
  return process.platform === "win32";
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(command) {
  if (!isWindows()) {
    return {
      status: 1,
      stdout: "",
      stderr: "Scheduled Task commands are only available on Windows."
    };
  }

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], { encoding: "utf8" });

  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || ""
  };
}

function printPowerShellResult(result) {
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  process.exit(result.status);
}

function getTaskInfo() {
  const taskName = quotePowerShell(TASK_NAME);
  const command = `
$task = Get-ScheduledTask -TaskName ${taskName} -ErrorAction SilentlyContinue
if (!$task) { Write-Output '{"installed":false}'; exit 0 }
$info = Get-ScheduledTaskInfo -TaskName ${taskName}
[pscustomobject]@{
  installed = $true
  taskName = $task.TaskName
  state = [string]$task.State
  lastRunTime = [string]$info.LastRunTime
  nextRunTime = [string]$info.NextRunTime
  lastTaskResult = $info.LastTaskResult
} | ConvertTo-Json -Compress
`;
  const result = runPowerShell(command);
  if (result.status !== 0) {
    return { installed: false, error: result.stderr.trim() || result.stdout.trim() };
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    return { installed: false, error: error.message };
  }
}

function printStatus() {
  const config = loadConfig();
  console.log(`Name: backup-agent`);
  console.log(`Install dir: ${appDir()}`);
  console.log(`Config: ${config.app.envFile}`);
  console.log(`Logs: ${path.join(config.app.logsDir, "agent.log")}`);

  if (!isWindows()) {
    console.log("Task: unavailable on this OS");
    return;
  }

  const task = getTaskInfo();
  if (!task.installed) {
    console.log("Task: not installed");
    if (task.error) console.log(`Task error: ${task.error}`);
    return;
  }

  console.log(`Task: ${task.taskName}`);
  console.log(`State: ${task.state}`);
  console.log(`Last run: ${task.lastRunTime || "never"}`);
  console.log(`Next run: ${task.nextRunTime || "unknown"}`);
  console.log(`Last result: ${task.lastTaskResult}`);
}

function startTask() {
  printPowerShellResult(runPowerShell(`Start-ScheduledTask -TaskName ${quotePowerShell(TASK_NAME)}`));
}

function stopTask() {
  printPowerShellResult(runPowerShell(`Stop-ScheduledTask -TaskName ${quotePowerShell(TASK_NAME)}`));
}

function restartTaskResult() {
  const task = quotePowerShell(TASK_NAME);
  return runPowerShell(`
Stop-ScheduledTask -TaskName ${task} -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName ${task}
Write-Host "backup-agent restarted."
`);
}

function restartTask() {
  printPowerShellResult(restartTaskResult());
}

function editEnv() {
  if (!isWindows()) {
    console.error("edit-env is only available on Windows.");
    process.exit(1);
  }

  const config = loadConfig();
  const envFile = config.app.envFile;
  if (!fs.existsSync(envFile)) {
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    const exampleFile = path.join(appDir(), ".env.example");
    if (fs.existsSync(exampleFile)) {
      fs.copyFileSync(exampleFile, envFile);
    } else {
      fs.writeFileSync(envFile, "", "utf8");
    }
  }

  const command = `
$envFile = ${quotePowerShell(envFile)}
$notepadArgument = '"' + $envFile + '"'
Start-Process -FilePath "notepad.exe" -Verb RunAs -ArgumentList @($notepadArgument)
Write-Host "Opened backup-agent config in Notepad: $envFile"
`;
  printPowerShellResult(runPowerShell(command));
}

function tailLog(lines, follow) {
  const config = loadConfig();
  const logFile = path.join(config.app.logsDir, "agent.log");
  if (!fs.existsSync(logFile)) {
    console.error(`Log file does not exist yet: ${logFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(logFile, "utf8");
  const rows = content.split(/\r?\n/).filter(Boolean);
  console.log(rows.slice(-lines).join("\n"));

  if (!follow) {
    return;
  }

  let offset = Buffer.byteLength(content);
  fs.watchFile(logFile, { interval: 1000 }, () => {
    const stats = fs.statSync(logFile);
    if (stats.size < offset) {
      offset = 0;
    }
    if (stats.size === offset) {
      return;
    }
    const fd = fs.openSync(logFile, "r");
    const buffer = Buffer.alloc(stats.size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
    offset = stats.size;
    process.stdout.write(buffer.toString("utf8"));
  });
}

function health() {
  const config = loadConfig();
  const errors = validateConfig(config);
  const warnings = [];

  if (config.source.dir && !fs.existsSync(config.source.dir)) {
    errors.push(`SOURCE_DIR does not exist: ${config.source.dir}`);
  }

  try {
    fs.mkdirSync(config.app.logsDir, { recursive: true });
    fs.accessSync(config.app.logsDir, fs.constants.W_OK);
  } catch (error) {
    errors.push(`Log directory is not writable: ${config.app.logsDir}: ${error.message}`);
  }

  if (isWindows()) {
    const task = getTaskInfo();
    if (!task.installed) {
      warnings.push("Scheduled Task is not installed.");
    } else if (!["Running", "Ready"].includes(task.state)) {
      warnings.push(`Scheduled Task state is ${task.state}.`);
    }
  } else {
    warnings.push("Scheduled Task check skipped because this is not Windows.");
  }

  console.log(`Config: ${config.app.envFile}`);
  console.log(`Logs: ${path.join(config.app.logsDir, "agent.log")}`);
  console.log(`Hostname: ${config.app.hostname}`);
  console.log(`Compression: ${config.compression.enabled ? "enabled" : "disabled"}`);
  console.log(`Create destination directory: ${config.destination.createDir ? config.destination.dirFormat : "disabled"}`);
  console.log(`Retention: ${config.source.retentionPolicy}`);
  if (config.source.retentionPolicy === "time") {
    console.log(`Retention time: ${config.source.retentionTime}`);
  }
  if (config.source.retentionPolicy === "count") {
    console.log(`Retention count: ${config.source.retentionCount}`);
  }
  console.log(`Metrics: ${config.metrics.enabled ? `${config.metrics.host}:${config.metrics.port}${config.metrics.path}` : "disabled"}`);
  console.log(`Metrics firewall rule: ${config.metrics.firewallRule ? "enabled" : "disabled"}`);
  console.log(`Telegram notifications: ${config.telegram.mode} (fallback: ${config.telegram.fallback})`);
  console.log(`Email notifications: ${config.email.mode} (fallback: ${config.email.fallback})`);
  console.log(`Update URL: ${config.update.url}`);

  for (const warning of warnings) console.log(`WARN: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${error}`);

  if (errors.length) {
    console.error("Health: FAIL");
    process.exit(1);
  }
  console.log("Health: OK");
}

function runOnce() {
  const node = process.execPath;
  const script = path.join(__dirname, "index.js");
  const env = { ...process.env, RUN_ONCE: "true", RUN_ON_START: "true" };
  const result = spawnSync(node, [script], { stdio: "inherit", env });
  process.exit(result.status ?? 1);
}

function parseOption(args, names, fallback = "") {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && args[index + 1]) {
      return args[index + 1];
    }
  }
  return fallback;
}

function setEnvValues(envFile, updates) {
  let content = "";
  if (fs.existsSync(envFile)) {
    content = fs.readFileSync(envFile, "utf8");
  }
  const lines = content ? content.split(/\r?\n/) : [];
  const applied = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (!match) {
      return line;
    }
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      return line;
    }
    applied.add(key);
    return `${key}=${updates[key]}`;
  });

  if (next.length && next[next.length - 1] !== "") {
    next.push("");
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!applied.has(key)) {
      next.push(`${key}=${value}`);
    }
  }
  fs.writeFileSync(envFile, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function restartAfterConfigChange() {
  if (!isWindows()) {
    console.log("Config updated. Run backup-agent reload-env on Windows to apply it.");
    return;
  }
  const result = restartTaskResult();
  if (result.status !== 0) {
    if (result.stdout.trim()) process.stdout.write(result.stdout);
    if (result.stderr.trim()) process.stderr.write(result.stderr);
    console.log("Config updated, but automatic restart failed. Run backup-agent reload-env from elevated PowerShell.");
    return;
  }
  if (result.stdout.trim()) process.stdout.write(result.stdout);
}

function metricsCommand(args) {
  const subcommand = (args[0] || "status").toLowerCase();
  const config = loadConfig();

  if (subcommand === "status") {
    console.log(`Metrics: ${config.metrics.enabled ? "enabled" : "disabled"}`);
    console.log(`Listen: ${config.metrics.host}:${config.metrics.port}${config.metrics.path}`);
    console.log(`Firewall rule requested in .env: ${config.metrics.firewallRule ? "true" : "false"}`);
    return;
  }

  if (subcommand === "enable") {
    const port = parseOption(args, ["--port", "-p"], String(config.metrics.port));
    const host = parseOption(args, ["--host"], config.metrics.host);
    const metricsPath = parseOption(args, ["--path"], config.metrics.path);
    const parsedPort = Number.parseInt(port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      console.error("Metrics port must be from 1 to 65535.");
      process.exit(2);
    }
    if (!metricsPath.startsWith("/")) {
      console.error("Metrics path must start with /.");
      process.exit(2);
    }
    const updates = {
      METRICS_ENABLED: "true",
      METRICS_HOST: host,
      METRICS_PORT: String(parsedPort),
      METRICS_PATH: metricsPath
    };
    if (args.includes("--firewall")) {
      updates.METRICS_FIREWALL_RULE = "true";
    }
    setEnvValues(config.app.envFile, updates);
    console.log(`Metrics enabled in ${config.app.envFile}: ${host}:${port}${metricsPath}`);
    if (args.includes("--firewall")) {
      if (isWindows()) {
        const result = firewallResult("add", parsedPort, config);
        if (result.stdout.trim()) process.stdout.write(result.stdout);
        if (result.stderr.trim()) process.stderr.write(result.stderr);
      } else {
        console.log("Firewall rule not added because this is not Windows.");
      }
    }
    restartAfterConfigChange();
    return;
  }

  if (subcommand === "disable") {
    setEnvValues(config.app.envFile, { METRICS_ENABLED: "false" });
    console.log(`Metrics disabled in ${config.app.envFile}`);
    restartAfterConfigChange();
    return;
  }

  console.error(`Unknown metrics command: ${subcommand}`);
  process.exit(2);
}

function firewallCommand(args) {
  const subcommand = (args[0] || "status").toLowerCase();
  const config = loadConfig();
  const port = parseOption(args, ["--port", "-p"], String(config.metrics.port));
  const parsedPort = Number.parseInt(port, 10);

  if (!isWindows()) {
    console.error("Firewall commands are only available on Windows.");
    process.exit(1);
  }
  if (!["status", "remove"].includes(subcommand) && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
    console.error("Firewall port must be from 1 to 65535.");
    process.exit(2);
  }

  if (subcommand === "status") {
    printPowerShellResult(firewallResult("status", parsedPort, config));
    return;
  }

  if (subcommand === "add") {
    printPowerShellResult(firewallResult("add", parsedPort, config));
    return;
  }

  if (subcommand === "remove") {
    printPowerShellResult(firewallResult("remove", parsedPort, config));
    return;
  }

  console.error(`Unknown firewall command: ${subcommand}`);
  process.exit(2);
}

function firewallResult(subcommand, port, config) {
  const ruleName = quotePowerShell(config.metrics.firewallRuleName);
  if (subcommand === "status") {
    return runPowerShell(`
$rule = Get-NetFirewallRule -DisplayName ${ruleName} -ErrorAction SilentlyContinue
if (!$rule) {
  Write-Host "Firewall rule not found: ${config.metrics.firewallRuleName}"
  exit 1
}
$port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
Write-Host "Firewall rule exists: ${config.metrics.firewallRuleName}"
Write-Host "Enabled: $($rule.Enabled)"
Write-Host "Direction: $($rule.Direction)"
Write-Host "Action: $($rule.Action)"
Write-Host "Protocol: $($port.Protocol)"
Write-Host "LocalPort: $($port.LocalPort)"
`);
  }

  if (subcommand === "add") {
    return runPowerShell(`
$existing = Get-NetFirewallRule -DisplayName ${ruleName} -ErrorAction SilentlyContinue
if ($existing) {
  Set-NetFirewallRule -DisplayName ${ruleName} -Enabled True -Direction Inbound -Action Allow
  $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort ${port}
  Write-Host "Updated firewall rule: ${config.metrics.firewallRuleName} TCP/${port}"
} else {
  New-NetFirewallRule -DisplayName ${ruleName} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} | Out-Null
  Write-Host "Added firewall rule: ${config.metrics.firewallRuleName} TCP/${port}"
}
`);
  }

  if (subcommand === "remove") {
    return runPowerShell(`
$existing = Get-NetFirewallRule -DisplayName ${ruleName} -ErrorAction SilentlyContinue
if ($existing) {
  Remove-NetFirewallRule -DisplayName ${ruleName}
  Write-Host "Removed firewall rule: ${config.metrics.firewallRuleName}"
} else {
  Write-Host "Firewall rule not found: ${config.metrics.firewallRuleName}"
}
`);
  }

  return { status: 2, stdout: "", stderr: `Unknown firewall command: ${subcommand}` };
}

function updateAgent() {
  if (!isWindows()) {
    console.error("Update command is only available on Windows.");
    process.exit(1);
  }

  const config = loadConfig();
  const installDir = appDir();
  const updateUrl = config.update.url;
  if (!updateUrl) {
    console.error("UPDATE_URL is empty.");
    process.exit(1);
  }

  const scriptPath = path.join(os.tmpdir(), `backup-agent-update-${Date.now()}.ps1`);
  const script = `
$ErrorActionPreference = "Stop"
$UpdateUrl = ${quotePowerShell(updateUrl)}
$InstallDir = ${quotePowerShell(installDir)}
$TaskName = ${quotePowerShell(TASK_NAME)}
$CallerPid = ${process.pid}
$WorkDir = Join-Path $env:TEMP ("backup-agent-update-" + [guid]::NewGuid().ToString())
$LogPath = Join-Path $env:TEMP "backup-agent-update.log"

function Log {
    param([string]$Message)
    $Line = "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] $Message"
    Add-Content -Path $LogPath -Value $Line
    Write-Host $Line
}

try {
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $ZipPath = Join-Path $WorkDir "backup-agent-windows.zip"
    $ExtractDir = Join-Path $WorkDir "extract"

    Log "Downloading update from $UpdateUrl"
    Invoke-WebRequest -Uri $UpdateUrl -OutFile $ZipPath -UseBasicParsing

    Log "Extracting update package"
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

    $Installer = Get-ChildItem -Path $ExtractDir -Recurse -Filter "install.ps1" |
        Where-Object { $_.FullName -like "*backup-agent-windows*" } |
        Select-Object -First 1
    if (!$Installer) {
        $Installer = Get-ChildItem -Path $ExtractDir -Recurse -Filter "install.ps1" | Select-Object -First 1
    }
    if (!$Installer) {
        throw "Downloaded package does not contain install.ps1."
    }

    Log "Stopping Scheduled Task $TaskName"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

    try {
        Wait-Process -Id $CallerPid -Timeout 120 -ErrorAction SilentlyContinue
    } catch {}

    Log "Installing update into $InstallDir"
    & $Installer.FullName -InstallDir $InstallDir -TaskName $TaskName -PathScope None

    Log "Update completed"
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
} catch {
    Log "Update failed: $($_.Exception.Message)"
    throw
}
`;

  fs.writeFileSync(scriptPath, script, "utf8");
  const command = `
Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${quotePowerShell(scriptPath)})
Write-Host "backup-agent update started. Log: $env:TEMP\\backup-agent-update.log"
`;
  printPowerShellResult(runPowerShell(command));
}

function uninstall(args) {
  const removeData = args.includes("--remove-data") || args.includes("-RemoveData");
  const script = path.join(appDir(), "uninstall.ps1");
  if (!fs.existsSync(script)) {
    console.error(`Uninstaller was not found: ${script}`);
    process.exit(1);
  }

  if (removeData) {
    const command = `
$script = ${quotePowerShell(script)}
Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Start-Sleep -Seconds 2; & '$script' -RemoveData") -WindowStyle Hidden
Write-Host "backup-agent uninstall scheduled. This command window can be closed."
`;
    printPowerShellResult(runPowerShell(command));
    return;
  }

  printPowerShellResult(runPowerShell(`& ${quotePowerShell(script)}`));
}

function parseLines(args) {
  const index = args.findIndex((arg) => arg === "--lines" || arg === "-n");
  if (index === -1) return 100;
  const value = Number.parseInt(args[index + 1], 10);
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function printValidationErrors(testName, errors) {
  console.error(`${testName} test configuration is invalid:`);
  for (const error of errors) {
    console.error(`ERROR: ${error}`);
  }
  process.exitCode = 1;
}

async function testCommand(args) {
  const target = (args[0] || "").toLowerCase();
  const config = loadConfig();
  const logger = createLogger(config);
  let errors;
  let test;
  let successMessage;

  if (target === "telegram") {
    errors = validateTelegramConfig(config);
    test = () => testTelegram(config, logger);
    successMessage = `Telegram test: OK (chat ${config.telegram.chatId}${config.telegram.topicId ? `, topic ${config.telegram.topicId}` : ""})`;
  } else if (target === "email") {
    errors = validateEmailConfig(config);
    test = () => testEmail(config, logger);
    successMessage = `Email test: OK (${config.email.to.join(", ")})`;
  } else if (["destination", "ssh", "sftp"].includes(target)) {
    errors = validateDestinationConfig(config);
    test = () => testDestination(config, logger);
    successMessage = `Destination test: OK (${config.destination.username}@${config.destination.host}:${config.destination.port}${config.destination.remoteDir})`;
  } else {
    console.error("Usage: backup-agent test telegram|email|destination");
    process.exitCode = 2;
    return;
  }

  if (errors.length > 0) {
    printValidationErrors(target, errors);
    return;
  }

  try {
    await test();
    console.log(successMessage);
  } catch (error) {
    logger.error(`${target} diagnostic test failed`, { error: error.message });
    console.error(`${target[0].toUpperCase()}${target.slice(1)} test: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);

  switch (command.toLowerCase()) {
    case "help":
    case "--help":
    case "-h":
      console.log(usage());
      break;
    case "status":
      printStatus();
      break;
    case "health":
      health();
      break;
    case "logs":
      tailLog(parseLines(args), args.includes("-f") || args.includes("--follow"));
      break;
    case "start":
      startTask();
      break;
    case "stop":
      stopTask();
      break;
    case "restart":
    case "reload-env":
      restartTask();
      break;
    case "edit-env":
    case "editenv":
      editEnv();
      break;
    case "metrics":
      metricsCommand(args);
      break;
    case "firewall":
      firewallCommand(args);
      break;
    case "test":
      await testCommand(args);
      break;
    case "test-telegram":
      await testCommand(["telegram", ...args]);
      break;
    case "test-email":
      await testCommand(["email", ...args]);
      break;
    case "test-destination":
    case "test-ssh":
    case "test-sftp":
      await testCommand(["destination", ...args]);
      break;
    case "update":
      updateAgent();
      break;
    case "run-once":
      runOnce();
      break;
    case "uninstall":
      uninstall(args);
      break;
    case "version":
      console.log(`backup-agent ${packageInfo.version}`);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("");
      console.error(usage());
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(`backup-agent command failed: ${error.stack || error.message}`);
  process.exit(1);
});
