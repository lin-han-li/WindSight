<# 
WindSight 服务器控制台（改进版 - 彩色交互界面）

功能：
- 彩色菜单与实时状态显示
- 快捷键支持（S/X/R/T/I/Q）
- 自动检测 venv311（项目自带优先）
- 端口智能选择（5000 优先，占用则用 5002）
- 后台启动，关闭终端不影响服务

用法：
- 交互菜单：双击 服务器开关.bat 或运行 server_toggle.bat
- 非交互：server_toggle.bat start|stop|restart|status|toggle
#>

param(
  [ValidateSet('', 'start', 'stop', 'restart', 'status', 'toggle')]
  [string]$Action = ''
)

$ErrorActionPreference = 'Stop'

# 说明：本脚本放在项目根目录
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

# 控制台输出编码（避免中文乱码）
try {
  cmd /c "chcp 65001 >nul" | Out-Null
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # 忽略编码设置失败
}

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
  <#
    获取本机可用于“局域网访问”的 IPv4 地址列表。
    - 过滤：127.0.0.1、169.254.x.x（APIPA）、0.0.0.0
    - 优先：Get-NetIPAddress（Win10/11 通用）
    - 回退：解析 ipconfig 输出
  #>
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
        # 兼容中文/英文系统：IPv4 地址/IPv4 Address
        if ($line -match '(IPv4.*地址|IPv4 Address)[^:]*:\s*([\d\.]+)') {
          $ip = $Matches[2]
          if ($ip -and $ip -ne '127.0.0.1' -and $ip -ne '0.0.0.0' -and ($ip -notlike '169.254.*')) {
            $ips += $ip
          }
        }
      }
    } catch {
      # 忽略
    }
  }

  return ($ips | Sort-Object -Unique)
}

function Write-AccessUrls([int]$Port) {
  $lanIps = Get-LanIPv4List

  Write-Host "  访问地址: " -NoNewline -ForegroundColor White
  Write-Host ("http://localhost:{0}" -f $Port) -ForegroundColor Cyan

  if ($lanIps.Count -gt 0) {
    Write-Host "  局域网访问: " -ForegroundColor White
    foreach ($ip in $lanIps) {
      Write-Host ("    - http://{0}:{1}" -f $ip, $Port) -ForegroundColor Cyan
    }
    Write-Host "  提示: 需同一局域网/同网段，且防火墙放行该端口" -ForegroundColor DarkGray
  } else {
    Write-Host "  局域网访问: 未检测到可用 IPv4 地址（可能未联网/无网卡）" -ForegroundColor DarkYellow
  }
}

function Stop-WindSight {
  Write-Host ""
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkRed
  Write-Host "  停止服务" -ForegroundColor Red
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkRed
  Write-Host ""

  foreach ($p in @(5000, 5002)) {
    foreach ($procId in (Get-ListeningPids $p)) {
      if ($procId -eq 4) {
        Write-Host ("  [!] 端口 {0} 被 System(PID 4) 占用，无法结束" -f $p) -ForegroundColor Yellow
        continue
      }
      try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        # 只结束 python.exe（避免误伤其他服务）
        if ($proc.Path -and ($proc.Path -match 'python\.exe$')) {
          Write-Host ("  [√] 结束 PID={0} (python.exe) 端口={1}" -f $procId, $p) -ForegroundColor Green
          Stop-Process -Id $procId -Force
        } else {
          Write-Host ("  [!] PID={0} 不是 python.exe，跳过" -f $procId) -ForegroundColor DarkYellow
        }
      } catch {
        # 进程已不存在或无权限
      }
    }
  }

  Write-Host ""
  Write-Host "  [√] 停止完成" -ForegroundColor Green
  Write-Host ""
}

function Ensure-Venv311 {
  <#
    优先使用项目自带 venv311。
    若不存在，尝试创建（优先 py -3.11，其次 python）。
  #>
  $venvPy = Join-Path $ProjectRoot 'venv311\Scripts\python.exe'
  if (Test-Path $venvPy) {
    return $venvPy
  }

  Write-Host "  [i] 未检测到 venv311，开始创建..." -ForegroundColor Cyan

  $pyLauncherOk = $false
  try {
    $null = cmd /c "py -3.11 -V 2>nul"
    if ($LASTEXITCODE -eq 0) { $pyLauncherOk = $true }
  } catch { $pyLauncherOk = $false }

  if ($pyLauncherOk) {
    cmd /c "py -3.11 -m venv venv311" | Out-Null
  } else {
    cmd /c "python -m venv venv311" | Out-Null
  }

  if (-not (Test-Path $venvPy)) {
    Write-Host "  [×] venv311 创建失败" -ForegroundColor Red
    throw "venv311 创建失败"
  }

  cmd /c "`"$venvPy`" -m pip install --upgrade pip" | Out-Null
  cmd /c "`"$venvPy`" -m pip install -r requirements.txt" | Out-Null
  Write-Host "  [√] venv311 创建完成" -ForegroundColor Green
  return $venvPy
}

function Pick-Port {
  # 5000 空闲优先，否则用 5002
  if ((Get-ListeningPids 5000).Count -eq 0) { return 5000 }
  if ((Get-ListeningPids 5002).Count -eq 0) { return 5002 }
  Write-Host "  [!] 5000 和 5002 端口均被占用" -ForegroundColor Yellow
  return 5002  # 仍返回 5002，让启动时报错更明确
}

function Start-WindSight {
  Write-Host ""
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkGreen
  Write-Host "  启动服务" -ForegroundColor Green
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkGreen
  Write-Host ""

  try {
    $venvPy = Ensure-Venv311
  } catch {
    Write-Host ""
    return
  }

  $port = Pick-Port

  if (-not (Test-Path (Join-Path $ProjectRoot 'logs'))) {
    New-Item -ItemType Directory -Path (Join-Path $ProjectRoot 'logs') | Out-Null
  }

  # 强制 eventlet（与旧版控制台一致；若 eventlet 不可用，app.py 会提示原因）
  $env:FORCE_ASYNC_MODE = 'eventlet'
  $env:PORT = "$port"
  $env:ALLOWED_ORIGINS = '*'

  $stdout = Join-Path $ProjectRoot 'logs\server_eventlet_stdout.log'
  $stderr = Join-Path $ProjectRoot 'logs\server_eventlet_stderr.log'

  # 尽量显示 venv Python 版本（与参考控制台一致）
  $pyVer = $null
  try {
    $pyVerOut = cmd /c "`"$venvPy`" -V 2>nul"
    if ($pyVerOut) {
      $m = [regex]::Match(($pyVerOut | Select-Object -First 1), 'Python\s+([0-9]+\.[0-9]+\.[0-9]+)')
      if ($m.Success) { $pyVer = $m.Groups[1].Value }
    }
  } catch { }
  if (-not $pyVer) { $pyVer = '3.11.x' }

  Write-Host ("  [i] Python: {0} (venv311)" -f $pyVer) -ForegroundColor Cyan
  Write-Host "  [i] 异步模式: eventlet" -ForegroundColor Cyan
  Write-Host ("  [i] 端口: {0}" -f $port) -ForegroundColor Cyan
  Write-Host ""

  # 后台启动，关闭终端不影响服务
  Start-Process -FilePath $venvPy -ArgumentList '.\app.py' -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden | Out-Null

  Write-Host "  [i] 正在启动，请稍候..." -ForegroundColor Cyan

  # 循环检测启动状态（最多 10 次，每次 0.5 秒）
  $maxAttempts = 10
  $attempt = 0
  $started = $false

  while ($attempt -lt $maxAttempts) {
    Start-Sleep -Milliseconds 500
    $attempt++
    $pids = Get-ListeningPids $port
    if ($pids.Count -gt 0) {
      $started = $true
      break
    }
  }

  Write-Host ""

  if ($started) {
    Write-Host "  [√] 启动成功！" -ForegroundColor Green
    Write-Host ""
    Write-AccessUrls -Port $port
    Write-Host "  默认管理员: 由后端首次启动自动创建（可在 edgewind.env 配置 WINDSIGHT_DEFAULT_ADMIN_*）" -ForegroundColor DarkGray
    Write-Host "  日志文件: logs\server_eventlet_stdout.log" -ForegroundColor DarkGray
  } else {
    Write-Host "  [!] 端口未在 5 秒内监听，可能启动较慢或启动失败" -ForegroundColor Yellow
    Write-Host ("  请稍候片刻后访问: http://localhost:{0}" -f $port) -ForegroundColor Cyan
    Write-Host "  或检查日志: logs\server_eventlet_stderr.log" -ForegroundColor DarkGray
  }
  Write-Host ""
}

function Show-Status {
  Write-Host ""
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkCyan
  Write-Host "  服务器状态" -ForegroundColor Cyan
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkCyan
  Write-Host ""

  $lanIps = Get-LanIPv4List
  $hasListener = $false

  foreach ($p in @(5000, 5002)) {
    $pids = Get-ListeningPids $p
    if ($pids.Count -eq 0) {
      Write-Host ("  端口 {0} : " -f $p) -NoNewline -ForegroundColor White
      Write-Host "未监听" -ForegroundColor DarkGray
      continue
    }

    $hasListener = $true

    Write-Host "  访问地址: " -NoNewline -ForegroundColor White
    Write-Host ("http://localhost:{0}" -f $p) -ForegroundColor Cyan

    if ($lanIps.Count -gt 0) {
      Write-Host "  局域网访问: " -ForegroundColor White
      foreach ($ip in $lanIps) {
        Write-Host ("    - http://{0}:{1}" -f $ip, $p) -ForegroundColor Cyan
      }
    }
    Write-Host ""

    foreach ($procId in $pids) {
      try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $path = $proc.Path
        Write-Host ("  端口 {0} : " -f $p) -NoNewline -ForegroundColor White
        Write-Host "运行中" -NoNewline -ForegroundColor Green
        Write-Host (" (PID={0})" -f $procId) -ForegroundColor DarkGray
        Write-Host ("    进程: {0}" -f $proc.ProcessName) -ForegroundColor DarkGray
        if ($path -match 'Python311') {
          Write-Host "    版本: Python 3.11 + eventlet" -ForegroundColor DarkGreen
        } else {
          if ($path) {
            Write-Host ("    路径: {0}" -f $path) -ForegroundColor DarkGray
          }
        }
      } catch {
        Write-Host ("  端口 {0} : PID={1} (进程信息不可获取)" -f $p, $procId) -ForegroundColor DarkYellow
      }
    }
  }

  if (-not $hasListener) {
    Write-Host "  [i] 服务器未运行" -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "  日志位置: logs\server_eventlet_stdout.log" -ForegroundColor DarkGray
  Write-Host ""
}

function Is-Running {
  return ((Get-ListeningPids 5000).Count -gt 0) -or ((Get-ListeningPids 5002).Count -gt 0)
}

function Get-RunningPorts {
  $ports = @()
  foreach ($p in @(5000, 5002)) {
    if ((Get-ListeningPids $p).Count -gt 0) { $ports += $p }
  }
  return ($ports | Sort-Object -Unique)
}

function Toggle-WindSight {
  if (Is-Running) { Stop-WindSight } else { Start-WindSight }
}

function Read-HostSafe([string]$Prompt) {
  try {
    return (Read-Host $Prompt)
  } catch {
    return $null
  }
}

function Pause-Continue {
  $null = Read-HostSafe "  按回车继续"
}

function Show-Banner {
  Clear-Host
  Write-Host ""
  Write-Host "╔═══════════════════════════════════════╗" -ForegroundColor Cyan
  Write-Host "║                                       ║" -ForegroundColor Cyan
  Write-Host "║     " -NoNewline -ForegroundColor Cyan
  Write-Host "WindSight 服务器控制台" -NoNewline -ForegroundColor White
  Write-Host "        ║" -ForegroundColor Cyan
  Write-Host "║                                       ║" -ForegroundColor Cyan
  Write-Host "╚═══════════════════════════════════════╝" -ForegroundColor Cyan
  Write-Host ""
}

function Menu {
  while ($true) {
    Show-Banner

    $running = Is-Running
    if ($running) {
      Write-Host "  当前状态: " -NoNewline
      Write-Host "● 运行中" -ForegroundColor Green

      $ports = Get-RunningPorts
      $lanIps = Get-LanIPv4List
      foreach ($p in $ports) {
        Write-Host "  访问地址: " -NoNewline -ForegroundColor White
        Write-Host ("http://localhost:{0}" -f $p) -ForegroundColor Cyan
        if ($lanIps.Count -gt 0) {
          Write-Host "  局域网访问: " -ForegroundColor White
          foreach ($ip in $lanIps) {
            Write-Host ("    - http://{0}:{1}" -f $ip, $p) -ForegroundColor Cyan
          }
        }
      }
    } else {
      Write-Host "  当前状态: " -NoNewline
      Write-Host "○ 已停止" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "─────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  [S] 启动服务 (Python 3.11 + eventlet)" -ForegroundColor Green
    Write-Host "  [X] 停止服务 (5000/5002)" -ForegroundColor Red
    Write-Host "  [R] 重启服务" -ForegroundColor Yellow
    Write-Host "  [T] 一键切换 (运行→停止 / 停止→启动)" -ForegroundColor Cyan
    Write-Host "  [I] 查看状态" -ForegroundColor Blue
    Write-Host "  [Q] 退出" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "─────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""

    $sel = Read-HostSafe "  请选择"
    if (-not $sel) {
      Write-Host ""
      Write-Host "  [!] 当前环境不支持交互输入。" -ForegroundColor Yellow
      Write-Host "      请使用命令：server_toggle.bat status/start/stop/restart/toggle" -ForegroundColor DarkGray
      Write-Host ""
      return
    }

    switch ($sel.ToUpperInvariant()) {
      'S' { Start-WindSight; Pause-Continue }
      'X' { Stop-WindSight; Pause-Continue }
      'R' { Stop-WindSight; Start-WindSight; Pause-Continue }
      'T' { Toggle-WindSight; Pause-Continue }
      'I' { Show-Status; Pause-Continue }
      'Q' {
        Write-Host ""
        Write-Host "  再见！" -ForegroundColor Cyan
        Write-Host ""
        return
      }
      default {
        Write-Host ""
        Write-Host "  [!] 无效输入，请重试" -ForegroundColor Yellow
        Start-Sleep -Seconds 1
      }
    }
  }
}

# 主入口
switch ($Action) {
  'start'   { Start-WindSight }
  'stop'    { Stop-WindSight }
  'restart' { Stop-WindSight; Start-WindSight }
  'status'  { Show-Status }
  'toggle'  { Toggle-WindSight }
  default   { Menu }
}


