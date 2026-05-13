const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")
const path = require("node:path")
const { spawn } = require("node:child_process")
const { app, BrowserWindow, dialog } = require("electron")

let backendProcess = null
let mainWindow = null
let backendBaseUrl = null
let isQuitting = false
const HEALTH_CHECK_ATTEMPTS = 80
const HEALTH_CHECK_DELAY_MS = 250

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveBackendExePath() {
  const binaryName = "windsight-mini-simulator-backend.exe"
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "server", binaryName)
  }
  return path.join(__dirname, "..", "build", "server", binaryName)
}

function resolveLogPath() {
  return path.join(app.getPath("userData"), "bootstrap.log")
}

function appendLog(message) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true })
    fs.appendFileSync(resolveLogPath(), `[${new Date().toISOString()}] ${message}\n`, "utf8")
  } catch {}
}

function getFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function requestHealth(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        body += chunk
      })
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body)
          return
        }
        reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
      })
    })
    req.setTimeout(1500, () => {
      req.destroy(new Error("health check timeout"))
    })
    req.on("error", reject)
  })
}

async function waitForBackend(baseUrl) {
  let lastError = null
  for (let attempt = 0; attempt < HEALTH_CHECK_ATTEMPTS; attempt += 1) {
    try {
      await requestHealth(`${baseUrl}/api/health`)
      return
    } catch (error) {
      lastError = error
      await delay(HEALTH_CHECK_DELAY_MS)
    }
  }
  throw lastError || new Error("backend startup timeout")
}

async function startBackend() {
  if (backendBaseUrl) {
    return backendBaseUrl
  }

  const exePath = resolveBackendExePath()
  if (!fs.existsSync(exePath)) {
    throw new Error(`Backend executable not found: ${exePath}`)
  }

  const host = "127.0.0.1"
  const port = await getFreePort(host)
  const baseUrl = `http://${host}:${port}`
  appendLog(`starting backend: ${exePath}`)
  appendLog(`backend url: ${baseUrl}`)

  backendProcess = spawn(exePath, [], {
    env: {
      ...process.env,
      SIM_UI_HOST: host,
      SIM_UI_PORT: String(port),
    },
    cwd: path.dirname(exePath),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

  backendProcess.stdout?.on("data", (chunk) => appendLog(`[backend] ${chunk.toString("utf8").trim()}`))
  backendProcess.stderr?.on("data", (chunk) => appendLog(`[backend:error] ${chunk.toString("utf8").trim()}`))
  backendProcess.on("exit", (code, signal) => {
    appendLog(`backend exited: code=${code} signal=${signal}`)
    backendProcess = null
    backendBaseUrl = null
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend-exited")
    }
  })

  backendBaseUrl = baseUrl
  await waitForBackend(baseUrl)
  return baseUrl
}

function stopBackend() {
  if (!backendProcess) {
    return
  }
  const proc = backendProcess
  backendProcess = null
  backendBaseUrl = null
  try {
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true })
      return
    }
    proc.kill("SIGTERM")
  } catch {}
}

async function createWindow() {
  const baseUrl = await startBackend()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1100,
    minHeight: 720,
    title: "WindSight Manual Simulator",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })
  await mainWindow.loadURL(baseUrl)
}

app.whenReady().then(async () => {
  try {
    await createWindow()
  } catch (error) {
    appendLog(`startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    dialog.showErrorBox(
      "WindSight Manual Simulator 启动失败",
      `${error instanceof Error ? error.message : String(error)}\n\n日志: ${resolveLogPath()}`
    )
    app.quit()
  }
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", () => {
  isQuitting = true
  stopBackend()
})

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow()
  }
})
