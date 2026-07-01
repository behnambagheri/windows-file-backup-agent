#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidateSet("System", "CurrentUser")]
    [string]$RunAs = "System",

    [string]$InstallDir = "$env:ProgramData\backup-agent",
    [string]$TaskName = "backup-agent",
    [ValidateSet("Machine", "User", "None")]
    [string]$PathScope = "Machine",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeSource = Join-Path $SourceDir "node\node.exe"
$AppSource = Join-Path $SourceDir "app"
$AgentCmdSource = Join-Path $SourceDir "backup-agent.cmd"
$ConfigExampleSource = Join-Path $SourceDir "config.yaml.example"
$ConfigSource = Join-Path $SourceDir "config.yaml"

if (!(Test-Path $NodeSource) -or !(Test-Path $AppSource)) {
    throw "Missing runtime. Expected node\node.exe plus app\."
}
if (!(Test-Path $ConfigExampleSource)) {
    throw "Missing config.yaml.example."
}

function Add-PathEntry {
    param(
        [string]$Directory,
        [ValidateSet("Machine", "User", "None")]
        [string]$Scope
    )

    if ($Scope -eq "None") {
        return
    }

    $Current = [Environment]::GetEnvironmentVariable("Path", $Scope)
    $Entries = @($Current -split ";" | Where-Object { $_ })
    if ($Entries -notcontains $Directory) {
        $NewPath = (@($Entries) + $Directory) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $NewPath, $Scope)
        if (($env:Path -split ";") -notcontains $Directory) {
            $env:Path = "$env:Path;$Directory"
        }
        Write-Host "Added to $Scope PATH: $Directory"
    }
}

function Get-AgentMetricsConfig {
    param([string]$InstallDir)

    $NodeExe = Join-Path $InstallDir "node\node.exe"
    $ConfigModule = Join-Path $InstallDir "app\src\config.js"
    if (!(Test-Path $NodeExe) -or !(Test-Path $ConfigModule)) {
        return $null
    }

    $OldAgentHome = $env:AGENT_HOME
    try {
        $env:AGENT_HOME = $InstallDir
        $Json = & $NodeExe -e "const { loadConfig } = require(process.argv[1]); const config = loadConfig(); console.log(JSON.stringify(config.metrics));" $ConfigModule
        if ($LASTEXITCODE -ne 0 -or !$Json) {
            return $null
        }
        return $Json | ConvertFrom-Json
    } finally {
        if ($null -eq $OldAgentHome) {
            Remove-Item Env:\AGENT_HOME -ErrorAction SilentlyContinue
        } else {
            $env:AGENT_HOME = $OldAgentHome
        }
    }
}

function Ensure-MetricsFirewallRule {
    param([object]$Metrics)

    if (!$Metrics -or !$Metrics.enabled -or !$Metrics.firewallRule) {
        return
    }

    $Port = [int]$Metrics.port
    $RuleName = [string]$Metrics.firewallRuleName

    $Existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
    if ($Existing) {
        Set-NetFirewallRule -DisplayName $RuleName -Enabled True -Direction Inbound -Action Allow
        $Existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
        Write-Host "Updated firewall rule: $RuleName TCP/$Port"
    } else {
        New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
        Write-Host "Added firewall rule: $RuleName TCP/$Port"
    }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "logs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "state") | Out-Null

Remove-Item -Recurse -Force (Join-Path $InstallDir "node") -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $InstallDir "app") -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $SourceDir "node") (Join-Path $InstallDir "node")
Copy-Item -Recurse -Force $AppSource (Join-Path $InstallDir "app")
Copy-Item -Force $AgentCmdSource (Join-Path $InstallDir "backup-agent.cmd")
Copy-Item -Force (Join-Path $SourceDir "README.md") (Join-Path $InstallDir "README.md")
Copy-Item -Force (Join-Path $SourceDir "uninstall.ps1") (Join-Path $InstallDir "uninstall.ps1")
Copy-Item -Force $ConfigExampleSource (Join-Path $InstallDir "config.yaml.example")

$InstalledConfig = Join-Path $InstallDir "config.yaml"
if (Test-Path $ConfigSource) {
    Copy-Item -Force $ConfigSource $InstalledConfig
} elseif (!(Test-Path $InstalledConfig)) {
    Copy-Item -Force $ConfigExampleSource $InstalledConfig
}

$ActiveConfig = $InstalledConfig
$MetricsConfig = Get-AgentMetricsConfig -InstallDir $InstallDir
Ensure-MetricsFirewallRule -Metrics $MetricsConfig

$Action = New-ScheduledTaskAction `
    -Execute (Join-Path $InstallDir "node\node.exe") `
    -Argument "`"$(Join-Path $InstallDir 'app\src\index.js')`"" `
    -WorkingDirectory $InstallDir

if ($RunAs -eq "System") {
    $Triggers = @(
        New-ScheduledTaskTrigger -AtStartup
    )
    $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
} else {
    $UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Triggers = @(
        New-ScheduledTaskTrigger -AtLogOn -User $UserId
    )
    $Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest
}

$Settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$Task = New-ScheduledTask -Action $Action -Trigger $Triggers -Principal $Principal -Settings $Settings
Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null

if (!$NoStart) {
    Start-ScheduledTask -TaskName $TaskName
}

Add-PathEntry -Directory $InstallDir -Scope $PathScope

Write-Host "Installed backup-agent."
Write-Host "Install directory: $InstallDir"
Write-Host "Config file: $ActiveConfig"
Write-Host "Log file: $(Join-Path $InstallDir 'logs\agent.log')"
Write-Host "Task name: $TaskName"
Write-Host "Run mode: $RunAs"
Write-Host "Command: backup-agent"
