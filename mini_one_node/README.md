# WindSight Mini One Node

Legacy receiver, now aligned to the new wind turbine payload protocol.

It does not require login or a database. It simply:

- accepts `POST /api/upload`
- validates the new protocol strictly
- emits Socket.IO updates for all nodes
- shows a live multi-node list plus raw/parsed content in the browser

## Current protocol

Required fields:

- `node_id`: non-empty string
- `sub`: integer/string in `1..64`
- `001..NNN`: continuous zero-padded turbine keys matching `sub`

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

## Run

```bash
cd mini_one_node
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Receiver page:

```text
http://localhost:5000/
```

Optional single-node filter:

```text
http://localhost:5000/?node_id=WIN_001
```

Manual simulator page:

```text
http://127.0.0.1:5100
```

## Notes

- Default page monitors all nodes
- `?node_id=WIN_001` switches back to single-node filtering
- This mini project now validates only the new protocol
- Socket.IO client is loaded from CDN
