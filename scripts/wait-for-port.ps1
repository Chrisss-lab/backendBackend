param(
  [int]$Port = 3001,
  [int]$TimeoutSeconds = 120
)

# Fast port check (avoid Test-NetConnection — first run can be very slow on some PCs)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)

while ((Get-Date) -lt $deadline) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $waitMs = 400
    if ($connect.AsyncWaitHandle.WaitOne($waitMs, $false)) {
      try {
        $client.EndConnect($connect)
      }
      catch {
        # still not ready
      }
      if ($client.Connected) {
        Write-Host "Port $Port is accepting connections."
        exit 0
      }
    }
  }
  catch {
    # ignore
  }
  finally {
    if ($null -ne $client) {
      try { $client.Close() } catch { }
    }
  }

  Start-Sleep -Milliseconds 500
}

Write-Host "Timed out after ${TimeoutSeconds}s waiting for port $Port."
exit 1
