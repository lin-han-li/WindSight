# WindSight Mini Simulator

Local web UI for manually sending the new wind turbine upload protocol.

Default page:

```text
http://127.0.0.1:5100
```

## What it does

- configure target host/port/path
- paste any JSON payload
- generate a sample payload from `node_id + sub`
- send the payload with HTTP POST
- show status code, response body, and elapsed time

## New protocol sample

```json
{
  "node_id": "WIN_001",
  "sub": "4",
  "001": [3.50, 2.00, 2.00, 1.60],
  "002": [3.52, 2.02, 2.03, 1.62],
  "003": [3.54, 2.04, 2.06, 1.64],
  "004": [3.56, 2.06, 2.09, 1.66]
}
```

The sample values are raw `0..5V` sensor voltages. WindSight maps them to
`0..250V`, `0..5A`, `0..2500r/min`, and `0..100°C` after upload.

## Run

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python sim.py
```

## Windows desktop package

This folder can build a double-clickable Electron desktop app. The packaged app starts the bundled Flask backend automatically, so the target machine does not need Python installed.

```bash
npm install
npm run dist:win
```

Output:

```text
release\WindSight Manual Simulator Setup 1.0.0.exe
```

Build layout follows the Codex Gateway pattern:

- `scripts/build-server-binary.mjs` builds the Flask backend into `build/server/windsight-mini-simulator-backend.exe`
- `electron/main.cjs` starts the backend from Electron resources and opens the local UI
- `build/installer.nsh` closes stale app/backend processes during install or uninstall

## Notes

- the simulator keeps free-form JSON editing
- the "sample payload" button generates `001..sub` turbine keys automatically
- default `node_id` is `WIN_001`
