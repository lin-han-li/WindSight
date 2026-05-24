# WindSight

WindSight is a Flask + Flask-SocketIO + SQLAlchemy(SQLite) monitoring system for wind turbine nodes.

## Current protocol

`POST /api/upload`

Required fields:

- `node_id`: node name, string
- `sub`: turbine count in the current packet, integer/string, range `1..200`
- `001..200`: one key per turbine in the current packet; keys are absolute
  turbine numbers and do not need to start at `001`

Each turbine value must be a 4-item raw sensor-voltage array. Every raw value
must be in the `0..5V` range:

```json
[voltage_sensor_v, current_sensor_v, speed_sensor_v, temperature_sensor_v]
```

The server maps raw `0..5V` sensor values to engineering values before storing
and pushing them to the UI:

| Metric | Raw input | Stored/displayed range |
| --- | --- | --- |
| Voltage | `0..5V` | `0..250V` |
| Current | `0..5V` | `0..5A` |
| Speed | `0..5V` | `0..2500r/min` |
| Temperature | `0..5V` | `0..100°C` |

Example:

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
