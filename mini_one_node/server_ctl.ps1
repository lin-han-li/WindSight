<# 
Mini One Node server console

Usage:
- server_toggle.bat start|stop|restart|status|toggle
#>

param(
  [ValidateSet('', 'start', 'stop', 'restart', 'status', 'toggle')]
  [string]$Action = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

# Console encoding (avoid garbled text)
try {
  cmd /c "chcp 65001 >nul" | Out-Null
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  $OutputEncoding = [Console]::OutputEncoding
} catch { }

function Get-ListeningPids([int]$Port) {
  $lines = netstat -ano | Select-String -Pattern "LISTENING"
  $pids = @()
  foreach ($line in $lines) {
    $s = $line.ToString()
    if ($s -match (":$Port\s+.*LISTENING\s+(\d+)\s*$")) {
      $pids += [int]$Matches[1]
    }
  }
  return ($pids | Sort-Object -Unique)
}

function Get-LanIPv4List {
  $ips = @()
  try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -and
        $_.IPAddress -ne '127.0.0.1' -and
        $_.IPAddress -ne '0.0.0.0' -and
        ($_.IPAddress -notlike '169.254.*')
      } |
      Select-Object -ExpandProperty IPAddress
  } catch {
    try {
      $out = cmd /c "ipconfig"
      foreach ($line in $out) {
        if ($line -match '(IPv4.*地址|IPv4 Address)[^:]*:\s*([\d\.]+)') {
          $ip = $Matches[2]
          if ($ip -and $ip -ne '127.0.0.1' -and $ip -ne '0.0.0.0' -and ($ip -notlike '169.254.*')) {
            $ips += $ip
          }
        }
      }
    } catch { }
  }
  return ($ips | Sort-Object -Unique)
}

function Ensure-Venv {
  $venvPy = Join-Path $ProjectRoot 'venv\Scripts\python.exe'
  if (Test-Path $venvPy) { return $venvPy }

  $pyLauncherOk = $false
  try {
    $null = cmd /c "py -3.11 -V 2>nul"
    if ($LASTEXITCODE -eq 0) { $pyLauncherOk = $true }
  } catch { $pyLauncherOk = $false }

  if ($pyLauncherOk) {
    cmd /c "py -3.11 -m venv venv" | Out-Null
  } else {
    cmd /c "python -m venv venv" | Out-Null
  }

  if (-not (Test-Path $venvPy)) {
    Write-Host "  [ERROR] venv create failed. Please install Python." -ForegroundColor Red
    throw "venv create failed"
  }

  cmd /c "`"$venvPy`" -m pip install --upgrade pip" | Out-Null
  cmd /c "`"$venvPy`" -m pip install -r requirements.txt" | Out-Null
  return $venvPy
}

function Pick-Port {
  if ((Get-ListeningPids 5000).Count -eq 0) { return 5000 }
  if ((Get-ListeningPids 5002).Count -eq 0) { return 5002 }
  return 5002
}

function Start-MiniServer {
  Write-Host ""
  Write-Host "-------------------------------------" -ForegroundColor DarkGreen
  Write-Host "  Start Mini Server" -ForegroundColor Green
  Write-Host "-------------------------------------" -ForegroundColor DarkGreen
  Write-Host ""

  $venvPy = Ensure-Venv
  $port = Pick-Port

  $logDir = Join-Path $ProjectRoot 'logs'
  if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
  }

  $stdout = Join-Path $logDir 'mini_server_stdout.log'
  $stderr = Join-Path $logDir 'mini_server_stderr.log'

  $env:PORT = "$port"
  # 重要：不要用 PowerShell 的反引号续行（`）。某些编辑器会在其后插入不可见空格，导致脚本解析失败。
  $sp = @{
    FilePath               = $venvPy
    ArgumentList           = '.\app.py'
    WorkingDirectory       = $ProjectRoot
    RedirectStandardOutput = $stdout
    RedirectStandardError  = $stderr
    WindowStyle            = 'Hidden'
  }
  Start-Process @sp | Out-Null

  Write-Host "  [OK] Started: http://localhost:$port" -ForegroundColor Green
  Write-Host "  Logs: logs\mini_server_stdout.log" -ForegroundColor DarkGray
  Write-Host ""
}

function Stop-MiniServer {
  Write-Host ""
  Write-Host "-------------------------------------" -ForegroundColor DarkRed
  Write-Host "  Stop Mini Server" -ForegroundColor Red
  Write-Host "-------------------------------------" -ForegroundColor DarkRed
  Write-Host ""

  foreach ($p in @(5000, 5002)) {
    foreach ($procId in (Get-ListeningPids $p)) {
      if ($procId -eq 4) { continue }
      try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        if ($proc.Path -and ($proc.Path -match 'python\.exe$')) {
          Stop-Process -Id $procId -Force
          Write-Host ("  [OK] Stopped PID={0} (port {1})" -f $procId, $p) -ForegroundColor Green
        }
      } catch { }
    }
  }
  Write-Host ""
}

function Show-Status {
  Write-Host ""
  Write-Host "-------------------------------------" -ForegroundColor DarkCyan
  Write-Host "  Mini Server Status" -ForegroundColor Cyan
  Write-Host "-------------------------------------" -ForegroundColor DarkCyan
  Write-Host ""

  $lanIps = Get-LanIPv4List
  $hasListener = $false

  foreach ($p in @(5000, 5002)) {
    $pids = Get-ListeningPids $p
    if ($pids.Count -eq 0) {
      Write-Host ("  Port {0} : not listening" -f $p) -ForegroundColor DarkGray
      continue
    }

    $hasListener = $true
    Write-Host ("  URL: http://localhost:{0}" -f $p) -ForegroundColor Cyan
    if ($lanIps.Count -gt 0) {
      Write-Host "  LAN:" -ForegroundColor White
      foreach ($ip in $lanIps) {
        Write-Host ("    - http://{0}:{1}" -f $ip, $p) -ForegroundColor Cyan
      }
    }
    foreach ($procId in $pids) {
      Write-Host ("  PID={0}" -f $procId) -ForegroundColor DarkGray
    }
    Write-Host ""
  }

  if (-not $hasListener) {
    Write-Host "  [i] Mini server is not running." -ForegroundColor Yellow
  }
  Write-Host "  Logs: logs\mini_server_stdout.log" -ForegroundColor DarkGray
  Write-Host ""
}

function Is-Running {
  return ((Get-ListeningPids 5000).Count -gt 0) -or ((Get-ListeningPids 5002).Count -gt 0)
}

function Toggle-Mini {
  if (Is-Running) { Stop-MiniServer } else { Start-MiniServer }
}

function Read-HostSafe([string]$Prompt) {
  try { return (Read-Host $Prompt) } catch { return $null }
}

function Pause-Continue { $null = Read-HostSafe "  Press Enter to continue" }

function Show-Banner {
  Clear-Host
  Write-Host ""
  Write-Host "+---------------------------------------+" -ForegroundColor Cyan
  Write-Host "|       Mini One Node Server Console    |" -ForegroundColor Cyan
  Write-Host "+---------------------------------------+" -ForegroundColor Cyan
  Write-Host ""
}

function Menu {
  while ($true) {
    Show-Banner

    if (Is-Running) {
      Write-Host "  Status: " -NoNewline
      Write-Host "RUNNING" -ForegroundColor Green
    } else {
      Write-Host "  Status: " -NoNewline
      Write-Host "STOPPED" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "-------------------------------------" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  [S] Start server" -ForegroundColor Green
    Write-Host "  [X] Stop server" -ForegroundColor Red
    Write-Host "  [R] Restart server" -ForegroundColor Yellow
    Write-Host "  [T] Toggle" -ForegroundColor Cyan
    Write-Host "  [I] Status" -ForegroundColor Blue
    Write-Host "  [Q] Quit" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "-------------------------------------"
    Write-Host ""

    $sel = Read-HostSafe "  Select"
    if (-not $sel) {
      Write-Host "  [!] Interactive input not available." -ForegroundColor Yellow
      Write-Host "      Use: server_toggle.bat status/start/stop/restart/toggle" -ForegroundColor DarkGray
      return
    }

    switch ($sel.ToUpperInvariant()) {
      'S' { Start-MiniServer; Pause-Continue }
      'X' { Stop-MiniServer; Pause-Continue }
      'R' { Stop-MiniServer; Start-MiniServer; Pause-Continue }
      'T' { Toggle-Mini; Pause-Continue }
      'I' { Show-Status; Pause-Continue }
      'Q' { Write-Host ""; Write-Host "  Bye"; Write-Host ""; return }
      default { Write-Host "  [!] Invalid input" -ForegroundColor Yellow; Start-Sleep -Seconds 1 }
    }
  }
}

switch ($Action) {
  'start'   { Start-MiniServer }
  'stop'    { Stop-MiniServer }
  'restart' { Stop-MiniServer; Start-MiniServer }
  'status'  { Show-Status }
  'toggle'  { Toggle-Mini }
  default   { Menu }
}
