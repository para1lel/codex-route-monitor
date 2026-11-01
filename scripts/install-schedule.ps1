# An OS schedule for the monitor, for a machine whose magpie may be closed
# when a slot comes: two Windows Scheduled Tasks, both calling
# `scan --scope auto`, which does nothing unless the schedule says a slot is
# due (so the plugin's own tick and this one never run a scan twice).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-schedule.ps1
#   ... -Cli <path to bin\codex-route-monitor.mjs> -Node <path to node.exe>
#   ... -Uninstall
#   ... -DryRun      say what would be registered

param(
    [string]$Cli = "",
    [string]$Node = "",
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$TaskNames = @("CodexRouteMonitor-Daily", "CodexRouteMonitor-3-Hourly")

function Remove-Tasks {
    foreach ($name in $TaskNames) {
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $existing) {
            Write-Host "not there: $name"
            continue
        }
        if ($DryRun) {
            Write-Host "would remove: $name"
            continue
        }
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "removed: $name"
    }
}

if ($Uninstall) {
    Remove-Tasks
    exit 0
}

if (-not $Node) {
    $found = Get-Command node -ErrorAction SilentlyContinue
    if (-not $found) { throw "node was not found; pass -Node <path to node.exe>" }
    $Node = $found.Source
}
if (-not $Cli) {
    $Cli = Join-Path (Split-Path -Parent $PSScriptRoot) "bin\codex-route-monitor.mjs"
}
if (-not (Test-Path $Cli)) { throw "the monitor's command line was not found at $Cli" }

$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Cli`" scan --scope auto --trigger os"
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3)

$dailyTrigger = New-ScheduledTaskTrigger -Daily -At "00:00"
$threeHourlyTrigger = New-ScheduledTaskTrigger -Once -At "03:00" `
    -RepetitionInterval (New-TimeSpan -Hours 3) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$tasks = @(
    @{ Name = $TaskNames[0]; Trigger = $dailyTrigger; Description = "Codex route monitor: every Codex account at midnight (magpie-codex-route-monitor)" },
    @{ Name = $TaskNames[1]; Trigger = $threeHourlyTrigger; Description = "Codex route monitor: the Codex accounts in use, every three hours (magpie-codex-route-monitor)" }
)

foreach ($task in $tasks) {
    $line = "node `"$Cli`" scan --scope auto --trigger os  ($($task.Name))"
    if ($DryRun) {
        Write-Host "would register: $line"
        continue
    }
    Register-ScheduledTask -TaskName $task.Name -Action $action -Trigger $task.Trigger -Settings $settings -Description $task.Description -Force | Out-Null
    Write-Host "registered: $line"
}

if (-not $DryRun) {
    Write-Host ""
    Write-Host "Both tasks run only when a slot is due; see:"
    Write-Host "  schtasks /Query /TN $($TaskNames[0]) /V /FO LIST"
    Write-Host "  node `"$Cli`" schedule"
}
