# backup-agent

[![CI](https://github.com/behnambagheri/windows-file-backup-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/behnambagheri/windows-file-backup-agent/actions/workflows/ci.yml)

backup-agent is a self-contained Windows backup agent. It watches a source directory on a cron schedule, uploads matching files over SSH/SFTP, writes local logs, and supports compression, retention policies, Telegram/email notifications, notification fallback, and Prometheus metrics.

The installed name stays `backup-agent` everywhere:

- install directory: `C:\ProgramData\backup-agent`
- Scheduled Task name: `backup-agent`
- PowerShell command: `backup-agent`
- config file: `C:\ProgramData\backup-agent\.env`
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

The release archive includes everything required at runtime; Node.js does not need to be installed on the destination Windows machine.

## Release Package Contents

- `node\`: bundled portable Node.js runtime.
- `app\`: the agent code and runtime dependencies.
- `backup-agent.cmd`: PowerShell/CMD command launcher.
- `.env.example`: complete configuration template.
- `install.ps1`: installs the agent, registers the Scheduled Task, and adds the command to PATH.
- `uninstall.ps1`: removes the Scheduled Task and PATH entry, and optionally removes config/log/state files.
- `README.md`: this guide.
- `LICENSE`: GNU General Public License v3.0.

## Install

1. Download and extract `backup-agent-windows.zip` on the Windows server.
2. Copy `.env.example` to `.env`.
3. Edit `.env` and set the source, destination, SSH auth, schedule, and notification values.
4. Open PowerShell as Administrator in the extracted folder.
5. Run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

By default the installer creates a Scheduled Task named `backup-agent` that runs as `SYSTEM` at boot. This keeps the agent running after a restart, even before a user logs in.

If the source folder, proxy, or network access only works inside the current Windows user session, install it as the current user instead:

```powershell
.\install.ps1 -RunAs CurrentUser
```

The installer adds `C:\ProgramData\backup-agent` to PATH. Open a new PowerShell window after install, then use:

```powershell
backup-agent status
backup-agent health
backup-agent logs
backup-agent logs -f
```

## Commands

```powershell
backup-agent help
backup-agent status
backup-agent health
backup-agent logs
backup-agent logs -f
backup-agent logs --lines 200
backup-agent start
backup-agent stop
backup-agent restart
backup-agent reload-env
backup-agent edit-env
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

`reload-env` restarts the Scheduled Task so the agent reads the latest `.env`.
`edit-env` opens the active `.env` in elevated Notepad and creates it from
`.env.example` when it does not exist. Run `backup-agent reload-env` after saving.

The test commands use the current `.env` settings. Telegram and email tests send
a real diagnostic message even when their notification mode is `off`.
`test destination` connects over SSH/SFTP, ensures `DEST_REMOTE_DIR` exists,
writes and verifies a temporary file there, and removes the file afterward.
The aliases `test-telegram`, `test-email`, and `test-destination` are also available.

Run `start`, `stop`, `restart`, `reload-env`, `update`, and `uninstall` from an elevated PowerShell window when the task was installed as `SYSTEM`.

## Config

The installed config file is:

```text
C:\ProgramData\backup-agent\.env
```

The packaged `.env.example` documents every supported setting, allowed value,
default behavior, and common example. Never commit a real `.env` because it may
contain SSH, Telegram, SMTP, and proxy credentials.

Important keys:

```dotenv
CRON_SCHEDULE=0 */5 * * * *
HOSTNAME=
UPDATE_URL=https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip
METRICS_ENABLED=false
METRICS_HOST=0.0.0.0
METRICS_PORT=9108
METRICS_PATH=/metrics
METRICS_FIREWALL_RULE=false
METRICS_FIREWALL_RULE_NAME=backup-agent metrics
DEST_HOST=192.0.2.10
DEST_PORT=22
DEST_USER=backup-user
DEST_REMOTE_DIR=/backups
CREATE_DESTINATION_DIR=false
DESTINATION_DIR_FORMAT=date
DEST_AUTH_METHOD=password
DEST_PASSWORD=change-me
DEST_PRIVATE_KEY_BASE64=
SSH_SOCKS5_ENABLED=false
SSH_SOCKS5_PROXY=socks5://127.0.0.1:1080

SOURCE_DIR=C:\Backups
SOURCE_FILE_PATTERN=*.bak
SOURCE_LATEST_ONLY=true
DELETE_SOURCE_ON_SUCCESS=false
COMPRESSION=false
RETENTION_POLICY=off
RETENTION_TIME=1d
RETENTION_COUNT=2
SKIP_ALREADY_TRANSFERRED=true

TELEGRAM_MODE=failures
TELEGRAM_FALLBACK=off
TELEGRAM_API_URL=https://api.telegram.org
TELEGRAM_USE_PROXY=false
TELEGRAM_PROXY=socks5://127.0.0.1:1080
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_TOPIC_ID=

EMAIL_MODE=off
EMAIL_FALLBACK=off
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SSL=true
SMTP_USER=
SMTP_PASSWORD=
EMAIL_FROM=backup-agent@example.com
EMAIL_TO=admin@example.com
```

`CRON_SCHEDULE` uses six fields:

```text
second minute hour day-of-month month day-of-week
```

Examples:

- `0 */5 * * * *`: every 5 minutes.
- `0 0 * * * *`: every hour.
- `0 30 2 * * *`: every day at 02:30.

## Hostname

Set this when you want notifications and destination folders to use a custom machine name:

```dotenv
HOSTNAME=sql-prod-01
```

If `HOSTNAME` is empty, backup-agent uses the Windows machine hostname.

## Destination Subdirectories

Set:

```dotenv
CREATE_DESTINATION_DIR=true
DESTINATION_DIR_FORMAT=hostname+date
```

Accepted formats:

- `date`: uploads into `DEST_REMOTE_DIR/YYYY-MM-DD_HH-mm-ss`
- `hostname`: uploads into `DEST_REMOTE_DIR/hostname`
- `hostname+date`: uploads into `DEST_REMOTE_DIR/hostname/YYYY-MM-DD_HH-mm-ss`

Example:

```dotenv
DEST_REMOTE_DIR=/backups
HOSTNAME=sql-prod-01
CREATE_DESTINATION_DIR=true
DESTINATION_DIR_FORMAT=hostname+date
```

The uploaded file goes to a path like:

```text
/backups/sql-prod-01/2026-07-01_13-45-20/database.bak
```

## Compression

Set this in `.env`:

```dotenv
COMPRESSION=true
```

When enabled, backup-agent compresses each selected source file with gzip level 9 before upload. A file named `database.bak` is uploaded as `database.bak.gz`. The temporary compressed file is stored under the local state directory and deleted after the transfer attempt.

`DELETE_SOURCE_ON_SUCCESS=true` still deletes the original source file only after the upload succeeds.

## Retention

Set:

```dotenv
RETENTION_POLICY=off
```

`off` disables retention cleanup.

To delete matching source files older than one day:

```dotenv
RETENTION_POLICY=time
RETENTION_TIME=1d
```

Supported `RETENTION_TIME` units:

- `m`: minutes, for example `60m`
- `h`: hours, for example `12h`
- `d`: days, for example `1d` or `7d`
- `w`: weeks, for example `3w`

To keep only the newest 2 matching files:

```dotenv
RETENTION_POLICY=count
RETENTION_COUNT=2
```

Retention only applies to files matching `SOURCE_FILE_PATTERN`. Time retention uses the source file modified time. Count retention sorts by modified time and keeps the newest N files. If a file was selected for upload and that upload failed, retention keeps that file even when it would otherwise be deleted.

Legacy configs using `RETENTION_MINUTES=1440` still work and are treated as `RETENTION_POLICY=time`.

## Prometheus Metrics

Enable metrics in `.env`:

```dotenv
METRICS_ENABLED=true
METRICS_HOST=0.0.0.0
METRICS_PORT=9108
METRICS_PATH=/metrics
METRICS_FIREWALL_RULE=true
METRICS_FIREWALL_RULE_NAME=backup-agent metrics
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
backup-agent reload-env
```

`install.ps1` creates or updates the Windows Firewall inbound rule when both `METRICS_ENABLED=true` and `METRICS_FIREWALL_RULE=true` are set in `.env`.

Example Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: backup-agent
    static_configs:
      - targets:
          - server-ip:9108
```

The endpoint exposes process uptime, memory, transfer cycle counters, successful/failed file counters, uploaded bytes, last-cycle status and duration, source directory availability, matching file count, oldest matching file age, and active config flags.

## Update

Set:

```dotenv
UPDATE_URL=https://github.com/behnambagheri/windows-file-backup-agent/releases/latest/download/backup-agent-windows.zip
```

Then run:

```powershell
backup-agent update
```

The update command downloads the zip, extracts it, stops the Scheduled Task, installs the downloaded version into the current install directory, and starts the task again. The command creates an elevated PowerShell updater, so Windows may show a UAC prompt.

## Private Key Auth

Set:

```dotenv
DEST_AUTH_METHOD=private_key
DEST_PRIVATE_KEY_BASE64=...
```

Create the base64 value in PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\id_rsa"))
```

If the private key has a passphrase, put it in `DEST_PASSWORD`.

## Logs And State

Logs:

```text
C:\ProgramData\backup-agent\logs\agent.log
```

State:

```text
C:\ProgramData\backup-agent\state\transferred.json
```

When `SKIP_ALREADY_TRANSFERRED=true`, the state file prevents the same unchanged source file from uploading again if `DELETE_SOURCE_ON_SUCCESS=false`.

## Manual Test

After editing `.env`, run one transfer cycle manually:

```powershell
cd C:\ProgramData\backup-agent
backup-agent run-once
```

Check the log afterward:

```powershell
backup-agent logs --lines 50
```

Test notification delivery and destination access separately:

```powershell
backup-agent test telegram
backup-agent test email
backup-agent test destination
```

These tests do not transfer or delete any source backup file. The destination
test may create the configured destination directory when it does not exist.

## Telegram And Email Message Content

Success and failure messages include:

- source host name
- source IP addresses
- source file name and full path
- compression status and upload size
- destination host/IP
- destination remote path
- error message when failed
- event time

Telegram messages use readable HTML formatting. Email messages include both text and HTML versions.

Cross-channel fallback is optional:

```dotenv
TELEGRAM_FALLBACK=email
EMAIL_FALLBACK=telegram
```

When an enabled channel fails, backup-agent tries its configured fallback even
if the fallback channel's normal mode is `off`. The fallback channel must still
have valid credentials. A channel is not sent twice when it already succeeded,
and failures never recurse between Telegram and email.

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

Development and CI use Node.js 24 LTS. Install dependencies and run validation:

```powershell
npm ci
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

To build the self-contained package on Windows, stage the current Windows
`node.exe` and run the packager:

```powershell
New-Item -ItemType Directory -Force .runtime\windows-node | Out-Null
Copy-Item (Get-Command node).Source .runtime\windows-node\node.exe
npm run package:win
```

This creates `backup-agent-windows.zip` and `backup-agent-windows.sha256`.
Generated packages, dependencies, local `.env` files, IDE metadata, logs, and
runtime state are excluded from Git.

## GitHub Actions

The `CI` workflow runs syntax checks, tests, and a production dependency audit
on Linux and Windows. After both test jobs pass, it builds and verifies the
self-contained Windows package and stores the zip and checksum as workflow
artifacts for 30 days.

Pushing a version tag such as `v1.5.0` runs the `Release` workflow. The workflow
requires the tag to match `package.json`, rebuilds and verifies the package, and
publishes both files to a GitHub release. `UPDATE_URL` uses the stable
`releases/latest/download` address, so installed agents always download the
newest published release.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
