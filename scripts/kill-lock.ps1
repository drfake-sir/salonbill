$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='workerd.exe' OR Name='wrangler.exe'"
foreach ($p in $procs) {
  Write-Output ("PID {0}: {1}" -f $p.ProcessId, $p.CommandLine)
}
foreach ($p in $procs) {
  if ($p.CommandLine -like "*wrangler*" -or $p.CommandLine -like "*workerd*" -or $p.CommandLine -like "*vite*") {
    Write-Output ("killing {0}" -f $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Write-Output "done"
