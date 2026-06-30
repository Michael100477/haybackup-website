$log = "C:\HayBackup-Website\task-register.log"
try {
    $procId = (Get-NetTCPConnection -LocalPort 8090 -State Listen -EA SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($procId) { Stop-Process -Id $procId -Force -EA SilentlyContinue }
    Start-Sleep 1
    $a = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "server.js" -WorkingDirectory "C:\HayBackup-Website"
    $t = New-ScheduledTaskTrigger -AtStartup
    $pr = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName "HayBackup Website" -Description "HayBackup public website (port 8090)" -Action $a -Trigger $t -Principal $pr -Settings $s -Force | Out-Null
    Start-Sleep 1
    Start-ScheduledTask -TaskName "HayBackup Website"
    "OK $(Get-Date -Format o) registered+started" | Set-Content $log
} catch {
    "ERROR $(Get-Date -Format o): $($_.Exception.Message)" | Set-Content $log
}
