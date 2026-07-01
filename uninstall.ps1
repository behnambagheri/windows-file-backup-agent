#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramData\backup-agent",
    [string]$TaskName = "backup-agent",
    [switch]$RemoveData
)

$ErrorActionPreference = "Stop"

function Remove-PathEntry {
    param(
        [string]$Directory,
        [ValidateSet("Machine", "User")]
        [string]$Scope
    )

    $Current = [Environment]::GetEnvironmentVariable("Path", $Scope)
    if (!$Current) {
        return
    }

    $Entries = @($Current -split ";" | Where-Object { $_ -and ($_ -ne $Directory) })
    $NewPath = $Entries -join ";"
    if ($NewPath -ne $Current) {
        [Environment]::SetEnvironmentVariable("Path", $NewPath, $Scope)
        Write-Host "Removed from $Scope PATH: $Directory"
    }
}

function Get-AgentMetricsRuleName {
    param(
        [string]$InstallDir,
        [string]$Default = "backup-agent metrics"
    )

    $NodeExe = Join-Path $InstallDir "node\node.exe"
    $ConfigModule = Join-Path $InstallDir "app\src\config.js"
    if (!(Test-Path $NodeExe) -or !(Test-Path $ConfigModule)) {
        return $Default
    }

    $OldAgentHome = $env:AGENT_HOME
    try {
        $env:AGENT_HOME = $InstallDir
        $RuleName = & $NodeExe -e "const { loadConfig } = require(process.argv[1]); const config = loadConfig(); console.log(config.metrics.firewallRuleName || process.argv[2]);" $ConfigModule $Default
        if ($LASTEXITCODE -ne 0 -or !$RuleName) {
            return $Default
        }
        return ([string]$RuleName).Trim()
    } finally {
        if ($null -eq $OldAgentHome) {
            Remove-Item Env:\AGENT_HOME -ErrorAction SilentlyContinue
        } else {
            $env:AGENT_HOME = $OldAgentHome
        }
    }
}

$MetricsRuleName = Get-AgentMetricsRuleName -InstallDir $InstallDir

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task: $TaskName"
} else {
    Write-Host "Scheduled task was not found: $TaskName"
}

Remove-PathEntry -Directory $InstallDir -Scope "Machine"
Remove-PathEntry -Directory $InstallDir -Scope "User"

if (Get-NetFirewallRule -DisplayName $MetricsRuleName -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -DisplayName $MetricsRuleName
    Write-Host "Removed firewall rule: $MetricsRuleName"
}

if ($RemoveData) {
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
        Write-Host "Removed install directory: $InstallDir"
    }
} else {
    Write-Host "Kept config, state, and logs in: $InstallDir"
    Write-Host "Run with -RemoveData to remove them too."
}

Write-Host "Uninstall finished."
