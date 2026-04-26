from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

ALL_NODES_TOKEN = "__all__"
ALL_NODES_ROOM = "nodes_all"
DEFAULT_NODE_ID = (os.environ.get("MINI_NODE_ID") or "").strip()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "mini_server")
app.config["SESSION_COOKIE_NAME"] = os.environ.get(
    "SESSION_COOKIE_NAME", "mini_server_session"
)

socketio = SocketIO(app, cors_allowed_origins="*")

LAST_MESSAGES: dict[str, dict[str, Any]] = {}
NODE_MESSAGE_COUNTS: dict[str, int] = {}


def _utc_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _normalize_node_id(value: Any) -> str:
    return str(value or "").strip()


def _coerce_float_list(arr: Any, expected_len: int = 32) -> list[float] | None:
    if not isinstance(arr, list) or len(arr) != expected_len:
        return None

    out: list[float] = []
    for item in arr:
        try:
            out.append(float(item))
        except Exception:
            return None
    return out


def _node_registry() -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for node_id, msg in LAST_MESSAGES.items():
        nodes.append(
            {
                "node_id": node_id,
                "received_at": msg.get("received_at"),
                "message_count": NODE_MESSAGE_COUNTS.get(node_id, 0),
            }
        )
    nodes.sort(key=lambda item: (item["received_at"] or "", item["node_id"]), reverse=True)
    return nodes


def _latest_snapshot() -> list[dict[str, Any]]:
    return [LAST_MESSAGES[item["node_id"]] for item in _node_registry()]


def _emit_registry_to_current_client() -> None:
    emit(
        "node_registry",
        {
            "nodes": _node_registry(),
            "all_nodes_token": ALL_NODES_TOKEN,
            "default_node_id": DEFAULT_NODE_ID or None,
        },
    )


@app.get("/")
def index():
    return render_template(
        "index.html",
        default_node_id=DEFAULT_NODE_ID,
        all_nodes_token=ALL_NODES_TOKEN,
    )


@app.get("/api/nodes")
def list_nodes():
    return jsonify(
        {
            "status": "success",
            "nodes": _node_registry(),
            "all_nodes_token": ALL_NODES_TOKEN,
        }
    )


@app.post("/api/upload")
def upload():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"status": "error", "error": "JSON body required"}), 400

    node_id = _normalize_node_id(payload.get("node_id"))
    if not node_id:
        return jsonify({"status": "error", "error": "node_id is required"}), 400

    parsed: dict[str, Any] = {"node_id": node_id, "received_at": _utc_iso()}

    has_any_arrays = any(key in payload for key in ("voltages", "currents", "speeds"))
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

    LAST_MESSAGES[node_id] = msg
    NODE_MESSAGE_COUNTS[node_id] = NODE_MESSAGE_COUNTS.get(node_id, 0) + 1

    socketio.emit("mini_update", msg, room=f"node_{node_id}")
    socketio.emit("mini_update", msg, room=ALL_NODES_ROOM)
    socketio.emit(
        "node_registry",
        {
            "nodes": _node_registry(),
            "all_nodes_token": ALL_NODES_TOKEN,
            "default_node_id": DEFAULT_NODE_ID or None,
        },
        room=ALL_NODES_ROOM,
    )
    return jsonify({"status": "success", "node_id": node_id}), 200


@socketio.on("connect")
def on_connect():
    emit(
        "connected",
        {
            "status": "ok",
            "all_nodes_token": ALL_NODES_TOKEN,
            "default_node_id": DEFAULT_NODE_ID or None,
        },
    )
    _emit_registry_to_current_client()


@socketio.on("subscribe_all")
def subscribe_all():
    join_room(ALL_NODES_ROOM)
    emit("subscribed_all", {"scope": ALL_NODES_TOKEN})
    _emit_registry_to_current_client()
    emit("snapshot", {"messages": _latest_snapshot()})


@socketio.on("unsubscribe_all")
def unsubscribe_all():
    leave_room(ALL_NODES_ROOM)
    emit("unsubscribed_all", {"scope": ALL_NODES_TOKEN})


@socketio.on("subscribe_node")
def subscribe_node(data):
    node_id = _normalize_node_id((data or {}).get("node_id"))
    if not node_id:
        emit("error", {"message": "node_id is required"})
        return

    if node_id == ALL_NODES_TOKEN:
        subscribe_all()
        return

    join_room(f"node_{node_id}")
    emit("subscribed", {"node_id": node_id})
    latest = LAST_MESSAGES.get(node_id)
    if latest:
        emit("mini_update", latest)


@socketio.on("unsubscribe_node")
def unsubscribe_node(data):
    node_id = _normalize_node_id((data or {}).get("node_id"))
    if not node_id:
        return

    if node_id == ALL_NODES_TOKEN:
        unsubscribe_all()
        return

    leave_room(f"node_{node_id}")
    emit("unsubscribed", {"node_id": node_id})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=False)
