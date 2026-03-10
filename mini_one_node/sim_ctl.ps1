<# 
Mini One Node simulator console

Usage:
- sim_ctl.bat start|stop|restart|status|toggle
#>

param(
  [ValidateSet('', 'start', 'stop', 'restart', 'status', 'toggle')]
  [string]$Action = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

try {
  cmd /c "chcp 65001 >nul" | Out-Null
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  $OutputEncoding = [Console]::OutputEncoding
} catch { }

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

function Get-SimPids {
  $pids = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction Stop
    foreach ($p in $procs) {
      $cmd = $p.CommandLine
      if ($cmd -and ($cmd -match '(?i)(^|\\|/|\s|")sim\.py(\s|"|$)')) {
        $pids += [int]$p.ProcessId
      }
    }
  } catch {
    foreach ($p in (Get-Process -Name python -ErrorAction SilentlyContinue)) {
      $pids += [int]$p.Id
    }
  }
  return ($pids | Sort-Object -Unique)
}

function Get-SimCommandLine([int]$ProcessId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    return $p.CommandLine
  } catch {
    return $null
  }
}

function Start-Sim {
  Write-Host ""
  Write-Host "-------------------------------------" -ForegroundColor DarkGreen
  Write-Host "  Start Simulator" -ForegroundColor Green
  Write-Host "-------------------------------------" -ForegroundColor DarkGreen
  Write-Host ""

  $venvPy = Ensure-Venv

  # Open in a new cmd window to keep logs visible.
  $cmd = ('cd /d "{0}" & "{1}" .\sim.py' -f $ProjectRoot, $venvPy)
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $cmd -WindowStyle Normal | Out-Null

  Start-Sleep -Milliseconds 800
  $pids = Get-SimPids
  if ($pids.Count -gt 0) {
    Write-Host "  [OK] Simulator started (PID: $($pids -join ', '))" -ForegroundColor Green
    Write-Host "  UI: http://127.0.0.1:5100" -ForegroundColor Cyan
  } else {
    Write-Host "  [WARN] Simulator may have failed to start." -ForegroundColor Yellow
  }
  Write-Host ""
}

function Stop-Sim {
  Write-Host ""
  Write-Host "-------------------------------------" -ForegroundColor DarkRed
  Write-Host "  Stop Simulator" -ForegroundColor Red
  Write-Host "-------------------------------------" -ForegroundColor DarkRed
  Write-Host ""

  $pids = Get-SimPids
  if ($pids.Count -eq 0) {
    Write-Host "  [i] Simulator not running." -ForegroundColor Yellow
    Write-Host ""
    return
  }

  foreach ($procId in $pids) {
    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
      Write-Host "  [OK] Stopped PID=$procId" -ForegroundColor Green
    } catch {
      Write-Host "  [WARN] Failed to stop PID=$procId" -ForegroundColor DarkYellow
    }
  }
  Write-Host ""
}

function Show-Status {
  Write-Host ""
  Write-Host "-------------------------------------" -ForegroundColor DarkCyan
  Write-Host "  Simulator Status" -ForegroundColor Cyan
  Write-Host "-------------------------------------" -ForegroundColor DarkCyan
  Write-Host ""

  $pids = Get-SimPids
  if ($pids.Count -eq 0) {
    Write-Host "  Status: STOPPED" -ForegroundColor DarkGray
  } else {
    Write-Host "  Status: RUNNING" -ForegroundColor Green
    foreach ($procId in $pids) {
      $cmd = Get-SimCommandLine $procId
      if ($cmd) {
        Write-Host "  - PID=$procId  $cmd" -ForegroundColor DarkGray
      } else {
        Write-Host "  - PID=$procId" -ForegroundColor DarkGray
      }
    }
  }
  Write-Host ""
}

function Is-Running { return ((Get-SimPids).Count -gt 0) }
function Toggle-Sim { if (Is-Running) { Stop-Sim } else { Start-Sim } }

function Show-Banner {
  Clear-Host
  Write-Host ""
  Write-Host "+---------------------------------------+" -ForegroundColor Magenta
  Write-Host "|     Mini One Node Simulator Console   |" -ForegroundColor Magenta
  Write-Host "+---------------------------------------+" -ForegroundColor Magenta
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
    Write-Host "  [S] Start simulator (new window)" -ForegroundColor Green
    Write-Host "  [X] Stop simulator" -ForegroundColor Red
    Write-Host "  [R] Restart simulator" -ForegroundColor Yellow
    Write-Host "  [T] Toggle" -ForegroundColor Cyan
    Write-Host "  [I] Status" -ForegroundColor Blue
    Write-Host "  [Q] Quit" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "-------------------------------------"
    Write-Host ""

    $sel = Read-Host "  Select"
    switch ($sel.ToUpperInvariant()) {
      'S' { Start-Sim; Read-Host "  Press Enter to continue" | Out-Null }
      'X' { Stop-Sim; Read-Host "  Press Enter to continue" | Out-Null }
      'R' { Stop-Sim; Start-Sim; Read-Host "  Press Enter to continue" | Out-Null }
      'T' { Toggle-Sim; Read-Host "  Press Enter to continue" | Out-Null }
      'I' { Show-Status; Read-Host "  Press Enter to continue" | Out-Null }
      'Q' { Write-Host ""; Write-Host "  Bye"; Write-Host ""; return }
      default { Write-Host "  [WARN] Invalid input" -ForegroundColor Yellow; Start-Sleep -Seconds 1 }
    }
  }
}

switch ($Action) {
  'start'   { Start-Sim }
  'stop'    { Stop-Sim }
  'restart' { Stop-Sim; Start-Sim }
  'status'  { Show-Status }
  'toggle'  { Toggle-Sim }
  default   { Menu }
}
