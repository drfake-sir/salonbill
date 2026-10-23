# Stop local wrangler test instances that hold deploy-worker/deploy-assets open.
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='workerd.exe' OR Name='wrangler.exe'"
foreach ($p in $procs) {
  $cl = [string]$p.CommandLine
  if ($cl -match '8791|8792|8793|deploytest|nocompat|olddate|wrangler.deploytest|wrangler.nocompat|wrangler.olddate') {
    Write-Output ("killing {0}: {1}" -f $p.ProcessId, $cl.Substring(0, [Math]::Min(100, $cl.Length)))
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Write-Output "done"
