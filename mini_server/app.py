from __future__ import annotations

import os
from datetime import datetime

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

DEFAULT_NODE_ID = os.environ.get("MINI_NODE_ID", "WIND_001")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "mini_server")

# Flask-SocketIO 5.x：与 Socket.IO JS client v4（Engine.IO v4）匹配
socketio = SocketIO(app, cors_allowed_origins="*")


def _utc_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _coerce_float_list(arr, expected_len: int = 32) -> list[float] | None:
    if not isinstance(arr, list) or len(arr) != expected_len:
        return None
    out: list[float] = []
    for x in arr:
        try:
            out.append(float(x))
        except Exception:
            return None
    return out


@app.get("/")
def index():
    return render_template("index.html", default_node_id=DEFAULT_NODE_ID)


@app.post("/api/upload")
def upload():
    """
    最小上报接口（无需登录）：

    必填：
    - node_id: string

    可选（若出现任何一个，则必须同时提供三者）：
    - voltages / currents / speeds：长度 32，元素可转 float
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"status": "error", "error": "JSON body required"}), 400

    node_id = (payload.get("node_id") or "").strip()
    if not node_id:
        return jsonify({"status": "error", "error": "node_id is required"}), 400

    parsed: dict = {"node_id": node_id, "received_at": _utc_iso()}

    has_any_arrays = any(k in payload for k in ("voltages", "currents", "speeds"))
    if has_any_arrays:
        if "voltages" not in payload or "currents" not in payload or "speeds" not in payload:
            return (
                jsonify(
                    {
                        "status": "error",
                        "error": "voltages/currents/speeds must all be provided",
                    }
                ),
                400,
            )

        voltages = _coerce_float_list(payload.get("voltages"), 32)
        currents = _coerce_float_list(payload.get("currents"), 32)
        speeds = _coerce_float_list(payload.get("speeds"), 32)
        if voltages is None or currents is None or speeds is None:
            return (
                jsonify(
                    {
                        "status": "error",
                        "error": "voltages/currents/speeds must be 32-length float arrays",
                    }
                ),
                400,
            )

        parsed["lengths"] = {
            "voltages": len(voltages),
            "currents": len(currents),
            "speeds": len(speeds),
        }
        parsed["sample"] = {"v0": voltages[0], "c0": currents[0], "s0": speeds[0]}
        parsed["first3"] = {
            "voltages": voltages[:3],
            "currents": currents[:3],
            "speeds": speeds[:3],
        }

    msg = {
        "node_id": node_id,
        "received_at": parsed["received_at"],
        "raw": payload,
        "parsed": parsed,
    }
    socketio.emit("mini_update", msg, room=f"node_{node_id}")
    return jsonify({"status": "success"}), 200


@socketio.on("connect")
def on_connect():
    emit("connected", {"status": "ok"})


@socketio.on("subscribe_node")
def subscribe_node(data):
    node_id = (data or {}).get("node_id")
    if not node_id:
        emit("error", {"message": "node_id is required"})
        return
    join_room(f"node_{node_id}")
    emit("subscribed", {"node_id": node_id})


@socketio.on("unsubscribe_node")
def unsubscribe_node(data):
    node_id = (data or {}).get("node_id")
    if not node_id:
        return
    leave_room(f"node_{node_id}")
    emit("unsubscribed", {"node_id": node_id})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=False)

