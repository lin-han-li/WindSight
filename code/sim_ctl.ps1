<# 
WindSight 模拟器控制台（彩色交互界面）

功能：
- 启动/停止/重启/状态/切换 sim.py
- 默认以【新窗口】方式运行 sim.py（便于查看输出；若你想停止，回到本控制台按 X）
- 显示：目标服务器地址 + 本机局域网 IPv4（便于确认局域网环境）

用法：
- 交互菜单：双击 模拟器开关.bat 或运行 sim_ctl.bat
- 非交互：sim_ctl.bat start|stop|restart|status|toggle
#>

param(
  [ValidateSet('', 'start', 'stop', 'restart', 'status', 'toggle')]
  [string]$Action = ''
)

$ErrorActionPreference = 'Stop'

# 项目根目录：本脚本放在根目录
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

function Ensure-Venv311 {
  <#
    确保 venv311 可用。
    - 优先使用项目自带 venv311\Scripts\python.exe
    - 若不存在：尝试用系统 python 创建 venv（不强制要求 py -3.11）
  #>
  $venvPy = Join-Path $ProjectRoot 'venv311\Scripts\python.exe'
  if (Test-Path $venvPy) {
    return $venvPy
  }

  Write-Host "  [!] 未检测到 venv311，将尝试创建虚拟环境..." -ForegroundColor Yellow

  $sysPython = $null
  try { $sysPython = (Get-Command python -ErrorAction Stop).Source } catch { $sysPython = $null }
  if (-not $sysPython) {
    Write-Host "  [×] 未找到系统 python，无法创建 venv311" -ForegroundColor Red
    throw "Python 未安装或未加入 PATH"
  }

  cmd /c "python -m venv venv311" | Out-Null
  if (-not (Test-Path $venvPy)) {
    Write-Host "  [×] venv311 创建失败" -ForegroundColor Red
    throw "venv311 创建失败"
  }

  # 尝试安装依赖（失败也不阻断，让用户自行处理）
  try {
    cmd /c "`"$venvPy`" -m pip install --upgrade pip" | Out-Null
    cmd /c "`"$venvPy`" -m pip install -r requirements.txt" | Out-Null
  } catch {
    Write-Host "  [!] 依赖安装可能失败，请手动运行：venv311\\Scripts\\pip install -r requirements.txt" -ForegroundColor DarkYellow
  }

  Write-Host "  [√] venv311 创建完成" -ForegroundColor Green
  return $venvPy
}

function Get-LanIPv4List {
  <#
    获取本机可用于“局域网访问/联调”的 IPv4 地址列表。
    - 过滤：127.0.0.1、169.254.x.x（APIPA）、0.0.0.0
    - 优先：Get-NetIPAddress
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
        # 兼容中文/英文系统：IPv4 地址 / IPv4 Address
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

function Get-SimPids {
  <#
    通过 Win32_Process 的 CommandLine 精确识别 sim.py 进程。
    说明：sim.py 是客户端，不监听端口，不能像服务器那样通过 netstat 检测。
  #>
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
    # 某些环境可能禁用 CIM；回退到 Get-Process（只能粗略）
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

function Pick-ServerTarget {
  <#
    交互选择 sim.py 的目标服务器地址：
    - 自动（不传参）：由 sim.py 使用默认 http://127.0.0.1:8080
    - 指定：--server

    非交互模式（带 action 参数）下：
    - 读取环境变量 WINDSIGHT_SIM_SERVER_URL（完整URL）
    - 否则：自动
  #>
  if ($Action -ne '') {
    $envServer = $env:WINDSIGHT_SIM_SERVER_URL
    if ($envServer) {
      $u = ($envServer.Trim().TrimEnd('/'))
      return @{ args=@('--server',"$u"); display="$u" }
    }
    return @{ args=@(); display='自动(默认 http://127.0.0.1:8080 )' }
  }

  Write-Host ""
  Write-Host "  请选择目标服务器：" -ForegroundColor White
  Write-Host "   [1] 自动（推荐）：sim.py 默认连接 http://127.0.0.1:8080" -ForegroundColor Green
  Write-Host "   [2] 指定本机端口：127.0.0.1:8080 或 8081" -ForegroundColor Cyan
  Write-Host "   [3] 指定局域网服务器：输入 IP 与端口" -ForegroundColor Cyan
  Write-Host "   [4] 自定义完整 URL：例如 http://192.168.1.10:8080" -ForegroundColor Cyan

  $lanIps = Get-LanIPv4List
  if ($lanIps.Count -gt 0) {
    Write-Host ""
    Write-Host "  本机局域网 IPv4（供参考）：" -ForegroundColor DarkGray
    foreach ($ip in $lanIps) { Write-Host "   - $ip" -ForegroundColor DarkGray }
  }

  $sel = Read-Host "  选择(1-4，默认 1)"
  if (-not $sel) { $sel = '1' }

  switch ($sel) {
    '1' { return @{ args=@(); display='自动(默认 http://127.0.0.1:8080 )' } }
    '2' {
      $port = Read-Host "  请输入端口(8080/8081，默认8080)"
      if (-not $port) { $port = '8080' }
      $u = ("http://{0}:{1}" -f '127.0.0.1', $port)
      return @{ args=@('--server',"$u"); display="$u" }
    }
    '3' {
      $serverHost = Read-Host "  请输入服务器IP(例如 192.168.1.10)"
      $port = Read-Host "  请输入端口(默认8080)"
      if (-not $port) { $port = '8080' }
      $u = ("http://{0}:{1}" -f $serverHost, $port)
      return @{ args=@('--server',"$u"); display="$u" }
    }
    '4' {
      $url = Read-Host "  请输入完整URL(例如 http://192.168.1.10:8080)"
      $url = ($url.Trim().TrimEnd('/'))
      return @{ args=@('--server',"$url"); display="$url" }
    }
    default { return @{ args=@(); display='自动(默认 http://127.0.0.1:8080 )' } }
  }
}

function Pick-SimOptions {
  <#
    选择模拟器参数（节点数量与上报间隔）。
    非交互模式下可通过环境变量指定：
    - WINDSIGHT_SIM_NODES
    - WINDSIGHT_SIM_INTERVAL_MS
  #>
  # 默认 0：不预创建节点，进入 sim.py 后用 add 动态添加
  $nodes = 0
  $interval = 500

  if ($Action -ne '') {
    if ($env:WINDSIGHT_SIM_NODES) {
      [int]::TryParse($env:WINDSIGHT_SIM_NODES, [ref]$nodes) | Out-Null
    }
    if ($env:WINDSIGHT_SIM_INTERVAL_MS) {
      [int]::TryParse($env:WINDSIGHT_SIM_INTERVAL_MS, [ref]$interval) | Out-Null
    }
    if ($nodes -lt 0) { $nodes = 0 }
    if ($interval -lt 50) { $interval = 50 }
    return @{ nodes=$nodes; intervalMs=$interval }
  }

  Write-Host ""
  $n = Read-Host "  初始节点数量(默认0；0表示不预创建，后续用 add 动态注册)"
  if ($n) { [int]::TryParse($n, [ref]$nodes) | Out-Null }
  if ($nodes -lt 0) { $nodes = 0 }

  $i = Read-Host "  上报间隔ms(默认500，建议200~1000)"
  if ($i) { [int]::TryParse($i, [ref]$interval) | Out-Null }
  if ($interval -lt 50) { $interval = 50 }

  return @{ nodes=$nodes; intervalMs=$interval }
}

function Start-Sim {
  Write-Host ""
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkGreen
  Write-Host "  启动模拟器" -ForegroundColor Green
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkGreen
  Write-Host ""

  if ((Get-SimPids).Count -gt 0) {
    Write-Host "  [!] 检测到 sim.py 已在运行，建议先停止或重启" -ForegroundColor Yellow
    Write-Host ""
    return
  }

  try {
    $venvPy = Ensure-Venv311
  } catch {
    Write-Host ""
    return
  }

  $target = Pick-ServerTarget
  $opt = Pick-SimOptions

  $simArgs = @('.\sim.py') + $target.args + @('--nodes', "$($opt.nodes)", '--interval-ms', "$($opt.intervalMs)")

  Write-Host ""
  Write-Host "  [i] Python: 3.11 + venv311" -ForegroundColor Cyan
  Write-Host "  [i] 目标服务器: $($target.display)" -ForegroundColor Cyan
  Write-Host "  [i] 模拟节点数: $($opt.nodes)" -ForegroundColor Cyan
  Write-Host "  [i] 上报间隔: $($opt.intervalMs) ms" -ForegroundColor Cyan
  Write-Host "  [i] 运行方式: 新窗口（便于查看输出）" -ForegroundColor Cyan
  Write-Host ""

  # 新窗口运行：/k 保持窗口不关闭，方便查看输出
  # 说明：Windows PowerShell 5.1 不支持 && 运算符；这里用 cmd 的 & 串联命令
  $simArgLine = ($simArgs -join ' ')
  $cmd = ('cd /d "{0}" & "{1}" {2}' -f $ProjectRoot, $venvPy, $simArgLine)
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $cmd -WindowStyle Normal | Out-Null

  Start-Sleep -Milliseconds 900
  $pids = Get-SimPids
  Write-Host ""
  if ($pids.Count -gt 0) {
    Write-Host "  [√] 模拟器已启动 (PID: $($pids -join ', '))" -ForegroundColor Green
  } else {
    Write-Host "  [!] 未检测到 sim.py 进程，可能启动失败或被安全策略拦截" -ForegroundColor Yellow
    Write-Host "      请检查：是否弹出新窗口、是否有报错信息、或杀软拦截" -ForegroundColor DarkGray
  }
  Write-Host ""
}

function Stop-Sim {
  Write-Host ""
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkRed
  Write-Host "  停止模拟器" -ForegroundColor Red
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkRed
  Write-Host ""

  $pids = Get-SimPids
  if ($pids.Count -eq 0) {
    Write-Host "  [i] 未检测到 sim.py 正在运行" -ForegroundColor Yellow
    Write-Host ""
    return
  }

  Write-Host "  将结束以下 sim.py 进程：" -ForegroundColor White
  foreach ($procId in $pids) {
    $cmd = Get-SimCommandLine $procId
    if ($cmd) {
      Write-Host "   - PID=$procId  $cmd" -ForegroundColor DarkGray
    } else {
      Write-Host "   - PID=$procId" -ForegroundColor DarkGray
    }
  }

  # 非交互模式下：避免 Read-Host 阻塞，默认直接停止
  if ($Action -eq '') {
    $confirm = Read-Host "  确认停止？(Y/N，默认 Y)"
    if ($confirm -and ($confirm.ToUpperInvariant() -ne 'Y')) {
      Write-Host "  [i] 已取消" -ForegroundColor DarkYellow
      Write-Host ""
      return
    }
  }

  foreach ($procId in $pids) {
    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
      Write-Host "  [√] 已结束 PID=$procId" -ForegroundColor Green
    } catch {
      Write-Host "  [!] 结束 PID=$procId 失败（可能已退出或权限不足）" -ForegroundColor DarkYellow
    }
  }
  Write-Host ""
}

function Show-Status {
  Write-Host ""
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkCyan
  Write-Host "  模拟器状态" -ForegroundColor Cyan
  Write-Host "═══════════════════════════════════" -ForegroundColor DarkCyan
  Write-Host ""

  $pids = Get-SimPids
  if ($pids.Count -eq 0) {
    Write-Host "  当前状态: ○ 已停止" -ForegroundColor DarkGray
    Write-Host ""
  } else {
    Write-Host "  当前状态: ● 运行中" -ForegroundColor Green
    Write-Host ""

    foreach ($procId in $pids) {
      $cmd = Get-SimCommandLine $procId
      Write-Host "  - PID=$procId" -NoNewline -ForegroundColor White
      Write-Host "  sim.py" -ForegroundColor DarkGray

      if ($cmd) {
        $server = $null
        if ($cmd -match '--server\s+([^\s"]+|"[^"]+")') {
          $server = $Matches[1].Trim('"')
        } else {
          $server = '自动(默认 http://127.0.0.1:8080 )'
        }
        Write-Host "    目标服务器: $server" -ForegroundColor Cyan
      }
    }
    Write-Host ""
  }

  $lanIps = Get-LanIPv4List
  if ($lanIps.Count -gt 0) {
    Write-Host "  本机局域网 IPv4:" -ForegroundColor White
    foreach ($ip in $lanIps) { Write-Host "    - $ip" -ForegroundColor Cyan }
  } else {
    Write-Host "  本机局域网 IPv4: 未检测到可用地址" -ForegroundColor DarkYellow
  }
  Write-Host ""
}

function Is-Running { return ((Get-SimPids).Count -gt 0) }
function Toggle-Sim { if (Is-Running) { Stop-Sim } else { Start-Sim } }

function Show-Banner {
  Clear-Host
  Write-Host ""
  Write-Host "╔═══════════════════════════════════════╗" -ForegroundColor Magenta
  Write-Host "║                                       ║" -ForegroundColor Magenta
  Write-Host "║     " -NoNewline -ForegroundColor Magenta
  Write-Host "WindSight 模拟器控制台" -NoNewline -ForegroundColor White
  Write-Host "          ║" -ForegroundColor Magenta
  Write-Host "║                                       ║" -ForegroundColor Magenta
  Write-Host "╚═══════════════════════════════════════╝" -ForegroundColor Magenta
  Write-Host ""
}

function Menu {
  while ($true) {
    Show-Banner

    $running = Is-Running
    if ($running) {
      Write-Host "  当前状态: " -NoNewline
      Write-Host "● 运行中" -ForegroundColor Green
    } else {
      Write-Host "  当前状态: " -NoNewline
      Write-Host "○ 已停止" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "─────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  [S] 启动模拟器（新窗口运行）" -ForegroundColor Green
    Write-Host "  [X] 停止模拟器（结束 sim.py）" -ForegroundColor Red
    Write-Host "  [R] 重启模拟器" -ForegroundColor Yellow
    Write-Host "  [T] 一键切换 (运行→停止 / 停止→启动)" -ForegroundColor Cyan
    Write-Host "  [I] 查看状态" -ForegroundColor Blue
    Write-Host "  [Q] 退出" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "─────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""

    $sel = Read-Host "  请选择"
    switch ($sel.ToUpperInvariant()) {
      'S' { Start-Sim; Read-Host "  按回车继续" | Out-Null }
      'X' { Stop-Sim; Read-Host "  按回车继续" | Out-Null }
      'R' { Stop-Sim; Start-Sim; Read-Host "  按回车继续" | Out-Null }
      'T' { Toggle-Sim; Read-Host "  按回车继续" | Out-Null }
      'I' { Show-Status; Read-Host "  按回车继续" | Out-Null }
      'Q' {
        Write-Host ""
        Write-Host "  再见！" -ForegroundColor Magenta
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

switch ($Action) {
  'start'   { Start-Sim }
  'stop'    { Stop-Sim }
  'restart' { Stop-Sim; Start-Sim }
  'status'  { Show-Status }
  'toggle'  { Toggle-Sim }
  default   { Menu }
}

