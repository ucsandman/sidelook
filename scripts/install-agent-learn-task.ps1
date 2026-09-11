# Registers (or previews, or removes) the Windows scheduled task that runs the Agent Learning Loop nightly.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-agent-learn-task.ps1            # preview only
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-agent-learn-task.ps1 -Apply     # register
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-agent-learn-task.ps1 -Remove    # unregister
# The task runs agent-learning/nightly.mjs (locked, deadline-limited) as the current user when they are logged on.
# It never merges, pushes or changes DashClaw policy; promotion stays a person's `learn.mjs --promote` plus a merge.
param([switch]$Apply, [switch]$Remove, [string]$Time = '02:30', [int]$DeadlineMinutes = 90)
$ErrorActionPreference = 'Stop'
$TaskName = 'Sidelook Agent Learning'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Backups = Join-Path $Repo '.artifacts\agent-learning\task-backups'
$Arguments = "agent-learning/nightly.mjs --deadline-minutes $DeadlineMinutes"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Output "Task:        $TaskName"
Write-Output "Runs:        `"$Node`" $Arguments"
Write-Output "Working dir: $Repo"
Write-Output "Trigger:     daily at $Time, as $env:USERNAME when logged on; start when available; time limit 2 h"
Write-Output ("Existing:    " + $(if ($existing) { $existing.State } else { 'not registered' }))

if ($Remove) {
  if (-not $existing) { Write-Output 'Nothing to remove.'; exit 0 }
  New-Item -ItemType Directory -Force -Path $Backups | Out-Null
  $xml = Join-Path $Backups ("removed-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
  Export-ScheduledTask -TaskName $TaskName | Out-File -Encoding utf8 $xml
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed. Backup XML: $xml"
  exit 0
}
if (-not $Apply) { Write-Output 'Preview only. Add -Apply to register, -Remove to unregister.'; exit 0 }

New-Item -ItemType Directory -Force -Path $Backups | Out-Null
if ($existing) {
  $xml = Join-Path $Backups ("before-apply-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
  Export-ScheduledTask -TaskName $TaskName | Out-File -Encoding utf8 $xml
  Write-Output "Existing task exported to $xml"
}
$action = New-ScheduledTaskAction -Execute $Node -Argument $Arguments -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output ("Registered: state " + $task.State + ", next run " + $info.NextRunTime)
Write-Output "Rollback: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-agent-learn-task.ps1 -Remove"
