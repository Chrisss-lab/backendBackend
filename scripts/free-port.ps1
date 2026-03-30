param(
  [Parameter(Mandatory = $true)]
  [int] $Port
)

$processes = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($procId in $processes) {
  if ($procId) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
}
