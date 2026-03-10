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
  "001": [690.8, 100.5, 15.2, 32.4],
  "002": [691.1, 100.9, 15.4, 32.8],
  "003": [689.9, 99.8, 14.9, 31.7],
  "004": [690.3, 100.2, 15.1, 32.0]
}
```

## Run

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python sim.py
```

## Notes

- the simulator keeps free-form JSON editing
- the "sample payload" button generates `001..sub` turbine keys automatically
- default `node_id` is `WIN_001`
