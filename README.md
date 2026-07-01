# backup-agent

[![CI](https://github.com/behnambagheri/windows-file-backup-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/behnambagheri/windows-file-backup-agent/actions/workflows/ci.yml)

backup-agent is a self-contained Windows backup agent for scheduled SSH/SFTP uploads. It can watch multiple configured sources, upload matching files or whole directories, compress before upload, apply source retention, send Telegram/email notifications with fallback, expose Prometheus metrics, and continue running after Windows restarts.

The installed name stays `backup-agent` everywhere:

- install directory: `C:\ProgramData\backup-agent`
- Scheduled Task name: `backup-agent`
- PowerShell command: `backup-agent`
- config file: `C:\ProgramData\backup-agent\config.yaml`
- log file: `C:\ProgramData\backup-agent\logs\agent.log`

## Download

Download the latest self-contained Windows package and checksum:

- [backup-agent-windows.zip](https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip)
- [backup-agent-windows.sha256](https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.sha256)

Verify the download in PowerShell:

```powershell
$expected = ((Get-Content .\backup-agent-windows.sha256 -Raw).Trim() -split "\s+")[0]
$actual = (Get-FileHash .\backup-agent-windows.zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA256 verification failed" }
```

The release archive includes the portable Node.js runtime and all runtime dependencies. Node.js does not need to be installed on the destination Windows machine.

## Package Contents

- `node\`: bundled portable Node.js runtime.
- `app\`: the agent code and runtime dependencies.
- `backup-agent.cmd`: PowerShell/CMD command launcher.
- `config.yaml.example`: complete commented YAML configuration template.
- `install.ps1`: installs the agent, registers the Scheduled Task, and adds the command to PATH.
- `uninstall.ps1`: removes the Scheduled Task and PATH entry, and optionally removes config/log/state files.
- `README.md`: this guide.
- `LICENSE`: GNU General Public License v3.0.

## Install

1. Download and extract `backup-agent-windows.zip` on the Windows server.
2. Copy `config.yaml.example` to `config.yaml`.
3. Edit `config.yaml` and set destination, SSH auth, sources, schedule, and notifications.
4. Open PowerShell as Administrator in the extracted folder.
5. Run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

By default the installer creates a Scheduled Task named `backup-agent` that runs as `SYSTEM` at boot. This keeps the agent running after a restart, even before a user logs in.

If the source folder, proxy, or network access only works inside the current Windows user session, install it as the current user:

```powershell
.\install.ps1 -RunAs CurrentUser
```

The installer adds `C:\ProgramData\backup-agent` to PATH. Open a new PowerShell window after install, then use:

```powershell
backup-agent status
backup-agent health
backup-agent logs -f
```

Upgrades preserve an existing `config.yaml`. New installs and current releases use YAML configuration only.

## Commands

```powershell
backup-agent help
backup-agent status
backup-agent health
backup-agent progress
backup-agent progress -f
backup-agent progress --json
backup-agent logs
backup-agent logs -f
backup-agent logs --lines 200
backup-agent start
backup-agent stop
backup-agent restart
backup-agent edit-config
backup-agent metrics status
backup-agent metrics enable --port 9108 --firewall
backup-agent metrics disable
backup-agent firewall status
backup-agent firewall add --port 9108
backup-agent firewall remove
backup-agent test telegram
backup-agent test email
backup-agent test destination
backup-agent update
backup-agent run-once
backup-agent uninstall
backup-agent uninstall --remove-data
backup-agent version
```

`edit-config` opens the active config file in elevated Notepad. `progress` prints the latest transfer queue and upload state, `progress -f` refreshes it live, and `progress --json` prints the full progress state for scripts. Telegram and email test commands send a real diagnostic message even when their notification mode is `off`. The destination test connects over SSH/SFTP, ensures the remote directory exists, writes/verifies a temporary file, and removes it.

Run `start`, `stop`, `restart`, `update`, and `uninstall` from an elevated PowerShell window when the task was installed as `SYSTEM`.

## YAML Config

The installed config file is:

```text
C:\ProgramData\backup-agent\config.yaml
```

The packaged `config.yaml.example` documents every supported setting, allowed value, default behavior, and common example. Never commit a real `config.yaml` because it may contain SSH, Telegram, SMTP, and proxy credentials.

Minimal shape:

```yaml
schedule:
  cron: '0 */5 * * * *'

proxy:
  protocol: socks5
  host: 127.0.0.1
  port: 1080
  username: ''
  password: ''

destination:
  host: '192.0.2.10'
  port: 22
  user: backup-user
  remote_dir: /backups
  auth_method: password
  password: change-me
  use_proxy: false

sources:
  defaults:
    mode: files
    source_file_pattern: '*.bak'
    latest_only: true
    min_age_seconds: 10
    delete_on_success: false
    compression: false
    retention_policy: off
    retention_time: 1d
    retention_count: 2
    skip_already_transferred: true
  items:
    - name: database_backups
      source_dir: 'C:\Backups\Database'
    - name: application_data
      mode: directory
      source_dir: 'D:\AppData\ImportantFolder'
      compression: true
      retention_policy: off
```

`sources.defaults` is the global source policy. Every entry in `sources.items` inherits those values unless the entry overrides them.

`schedule.cron` uses six fields:

```text
second minute hour day-of-month month day-of-week
```

Examples:

- `0 */5 * * * *`: every 5 minutes.
- `0 0 * * * *`: every hour.
- `0 30 2 * * *`: every day at 02:30.

Scheduled cycles do not overlap. If a cron tick fires while the previous transfer cycle is still running, backup-agent logs a warning and skips that tick. A process-level lock file also prevents a second agent process from running at the same time.

## Live Progress

The agent writes live transfer state to:

```text
C:\ProgramData\backup-agent\state\progress.json
```

Use:

```powershell
backup-agent progress
backup-agent progress -f
backup-agent progress --json
```

The progress view includes the active cycle status, current item, queued items, completed items, failed items, total upload bytes, transferred bytes, remaining bytes, and percentage. During compression it shows `compressing`; upload percentages start once the final upload size is known.

## Source Modes

`mode: files` selects files directly inside `source_dir` that match `source_file_pattern`. It does not recurse into subdirectories. If `latest_only` is true, only the newest matching file by modified time is uploaded.

`mode: directory` treats `source_dir` itself as one transfer item. With `compression: true`, the directory is uploaded as a `.tar.gz` archive. With `compression: false`, the directory is uploaded recursively over SFTP into a remote folder named after the local directory.

`delete_on_success: true` deletes the uploaded source file in file mode. In directory mode, it deletes the whole local source directory only after the complete upload succeeds.

`skip_already_transferred: true` records successful transfer fingerprints in `state\transferred.json` and skips unchanged items on future cycles.

## Destination Folders

Enable dynamic destination folders:

```yaml
destination:
  remote_dir: /backups
  create_dir: true
  dir_format: hostname+date
```

Accepted `dir_format` values:

- `date`: uploads into `/backups/YYYY-MM-DD_HH-mm-ss`
- `hostname`: uploads into `/backups/hostname`
- `hostname+date`: uploads into `/backups/hostname/YYYY-MM-DD_HH-mm-ss`

Set `app.hostname` when you want a custom name in notifications and destination folders. If it is empty, backup-agent uses the Windows machine hostname.

## Compression

Compression is configured per source:

```yaml
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups\Database'
      compression: true
```

File mode uses gzip level 9 and uploads `database.bak` as `database.bak.gz`. Directory mode uses tar plus gzip level 9 and uploads `ImportantFolder.tar.gz`. Temporary compressed files are stored under the local state directory and removed after the transfer attempt.

## Retention

Retention is configured per source and applies only to `mode: files` sources:

```yaml
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups\Database'
      retention_policy: time
      retention_time: 1d
```

Supported `retention_time` units:

- `s`: seconds, for example `30s`
- `m`: minutes, for example `60m`
- `h`: hours, for example `12h`
- `d`: days, for example `1d` or `7d`
- `w`: weeks, for example `3w`

To keep only the newest 2 matching files:

```yaml
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups\Database'
      retention_policy: count
      retention_count: 2
```

To use both limits safely, use `smart`. It keeps the union of both policies: files newer than `retention_time` and the newest `retention_count` files. This means the rule that preserves more files wins.

```yaml
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups\Database'
      retention_policy: smart
      retention_time: 5d
      retention_count: 30
```

For long backup history, use `perspective`. It keeps all backups in the current scope, then keeps the oldest representative from larger calendar buckets.

```yaml
sources:
  items:
    - name: database_backups
      source_dir: 'C:\Backups\Database'
      retention_policy: perspective
      perspective_scope: day
```

Supported `perspective_scope` values:

- `hour`: keep all files from the current hour, then hourly, weekly, monthly, and yearly representatives.
- `day`: keep all files from today, then one oldest file per week in the current month, one oldest file per month in the current year, and one oldest file per older year.
- `week`: keep all files from the current week, then one oldest file per month in the current year and one oldest file per older year.
- `month`: keep all files from the current month, then one oldest file per month in the current year and one oldest file per older year.
- `year`: keep all files from the current year, then one oldest file per older year.

Retention only deletes files matching that source's `source_file_pattern`. If a file was selected for upload and that upload failed, retention keeps it even when it would otherwise be deleted.

## Proxy

Define the shared SOCKS proxy once:

```yaml
proxy:
  protocol: socks5
  host: 127.0.0.1
  port: 1080
  username: ''
  password: ''
```

`protocol` can be `socks4`, `socks4a`, `socks5`, or `socks5h`. `username` and `password` are optional; leave both empty for proxies without authentication.

Then enable it only where needed:

```yaml
update:
  use_proxy: false
destination:
  use_proxy: false
notifications:
  telegram:
    use_proxy: false
  email:
    use_proxy: false
```

## Prometheus Metrics

Enable metrics in YAML:

```yaml
metrics:
  enabled: true
  host: '0.0.0.0'
  port: 9108
  path: /metrics
  firewall_rule: true
  firewall_rule_name: backup-agent metrics
```

When enabled, scrape:

```text
http://server-ip:9108/metrics
```

Health check:

```text
http://server-ip:9108/healthz
```

Useful command-line controls:

```powershell
backup-agent metrics status
backup-agent metrics enable --port 9108 --host 0.0.0.0 --path /metrics
backup-agent metrics enable --port 9108 --firewall
backup-agent metrics disable
backup-agent firewall status
backup-agent firewall add --port 9108
backup-agent firewall remove
```

`install.ps1` creates or updates the Windows Firewall inbound rule when both `metrics.enabled: true` and `metrics.firewall_rule: true` are set. Metrics include process uptime, memory, transfer cycle status, per-source transfer counters, uploaded bytes, source directory availability, matching item counts, oldest matching item age, compression flags, and retention settings.

## Notifications

Telegram and email support `off`, `all`, `success`, and `failures` modes:

```yaml
notifications:
  telegram:
    mode: failures
    fallback: email
    timeout_ms: 60000
    retry_count: 2
    retry_delay_ms: 3000
    bot_token: ''
    chat_id: ''
    topic_id: ''
  email:
    mode: off
    fallback: telegram
    smtp_host: smtp.example.com
    smtp_port: 465
    smtp_ssl: true
    from: backup-agent@example.com
    to:
      - admin@example.com
```

When an enabled channel fails, backup-agent tries its configured fallback even if the fallback channel's normal mode is `off`. The fallback channel must still have valid credentials. Failures never recurse between Telegram and email.

Telegram requests use `timeout_ms` and retry transient network failures, including slow or unstable proxy/TLS setup errors. `retry_count: 2` means one initial request plus two retries.

Success and failure messages include source host, source IP addresses, configured source name, source file or directory path, compression status, human-readable original/upload size, destination host, destination remote path, error message when failed, and event time.

## Update

Default update URL:

```yaml
update:
  url: 'https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip'
  use_proxy: false
```

Run:

```powershell
backup-agent update
```

The update command downloads the zip, extracts it, stops the Scheduled Task, installs the downloaded version into the current install directory, and starts the task again. Windows may show a UAC prompt because the updater runs elevated.

## Private Key Auth

Set:

```yaml
destination:
  auth_method: private_key
  private_key_base64: ''
```

Create the base64 value in PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\id_rsa"))
```

If the private key has a passphrase, put it in `destination.password`.

## Logs And State

```text
C:\ProgramData\backup-agent\logs\agent.log
C:\ProgramData\backup-agent\state\transferred.json
```

Manual test flow:

```powershell
backup-agent health
backup-agent test destination
backup-agent test telegram
backup-agent test email
backup-agent run-once
backup-agent logs --lines 50
```

The notification tests do not transfer or delete source data. The destination test may create the configured destination directory when it does not exist.

## Uninstall

Open PowerShell as Administrator:

```powershell
backup-agent uninstall
```

This removes the Scheduled Task and PATH entry, and keeps config, state, and logs.

To remove everything:

```powershell
backup-agent uninstall --remove-data
```

## Development

Development and CI use Node.js 24 LTS:

```powershell
npm ci
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

To build the self-contained package on Windows, stage the current Windows `node.exe` and run the packager:

```powershell
New-Item -ItemType Directory -Force .runtime\windows-node | Out-Null
Copy-Item (Get-Command node).Source .runtime\windows-node\node.exe
npm run package:win
```

This creates `backup-agent-windows.zip` and `backup-agent-windows.sha256`. Generated packages, dependencies, local `config.yaml` files, IDE metadata, logs, and runtime state are excluded from Git.

## GitHub Actions

The `CI` workflow runs syntax checks, tests, and a production dependency audit on Linux and Windows. After both test jobs pass, it builds and verifies the self-contained Windows package and stores the zip and checksum as workflow artifacts for 30 days.

Pushing a version tag runs the `Release` workflow. The workflow requires the tag to match `package.json`, rebuilds and verifies the package, and publishes the zip and checksum to a GitHub release. The default update URL uses the stable `releases/latest/download` address, so installed agents download the newest published release.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
