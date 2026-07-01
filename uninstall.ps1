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

$EnvPath = Join-Path $InstallDir ".env"
$MetricsRuleName = Get-DotEnvValue -Path $EnvPath -Name "METRICS_FIREWALL_RULE_NAME" -Default "backup-agent metrics"

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
