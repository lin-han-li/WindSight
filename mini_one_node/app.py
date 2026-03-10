from __future__ import annotations

import os
from datetime import datetime

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

from protocol import ProtocolValidationError, parse_turbine_upload

DEFAULT_NODE_ID = os.environ.get("MINI_NODE_ID", "WIN_001")
ALL_NODES_ROOM = "all_nodes"

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "mini_one_node")

socketio = SocketIO(app, cors_allowed_origins="*")
node_cache: dict[str, dict] = {}


def _utc_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _build_parsed_summary(parsed, received_at: str) -> dict:
    codes = parsed.turbine_codes()
    normalized = {code: parsed.turbines[code].to_dict() for code in codes}
    preview_codes = codes[: min(3, len(codes))]
    return {
        "node_id": parsed.node_id,
        "received_at": received_at,
        "sub": parsed.turbine_count,
        "metric_order": ["voltage", "current", "speed", "temperature"],
        "turbine_codes": codes,
        "preview": {code: normalized[code] for code in preview_codes},
        "turbines": normalized,
    }


def _cached_messages() -> list[dict]:
    return sorted(node_cache.values(), key=lambda item: item.get("received_at") or "", reverse=True)


def _cached_node_items() -> list[dict]:
    items = []
    for msg in _cached_messages():
        parsed = msg.get("parsed") or {}
        items.append(
            {
                "node_id": msg.get("node_id"),
                "received_at": msg.get("received_at"),
                "sub": parsed.get("sub"),
                "turbine_codes": parsed.get("turbine_codes") or [],
            }
        )
    return items


@app.get("/")
def index():
    return render_template("index.html", default_node_id=DEFAULT_NODE_ID)


@app.get("/api/nodes")
def list_nodes():
    return jsonify({"status": "success", "nodes": _cached_node_items()}), 200


@app.post("/api/upload")
def upload():
    payload = request.get_json(silent=True)
    try:
        parsed_upload = parse_turbine_upload(payload)
    except ProtocolValidationError as exc:
        return jsonify({"status": "error", "error": str(exc)}), 400

    received_at = _utc_iso()
    parsed = _build_parsed_summary(parsed_upload, received_at)
    msg = {
        "node_id": parsed_upload.node_id,
        "received_at": received_at,
        "raw": payload,
        "parsed": parsed,
    }
    node_cache[parsed_upload.node_id] = msg

    socketio.emit("mini_update", msg, room=f"node_{parsed_upload.node_id}")
    socketio.emit("mini_update", msg, room=ALL_NODES_ROOM)

    return (
        jsonify(
            {
                "status": "success",
                "node_id": parsed_upload.node_id,
                "sub": parsed_upload.turbine_count,
            }
        ),
        200,
    )


@socketio.on("connect")
def on_connect():
    emit("connected", {"status": "ok"})


@socketio.on("subscribe_node")
def subscribe_node(data):
    node_id = str((data or {}).get("node_id") or "").strip()
    if not node_id:
        emit("error", {"message": "node_id is required"})
        return
    join_room(f"node_{node_id}")
    emit("subscribed", {"node_id": node_id})
    cached = node_cache.get(node_id)
    if cached:
        emit("mini_update", {**cached, "is_initial": True})


@socketio.on("unsubscribe_node")
def unsubscribe_node(data):
    node_id = str((data or {}).get("node_id") or "").strip()
    if not node_id:
        return
    leave_room(f"node_{node_id}")
    emit("unsubscribed", {"node_id": node_id})


@socketio.on("subscribe_all")
def subscribe_all():
    join_room(ALL_NODES_ROOM)
    emit("subscribed_all", {"count": len(node_cache)})
    emit("mini_snapshot", {"nodes": _cached_messages()})


@socketio.on("unsubscribe_all")
def unsubscribe_all():
    leave_room(ALL_NODES_ROOM)
    emit("unsubscribed_all", {"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=False)
