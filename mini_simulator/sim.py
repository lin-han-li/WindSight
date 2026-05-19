from __future__ import annotations

import json
import os
import sys
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
DEFAULT_TARGET_PORT = int(os.environ.get("MINI_TARGET_PORT", "8080"))
DEFAULT_TARGET_PATH = os.environ.get("MINI_TARGET_PATH", "/api/upload")

SIM_UI_HOST = os.environ.get("SIM_UI_HOST", "127.0.0.1")
SIM_UI_PORT = int(os.environ.get("SIM_UI_PORT", "5100"))


def _resource_path(relative_path: str) -> str:
    base_path = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_path, relative_path)


app = Flask(
    __name__,
    template_folder=_resource_path("templates"),
    static_folder=_resource_path("static"),
)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "mini_simulator")


def _safe_int(v: str, default: int) -> int:
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _safe_port(v: str | int, default: int = DEFAULT_TARGET_PORT) -> int:
    value = _safe_int(v, default)
    return max(1, min(65535, value))


def _build_target_url(scheme: str, host: str, port: int, path: str) -> str:
    scheme = (scheme or "http").strip().lower()
    host = (host or "").strip()
    path = (path or "/api/upload").strip() or "/api/upload"
    if not path.startswith("/"):
        path = "/" + path
    port = _safe_port(port)
    return f"{scheme}://{host}:{port}{path}"


def _parse_response_json(response: requests.Response):
    content_type = (response.headers.get("content-type") or "").lower()
    if "json" not in content_type and not response.text.lstrip().startswith(("{", "[")):
        return None
    try:
        return response.json()
    except Exception:
        return None


def _error_hint(status_code: int | None, error: str = "") -> str:
    if status_code in (401, 403):
        return "权限失败：请确认节点已注册，并填写正确的 X-WindSight-Node-Key。"
    if status_code == 400:
        return "请求格式失败：请检查 node_id、sub、001..NNN 风机键和四指标数组。"
    if status_code and status_code >= 500:
        return "目标服务异常：请检查 WindSight 后端日志。"
    if error:
        return f"连接失败：{error}"
    return "发送失败：请检查目标地址、端口、路径和 payload。"


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


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True, "service": "windsight-mini-simulator", "pid": os.getpid()})


@app.post("/api/send")
def api_send():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "JSON body required"}), 400

    target_url = (payload.get("target_url") or "").strip()
    scheme = (payload.get("scheme") or "http").strip().lower()
    host = (payload.get("host") or "").strip()
    port = _safe_port(payload.get("port"), DEFAULT_TARGET_PORT)
    path = (payload.get("path") or DEFAULT_TARGET_PATH).strip()
    node_key = (payload.get("node_key") or "").strip()

    # 允许两种方式：直接给 target_url 或者 host/port/path 组装
    if target_url:
        try:
            u = urlparse(target_url)
            if u.scheme not in ("http", "https") or not u.netloc:
                return jsonify({"ok": False, "error": "target_url 不是合法 URL"}), 400
            if u.port is not None and (u.port < 1 or u.port > 65535):
                return jsonify({"ok": False, "error": "target_url 端口必须在 1..65535"}), 400
        except Exception:
            return jsonify({"ok": False, "error": "target_url 解析失败"}), 400
    else:
        if not host:
            return jsonify({"ok": False, "error": "缺少目标 IP/域名（host）"}), 400
        if scheme not in ("http", "https"):
            return jsonify({"ok": False, "error": "scheme must be http or https"}), 400
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
        headers = {"X-WindSight-Node-Key": node_key} if node_key else {}
        resp = requests.post(target_url, json=data_obj, headers=headers, timeout=8)
        elapsed_ms = int((time.time() - t0) * 1000)
        response_json = _parse_response_json(resp)
        ok = 200 <= resp.status_code < 300
        return (
            jsonify(
                {
                    "ok": ok,
                    "target_url": target_url,
                    "status_code": resp.status_code,
                    "elapsed_ms": elapsed_ms,
                    "response_text": resp.text[:20000],
                    "response_json": response_json,
                    "error_hint": None if ok else _error_hint(resp.status_code),
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
                    "error_hint": _error_hint(None, str(e)),
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

