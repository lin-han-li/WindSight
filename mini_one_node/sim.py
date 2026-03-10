from __future__ import annotations

import json
import os
import time
from urllib.parse import urlparse

import requests
from flask import Flask, jsonify, render_template, request

# =========================
# Mini 手动上报模拟器（Web UI）
# =========================
# 目标：手动输入任意 JSON，配置目标 IP/端口/路径，点击发送即可 POST。

DEFAULT_NODE_ID = os.environ.get("MINI_NODE_ID", "WIN_001")
DEFAULT_TARGET_HOST = os.environ.get("MINI_TARGET_HOST", "127.0.0.1")
DEFAULT_TARGET_PORT = int(os.environ.get("MINI_TARGET_PORT", "5000"))
DEFAULT_TARGET_PATH = os.environ.get("MINI_TARGET_PATH", "/api/upload")

SIM_UI_HOST = os.environ.get("SIM_UI_HOST", "127.0.0.1")
SIM_UI_PORT = int(os.environ.get("SIM_UI_PORT", "5100"))

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "mini_one_node_sim")


def _safe_int(v: str, default: int) -> int:
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _build_target_url(scheme: str, host: str, port: int, path: str) -> str:
    scheme = (scheme or "http").strip().lower()
    if scheme not in ("http", "https"):
        scheme = "http"
    host = (host or "").strip()
    path = (path or "/api/upload").strip() or "/api/upload"
    if not path.startswith("/"):
        path = "/" + path
    port = int(port or 80)
    return f"{scheme}://{host}:{port}{path}"


@app.get("/")
def index():
    return render_template(
        "simulator.html",
        default_node_id=DEFAULT_NODE_ID,
        default_target_host=DEFAULT_TARGET_HOST,
        default_target_port=DEFAULT_TARGET_PORT,
        default_target_path=DEFAULT_TARGET_PATH,
        sim_ui_host=SIM_UI_HOST,
        sim_ui_port=SIM_UI_PORT,
    )


@app.post("/api/send")
def api_send():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "JSON body required"}), 400

    target_url = (payload.get("target_url") or "").strip()
    scheme = (payload.get("scheme") or "http").strip()
    host = (payload.get("host") or "").strip()
    port = _safe_int(payload.get("port"), DEFAULT_TARGET_PORT)
    path = (payload.get("path") or DEFAULT_TARGET_PATH).strip()

    # 允许两种方式：直接给 target_url 或者 host/port/path 组装
    if target_url:
        try:
            u = urlparse(target_url)
            if not u.scheme or not u.netloc:
                return jsonify({"ok": False, "error": "target_url 不是合法 URL"}), 400
        except Exception:
            return jsonify({"ok": False, "error": "target_url 解析失败"}), 400
    else:
        if not host:
            return jsonify({"ok": False, "error": "缺少目标 IP/域名（host）"}), 400
        target_url = _build_target_url(scheme, host, port, path)

    raw_json_text = payload.get("payload_json")
    if not isinstance(raw_json_text, str) or not raw_json_text.strip():
        return jsonify({"ok": False, "error": "payload_json 不能为空"}), 400

    try:
        data_obj = json.loads(raw_json_text)
    except Exception as e:
        return jsonify({"ok": False, "error": f"JSON 解析失败：{e}"}), 400

    t0 = time.time()
    try:
        resp = requests.post(target_url, json=data_obj, timeout=8)
        elapsed_ms = int((time.time() - t0) * 1000)
        return (
            jsonify(
                {
                    "ok": True,
                    "target_url": target_url,
                    "status_code": resp.status_code,
                    "elapsed_ms": elapsed_ms,
                    "response_text": resp.text[:20000],
                }
            ),
            200,
        )
    except Exception as e:
        elapsed_ms = int((time.time() - t0) * 1000)
        return (
            jsonify(
                {
                    "ok": False,
                    "target_url": target_url,
                    "elapsed_ms": elapsed_ms,
                    "error": str(e),
                }
            ),
            502,
        )


if __name__ == "__main__":
    print("=" * 60)
    print("WindSight Mini 手动上报模拟器")
    print(f"打开: http://{SIM_UI_HOST}:{SIM_UI_PORT}")
    print("=" * 60)
    app.run(host=SIM_UI_HOST, port=SIM_UI_PORT, debug=False)
