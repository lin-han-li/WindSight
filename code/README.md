# WindSight

WindSight is a Flask + Flask-SocketIO + SQLAlchemy(SQLite) monitoring system for wind turbine nodes.

## Current protocol

`POST /api/upload`

Required fields:

- `node_id`: node name, string
- `sub`: turbine count, integer/string, range `1..64`
- `001..NNN`: one key per turbine, zero-padded and continuous from `001` to `sub`

Each turbine value must be:

```json
[voltage, current, speed, temperature]
```

Example:

```json
{
  "node_id": "WIN_001",
  "sub": "4",
  "001": [690.1, 101.2, 15.4, 32.8],
  "002": [689.8, 100.9, 15.1, 32.5],
  "003": [691.0, 101.6, 15.8, 33.1],
  "004": [690.4, 100.7, 15.0, 32.2]
}
```

Server behavior:

- validates the payload strictly
- writes one row to `node_uploads`
- writes one row per turbine to `turbine_measurements`
- pushes real-time updates through `monitor_update` and `node_data_update`

## Database notes

- New data is stored in `node_uploads` and `turbine_measurements`.
- Legacy table `node_data` is kept as backup only.
- Old `node_data` rows are not migrated and are not used by the new UI/API flow.

## Main pages

- `/system_overview`: node status wall and summary
- `/monitor`: real-time node -> turbine -> metric view
- `/overview`: history playback by node/turbine/metric
- `/settings`: cleanup, delete by node, VACUUM, system info

## Local run

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open:

- `http://localhost:8080`

## Cleanup behavior

- `WINDSIGHT_CLEAN_DB_ON_START=1` clears only the new protocol tables plus `system_config`.
- Legacy `node_data` is intentionally preserved.
