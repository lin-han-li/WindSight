import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const targetPlatform = String(process.argv[2] || process.platform).trim().toLowerCase()
const targetArch = String(process.argv[3] || process.arch).trim().toLowerCase()

if (targetPlatform !== "win32" || targetArch !== "x64") {
  throw new Error(`Only Windows x64 packaging is currently supported, got ${targetPlatform}/${targetArch}`)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: false,
      ...options,
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`))
    })
  })
}

function stopExistingBackend() {
  if (process.platform !== "win32") {
    return
  }
  spawnSync("taskkill", ["/F", "/T", "/IM", "windsight-mini-simulator-backend.exe"], {
    cwd: rootDir,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  })
}

async function removeWithRetry(targetPath) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 7) {
        throw error
      }
      stopExistingBackend()
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

const pythonExe = path.join(rootDir, "venv", "Scripts", "python.exe")
if (!existsSync(pythonExe)) {
  await run("python", ["-m", "venv", "venv"])
}

await run(pythonExe, ["-m", "pip", "install", "--upgrade", "pip"])
await run(pythonExe, ["-m", "pip", "install", "-r", "requirements.txt", "pyinstaller==6.11.1"])

const serverDir = path.join(rootDir, "build", "server")
await mkdir(serverDir, { recursive: true })
stopExistingBackend()
await removeWithRetry(path.join(rootDir, "build", "pyinstaller"))
await removeWithRetry(path.join(rootDir, "build", "spec"))
await removeWithRetry(path.join(serverDir, "windsight-mini-simulator-backend.exe"))

const addDataSeparator = process.platform === "win32" ? ";" : ":"
const templatesDir = path.join(rootDir, "templates")
const staticDir = path.join(rootDir, "static")
await run(pythonExe, [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--name",
  "windsight-mini-simulator-backend",
  "--distpath",
  serverDir,
  "--workpath",
  path.join(rootDir, "build", "pyinstaller"),
  "--specpath",
  path.join(rootDir, "build", "spec"),
  "--add-data",
  `${templatesDir}${addDataSeparator}templates`,
  "--add-data",
  `${staticDir}${addDataSeparator}static`,
  path.join(rootDir, "sim.py"),
])

console.log(`[build-server] built ${path.join(serverDir, "windsight-mini-simulator-backend.exe")}`)
