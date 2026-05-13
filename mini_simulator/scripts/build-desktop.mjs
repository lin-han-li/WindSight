import { existsSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = String(process.argv[2] || "").trim().toLowerCase()
const arch = String(process.argv[3] || "").trim().toLowerCase()

if (target !== "win") {
  throw new Error(`Unknown desktop build target: ${target || "<empty>"}. Use win.`)
}
if (process.platform !== "win32") {
  throw new Error(`Windows installer builds must run on Windows. Current host is ${process.platform}.`)
}
if (arch && arch !== "x64") {
  throw new Error(`Unsupported Windows arch: ${arch}. Supported: x64`)
}

const cliPath = path.join(rootDir, "node_modules", "electron-builder", "out", "cli", "cli.js")
if (!existsSync(cliPath)) {
  throw new Error(`electron-builder CLI not found: ${cliPath}. Run npm install first.`)
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

function cleanDesktopArtifacts() {
  if (process.env.SKIP_RELEASE_CLEAN === "1") {
    return
  }
  const releaseDir = path.join(rootDir, "release")
  if (!existsSync(releaseDir)) {
    return
  }
  const patterns = [
    /^WindSight Manual Simulator Setup .*\.exe$/i,
    /^WindSight Manual Simulator Setup .*\.exe\.blockmap$/i,
    /^latest\.yml$/i,
    /^builder-debug\.yml$/i,
    /^win-unpacked$/i,
  ]
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (patterns.some((pattern) => pattern.test(entry.name))) {
      rmSync(path.join(releaseDir, entry.name), { recursive: true, force: true })
    }
  }
}

cleanDesktopArtifacts()
await run(process.execPath, [
  cliPath,
  "--win",
  "nsis",
  "--x64",
  "--publish",
  "never",
  "--config.win.signAndEditExecutable=false",
])
