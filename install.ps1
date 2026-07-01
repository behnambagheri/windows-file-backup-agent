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
$EnvExampleSource = Join-Path $SourceDir ".env.example"
$EnvSource = Join-Path $SourceDir ".env"

if (!(Test-Path $NodeSource) -or !(Test-Path $AppSource)) {
    throw "Missing runtime. Expected node\node.exe plus app\."
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

function Get-DotEnvValue {
    param(
        [string]$Path,
        [string]$Name,
        [string]$Default = ""
    )

    if (!(Test-Path $Path)) {
        return $Default
    }

    $Match = Get-Content $Path | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -Last 1
    if (!$Match) {
        return $Default
    }

    return (($Match -split "=", 2)[1]).Trim().Trim("'").Trim('"')
}

function Test-DotEnvBool {
    param(
        [string]$Path,
        [string]$Name,
        [bool]$Default = $false
    )

    $Value = (Get-DotEnvValue -Path $Path -Name $Name -Default "").ToLower()
    if ($Value -eq "") {
        return $Default
    }
    return @("1", "true", "yes", "y", "on") -contains $Value
}

function Ensure-MetricsFirewallRule {
    param([string]$EnvPath)

    $MetricsEnabled = Test-DotEnvBool -Path $EnvPath -Name "METRICS_ENABLED"
    $FirewallEnabled = Test-DotEnvBool -Path $EnvPath -Name "METRICS_FIREWALL_RULE"
    if (!$MetricsEnabled -or !$FirewallEnabled) {
        return
    }

    $Port = [int](Get-DotEnvValue -Path $EnvPath -Name "METRICS_PORT" -Default "9108")
    $RuleName = Get-DotEnvValue -Path $EnvPath -Name "METRICS_FIREWALL_RULE_NAME" -Default "backup-agent metrics"

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
Copy-Item -Force $EnvExampleSource (Join-Path $InstallDir ".env.example")

$InstalledEnv = Join-Path $InstallDir ".env"
if (Test-Path $EnvSource) {
    Copy-Item -Force $EnvSource $InstalledEnv
} elseif (!(Test-Path $InstalledEnv)) {
    Copy-Item -Force $EnvExampleSource $InstalledEnv
}

Ensure-MetricsFirewallRule -EnvPath $InstalledEnv

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
Write-Host "Config file: $InstalledEnv"
Write-Host "Log file: $(Join-Path $InstallDir 'logs\agent.log')"
Write-Host "Task name: $TaskName"
Write-Host "Run mode: $RunAs"
Write-Host "Command: backup-agent"
