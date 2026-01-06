"""
WindSight API 路由蓝图

核心目标：
- HTTP POST 上传 32 通道数据 -> 存库
- Web 端按 node_id + 通道筛选，三窗口（电压/电流/转速）曲线回放

说明：
- 本项目已移除“故障诊断/知识图谱/报告生成/故障快照”等复杂链路。
- 终端上报接口默认不要求登录（便于终端直接推送）；管理/设置接口仍要求登录。
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from flask import Blueprint, jsonify, request
from flask_login import login_required

from windsight.models import NodeData, SystemConfig, db
from sqlalchemy import text

api_bp = Blueprint("api", __name__, url_prefix="/api")
logger = logging.getLogger(__name__)

# 回放点数上限（后端硬限制，避免一次拉取过多导致卡顿/内存上升）
# 说明：20000 在 32 通道场景下仍可接受，但若你部署在低配边缘机上，建议降到 10000 或更小。
MAX_HISTORY_LIMIT = 20000

# 全局变量（将从 app.py 传入）
active_nodes = {}  # {node_id: {"timestamp": epoch_seconds, "last_upload_utc": datetime, "last_values": {...}}}
NODE_TIMEOUT = 10  # 秒：用于判定“在线”
db_executor = None  # 预留：后台写库/清理等任务
socketio_instance = None
app_instance = None


def init_api_blueprint(app, socketio, executor, nodes, commands):
    """
    初始化 API 蓝图的全局变量

    说明：
    - commands 参数为旧版本遗留，这里不再使用，但为了保持 app.py 初始化流程不改签名，仍保留入参。
    """
    global active_nodes, db_executor, socketio_instance, app_instance
    active_nodes = nodes
    db_executor = executor
    socketio_instance = socketio
    app_instance = app


def _utcnow() -> datetime:
    return datetime.utcnow()


def _now_ts() -> float:
    return time.time()


def _is_online(node_info: dict, now_ts: float) -> bool:
    try:
        return (now_ts - float(node_info.get("timestamp", 0))) <= NODE_TIMEOUT
    except Exception:
        return False


def _coerce_float_list(arr, expected_len: int = 32) -> list[float] | None:
    """
    将输入数组转换为 float 列表，并校验长度。
    - 返回 None 表示校验失败。
    """
    if not isinstance(arr, list) or len(arr) != expected_len:
        return None
    out: list[float] = []
    for x in arr:
        try:
            out.append(float(x))
        except Exception:
            return None
    return out


def _sqlite_db_path_from_uri(db_uri: str):
    """
    从 SQLAlchemy SQLite URI 中提取数据库文件路径（用于 settings 页显示数据库大小）。
    支持：
    - sqlite:///relative/path.db
    - sqlite:////absolute/path.db
    """
    if not isinstance(db_uri, str) or not db_uri.startswith("sqlite:///"):
        return None
    raw = db_uri[len("sqlite:///") :]
    if not raw:
        return None
    try:
        return Path(raw)
    except Exception:
        return None


def _resolve_sqlite_path(sqlite_path: Path | None) -> Path | None:
    """将相对 SQLite 路径解析为项目绝对路径（与 system_info 的展示保持一致）"""
    if sqlite_path is None:
        return None
    try:
        if not sqlite_path.is_absolute():
            project_root = Path(__file__).resolve().parents[1].parent
            sqlite_path = (project_root / sqlite_path).resolve()
        return sqlite_path
    except Exception:
        return None


def _sqlite_file_sizes_mb(sqlite_path: Path | None) -> dict:
    """返回 SQLite 主库文件及 WAL/SHM 文件大小（MB）"""
    out = {"db_mb": 0.0, "wal_mb": 0.0, "shm_mb": 0.0}
    if sqlite_path is None:
        return out
    try:
        if sqlite_path.exists():
            out["db_mb"] = round(sqlite_path.stat().st_size / (1024 * 1024), 2)
    except Exception:
        pass
    try:
        wal = Path(str(sqlite_path) + "-wal")
        if wal.exists():
            out["wal_mb"] = round(wal.stat().st_size / (1024 * 1024), 2)
    except Exception:
        pass
    try:
        shm = Path(str(sqlite_path) + "-shm")
        if shm.exists():
            out["shm_mb"] = round(shm.stat().st_size / (1024 * 1024), 2)
    except Exception:
        pass
    return out


# ==================== 核心接口：终端数据上报 ====================
@api_bp.route("/upload", methods=["POST"])
def upload_node_data():
    """
    终端数据上报（WindSight 新协议）

    期望 JSON：
    {
      "node_id": "device_01",
      "voltages": [..32..],
      "currents": [..32..],
      "speeds": [..32..]
    }
    """
    try:
        payload = request.get_json(silent=True) or {}
        node_id = (payload.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"success": False, "error": "缺少 node_id"}), 400

        voltages = _coerce_float_list(payload.get("voltages"), 32)
        currents = _coerce_float_list(payload.get("currents"), 32)
        speeds = _coerce_float_list(payload.get("speeds"), 32)
        if voltages is None or currents is None or speeds is None:
            return (
                jsonify(
                    {
                        "success": False,
                        "error": "数据格式错误：voltages/currents/speeds 必须是长度为 32 的数组，且元素可转为数字",
                    }
                ),
                400,
            )

        # 1) 入库（UTC）
        row = NodeData(
            node_id=node_id,
            timestamp=_utcnow(),
            voltage_data=json.dumps(voltages, ensure_ascii=False),
            current_data=json.dumps(currents, ensure_ascii=False),
            speed_data=json.dumps(speeds, ensure_ascii=False),
        )
        db.session.add(row)
        db.session.commit()

        # 2) 更新内存在线状态（用于 Dashboard/侧边栏）
        now_ts = _now_ts()
        active_nodes[node_id] = {
            "timestamp": now_ts,
            "last_upload_utc": row.timestamp,
            # 仅存“最后一帧”的轻量值，避免内存暴涨
            "last_values": {"v0": voltages[0], "c0": currents[0], "s0": speeds[0]},
        }

        # 3) 可选：WebSocket 广播给订阅者（房间：node_<node_id>）
        try:
            if socketio_instance:
                # 兼容：历史代码/前端通常监听 monitor_update
                # - node_data_update：WindSight 新事件名
                # - monitor_update：兼容旧约定（socket_events.py 订阅逻辑也使用该事件名）
                socketio_instance.emit(
                    "node_data_update",
                    {"node_id": node_id, "data": row.to_dict()},
                    room=f"node_{node_id}",
                    namespace="/",
                )
                socketio_instance.emit(
                    "monitor_update",
                    {"node_id": node_id, "data": row.to_dict(), "is_initial": False},
                    room=f"node_{node_id}",
                    namespace="/",
                )
                socketio_instance.emit(
                    "node_status_update",
                    {"node_id": node_id, "online": True, "timestamp": now_ts},
                    namespace="/",
                )
        except Exception:
            # 广播失败不影响接口返回
            pass

        # 按最终需求：必须返回 {"status": "success"}
        # 兼容调试：额外带上 id 不影响前端解析
        return jsonify({"status": "success", "id": row.id}), 200
    except Exception as e:
        db.session.rollback()
        logger.exception(f"[/api/upload] 处理失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# ==================== 节点与历史数据查询（给前端回放）====================
@api_bp.route("/nodes", methods=["GET"])
@login_required
def list_nodes():
    """返回节点列表（包含在线状态与最后上报时间）"""
    try:
        now_ts = _now_ts()

        # 1) DB 中出现过的节点
        rows = (
            db.session.query(NodeData.node_id, db.func.max(NodeData.timestamp))
            .group_by(NodeData.node_id)
            .all()
        )
        db_last = {node_id: ts for node_id, ts in rows}

        # 2) union active_nodes（避免 DB 为空时下拉框无数据）
        all_ids = set(db_last.keys()) | set(active_nodes.keys())

        from windsight.time_utils import iso_beijing

        items: list[dict] = []
        for node_id in sorted(all_ids):
            info = active_nodes.get(node_id) or {}
            online = _is_online(info, now_ts)
            last_utc = info.get("last_upload_utc") or db_last.get(node_id)
            items.append(
                {
                    "node_id": node_id,
                    "online": bool(online),
                    "last_upload": iso_beijing(last_utc) if last_utc else None,
                }
            )

        return jsonify({"success": True, "nodes": items}), 200
    except Exception as e:
        logger.exception(f"[/api/nodes] 失败: {e}")
        return jsonify({"success": False, "nodes": [], "error": str(e)}), 500


@api_bp.route("/node_data", methods=["GET"])
@login_required
def get_node_data():
    """
    查询某节点的历史数据（用于曲线回放）

    Query:
    - node_id: 必填
    - limit: 默认 600（最多 20000）
    - start: 可选，起始时间（支持 ISO / datetime-local）
    - end: 可选，结束时间（支持 ISO / datetime-local）
    """
    try:
        node_id = (request.args.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"success": False, "error": "缺少 node_id"}), 400

        limit = int(request.args.get("limit", 600))
        limit = max(1, min(limit, MAX_HISTORY_LIMIT))

        # 时间范围筛选（可选）
        from windsight.time_utils import parse_client_datetime_to_utc

        start_raw = request.args.get("start") or request.args.get("start_time")
        end_raw = request.args.get("end") or request.args.get("end_time")
        start_utc = parse_client_datetime_to_utc(start_raw)
        end_utc = parse_client_datetime_to_utc(end_raw)
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"success": False, "error": "时间范围错误：开始时间不能晚于结束时间"}), 400

        q = NodeData.query.filter_by(node_id=node_id)
        if start_utc:
            q = q.filter(NodeData.timestamp >= start_utc)
        if end_utc:
            q = q.filter(NodeData.timestamp <= end_utc)

        # 语义说明（按你的反馈修正）：
        # - 只要传了 start：从开始时间起“向后”取 N 条（end 作为可选上限边界）
        # - 未传 start：保持旧行为，取“最近” N 条（若传了 end，则是在 end 之前取最近 N 条）
        if start_utc:
            rows = q.order_by(NodeData.timestamp.asc()).limit(limit).all()
        else:
            rows = q.order_by(NodeData.timestamp.desc()).limit(limit).all()
            # 前端按时间轴绘制：需要升序
            rows.reverse()
        return jsonify({"success": True, "node_id": node_id, "data": [r.to_dict() for r in rows]}), 200
    except Exception as e:
        logger.exception(f"[/api/node_data] 失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# ==================== 最终需求接口：/api/data（用于前端轮询绘图）====================
@api_bp.route("/data", methods=["GET"])
@login_required
def get_data():
    """
    最终需求接口：查询最近的数据用于前端绘图

    Query:
    - node_id: 必填
    - limit: 默认 600（最多 20000）
    - start: 可选，起始时间（支持 ISO / datetime-local）
    - end: 可选，结束时间（支持 ISO / datetime-local）

    返回：
    {
      "status": "success",
      "node_id": "...",
      "data": [ {timestamp, voltages, currents, speeds}, ... ]
    }
    """
    try:
        node_id = (request.args.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"status": "error", "error": "缺少 node_id"}), 400

        limit = int(request.args.get("limit", 600))
        limit = max(1, min(limit, MAX_HISTORY_LIMIT))

        from windsight.time_utils import parse_client_datetime_to_utc

        start_raw = request.args.get("start") or request.args.get("start_time")
        end_raw = request.args.get("end") or request.args.get("end_time")
        start_utc = parse_client_datetime_to_utc(start_raw)
        end_utc = parse_client_datetime_to_utc(end_raw)
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"status": "error", "error": "时间范围错误：开始时间不能晚于结束时间"}), 400

        q = NodeData.query.filter_by(node_id=node_id)
        if start_utc:
            q = q.filter(NodeData.timestamp >= start_utc)
        if end_utc:
            q = q.filter(NodeData.timestamp <= end_utc)
        # 语义说明（按你的反馈修正）：
        # - 只要传了 start：从开始时间起“向后”取 N 条（end 作为可选上限边界）
        # - 未传 start：保持旧行为，取“最近” N 条（若传了 end，则是在 end 之前取最近 N 条）
        if start_utc:
            rows = q.order_by(NodeData.timestamp.asc()).limit(limit).all()
        else:
            rows = q.order_by(NodeData.timestamp.desc()).limit(limit).all()
            rows.reverse()
        return jsonify({"status": "success", "node_id": node_id, "data": [r.to_dict() for r in rows]}), 200
    except Exception as e:
        logger.exception(f"[/api/data] 失败: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500


# ==================== 回放辅助接口：/api/data_meta（用于前端计算 end/limit）====================
@api_bp.route("/data_meta", methods=["GET"])
@login_required
def data_meta():
    """
    回放辅助接口：用于“点数/时段联动”的快速计算（不返回完整数据，避免大流量）。

    Query:
    - node_id: 必填
    - mode: 'nth' | 'count'
      - nth: 计算“从 start 开始向后第 N 条数据的时间戳”（用于自动推算 end）
        - start: 必填
        - limit: 必填（N）
        - end: 可选（上限边界）
      - count: 计算“start~end 范围内共有多少条数据”（用于自动推算 limit）
        - start: 必填
        - end: 必填
    """
    try:
        node_id = (request.args.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"status": "error", "error": "缺少 node_id"}), 400

        mode = (request.args.get("mode") or "").strip().lower()
        if mode not in ("nth", "count"):
            return jsonify({"status": "error", "error": "缺少/错误的 mode（应为 nth 或 count）"}), 400

        from windsight.time_utils import parse_client_datetime_to_utc, iso_beijing

        start_raw = request.args.get("start") or request.args.get("start_time")
        end_raw = request.args.get("end") or request.args.get("end_time")
        start_utc = parse_client_datetime_to_utc(start_raw)
        end_utc = parse_client_datetime_to_utc(end_raw)
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"status": "error", "error": "时间范围错误：开始时间不能晚于结束时间"}), 400

        q = NodeData.query.filter_by(node_id=node_id)
        if start_utc:
            q = q.filter(NodeData.timestamp >= start_utc)
        if end_utc:
            q = q.filter(NodeData.timestamp <= end_utc)

        # 统计范围内总条数（count 模式一定需要；nth 模式也用于提示“是否足够”）
        total = db.session.query(db.func.count(NodeData.id)).filter(NodeData.node_id == node_id)
        if start_utc:
            total = total.filter(NodeData.timestamp >= start_utc)
        if end_utc:
            total = total.filter(NodeData.timestamp <= end_utc)
        total_count = int(total.scalar() or 0)

        if mode == "count":
            if not start_utc or not end_utc:
                return jsonify({"status": "error", "error": "count 模式需要 start 与 end"}), 400
            return jsonify(
                {
                    "status": "success",
                    "node_id": node_id,
                    "mode": "count",
                    "count": total_count,
                    "start": iso_beijing(start_utc, with_seconds=True, with_ms=True),
                    "end": iso_beijing(end_utc, with_seconds=True, with_ms=True),
                }
            ), 200

        # mode == 'nth'
        if not start_utc:
            return jsonify({"status": "error", "error": "nth 模式需要 start"}), 400

        n = int(request.args.get("limit", 0) or 0)
        n = max(1, min(n, MAX_HISTORY_LIMIT))

        # 取第 N 条（升序 offset N-1），不拉全量
        nth_row = q.order_by(NodeData.timestamp.asc()).offset(n - 1).limit(1).first()
        nth_ts = nth_row.timestamp if nth_row else None

        # 若不足 N 条，则返回范围内最后一条（便于前端把 end 推到“可用最大值”）
        last_row = None
        if total_count > 0:
            last_row = q.order_by(NodeData.timestamp.desc()).limit(1).first()
        last_ts = last_row.timestamp if last_row else None

        return jsonify(
            {
                "status": "success",
                "node_id": node_id,
                "mode": "nth",
                "requested": int(n),
                "count": int(total_count),
                "nth_ts": iso_beijing(nth_ts, with_seconds=True, with_ms=True) if nth_ts else None,
                "last_ts": iso_beijing(last_ts, with_seconds=True, with_ms=True) if last_ts else None,
            }
        ), 200
    except Exception as e:
        logger.exception(f"[/api/data_meta] 失败: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500


# ==================== 兼容：Dashboard/侧边栏统计（保持旧壳子可用）====================
@api_bp.route("/dashboard/stats", methods=["GET"])
@login_required
def dashboard_stats():
    """返回侧边栏/概览页需要的统计数据（已按 WindSight 语义重定义）"""
    try:
        now_ts = _now_ts()
        online_ids = [nid for nid, info in list(active_nodes.items()) if _is_online(info, now_ts)]

        # 节点统计：DB 中出现过的节点 + 当前内存 active_nodes（取并集）
        rows = db.session.query(NodeData.node_id).distinct().all()
        db_ids = {r[0] for r in rows if r and r[0]}
        all_ids = db_ids | set(active_nodes.keys())

        total_nodes = len(all_ids)
        online_nodes = len(online_ids)

        # 数据统计：总记录、近24小时记录、最近上报时间
        utc_now = _utcnow()
        since_24h = utc_now - timedelta(hours=24)
        total_records = db.session.query(db.func.count(NodeData.id)).scalar() or 0
        records_24h = (
            db.session.query(db.func.count(NodeData.id))
            .filter(NodeData.timestamp >= since_24h)
            .scalar()
            or 0
        )
        latest_ts = db.session.query(db.func.max(NodeData.timestamp)).scalar()

        from windsight.time_utils import iso_beijing

        # 数据库大小（SQLite）
        db_uri = (app_instance.config.get("SQLALCHEMY_DATABASE_URI") if app_instance else "") or ""
        db_size_mb = 0.0
        sqlite_path = _resolve_sqlite_path(_sqlite_db_path_from_uri(db_uri))
        if sqlite_path is not None and sqlite_path.exists():
            db_size_mb = round(sqlite_path.stat().st_size / (1024 * 1024), 2)

        return (
            jsonify(
                {
                    "total_nodes": int(total_nodes),
                    "online_nodes": int(online_nodes),
                    "total_records": int(total_records),
                    "records_24h": int(records_24h),
                    "latest_upload": iso_beijing(latest_ts) if latest_ts else None,
                    "database_size_mb": float(db_size_mb),
                    "node_timeout_sec": int(NODE_TIMEOUT),
                }
            ),
            200,
        )
    except Exception as e:
        logger.exception(f"[/api/dashboard/stats] 失败: {e}")
        return jsonify({"total_nodes": 0, "online_nodes": 0, "error": str(e)}), 500


@api_bp.route("/get_active_nodes", methods=["GET"])
@login_required
def get_active_nodes():
    """兼容旧前端：返回当前在线节点列表（轻量）"""
    try:
        now_ts = _now_ts()
        from windsight.time_utils import iso_beijing

        nodes = []
        for node_id, info in list(active_nodes.items()):
            if not _is_online(info, now_ts):
                continue
            last_utc = info.get("last_upload_utc")
            nodes.append(
                {
                    "node_id": node_id,
                    "status": "online",
                    "last_upload": iso_beijing(last_utc) if last_utc else None,
                }
            )
        return jsonify({"success": True, "nodes": nodes, "count": len(nodes)}), 200
    except Exception as e:
        logger.exception(f"[/api/get_active_nodes] 失败: {e}")
        return jsonify({"success": False, "nodes": [], "error": str(e)}), 500


@api_bp.route("/devices", methods=["GET"])
@login_required
def devices_compat():
    """兼容旧页面：返回 devices 字段（实际为 nodes）"""
    try:
        now_ts = _now_ts()
        from windsight.time_utils import iso_beijing

        # 只返回 DB 中出现过的节点（避免 active_nodes 只是短期在线时造成误解）
        rows = (
            db.session.query(NodeData.node_id, db.func.max(NodeData.timestamp))
            .group_by(NodeData.node_id)
            .all()
        )

        devices = []
        for node_id, last_ts in rows:
            info = active_nodes.get(node_id) or {}
            online = _is_online(info, now_ts)
            devices.append(
                {
                    "device_id": node_id,
                    "location": node_id,
                    "status": "online" if online else "offline",
                    "last_heartbeat": iso_beijing(last_ts) if last_ts else None,
                }
            )

        return jsonify({"success": True, "devices": devices}), 200
    except Exception as e:
        logger.exception(f"[/api/devices] 失败: {e}")
        return jsonify({"success": False, "devices": [], "error": str(e)}), 500


# ==================== 系统设置（保留）====================
@api_bp.route("/admin/system_info", methods=["GET"])
@login_required
def admin_system_info():
    """系统信息（供设置页展示）"""
    try:
        version = os.environ.get("WINDSIGHT_VERSION", "v1.0.0")
        async_mode = getattr(socketio_instance, "async_mode", None) if socketio_instance else None

        # 数据库大小（仅对 SQLite 计算）
        db_uri = (app_instance.config.get("SQLALCHEMY_DATABASE_URI") if app_instance else "") or ""
        db_size_mb = 0.0
        sqlite_path = _resolve_sqlite_path(_sqlite_db_path_from_uri(db_uri))
        sizes = _sqlite_file_sizes_mb(sqlite_path)
        db_size_mb = float(sizes.get("db_mb") or 0.0)

        # 节点/数据统计
        now_ts = _now_ts()
        online_count = len([nid for nid, info in list(active_nodes.items()) if _is_online(info, now_ts)])
        total_nodes = db.session.query(db.func.count(db.distinct(NodeData.node_id))).scalar() or 0
        total_rows = db.session.query(db.func.count(NodeData.id)).scalar() or 0

        return jsonify(
            {
                "success": True,
                "data": {
                    "version": version,
                    "database_size_mb": db_size_mb,
                    "database_wal_mb": float(sizes.get("wal_mb") or 0.0),
                    "database_shm_mb": float(sizes.get("shm_mb") or 0.0),
                    "database_uri": "sqlite" if str(db_uri).startswith("sqlite") else "other",
                    "active_nodes": int(online_count),
                    "total_nodes": int(total_nodes),
                    "total_records": int(total_rows),
                    "async_mode": async_mode or os.environ.get("FORCE_ASYNC_MODE", "auto"),
                    "python_version": sys.version.split()[0],
                },
            }
        ), 200
    except Exception as e:
        logger.exception(f"[/api/admin/system_info] 失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/admin/config", methods=["GET", "POST"])
@login_required
def admin_config():
    """
    设置页配置读写接口
    - GET：返回 {success: true, data: {...}}
    - POST：写入 SystemConfig
    """
    try:
        keys = [
            "poll_interval",
            "auto_refresh",
            "show_debug_log",
            "log_retention",
        ]

        if request.method == "GET":
            data = {}
            for k in keys:
                row = SystemConfig.query.filter_by(key=k).first()
                if row and row.value is not None:
                    try:
                        data[k] = json.loads(row.value)
                    except Exception:
                        data[k] = row.value
            return jsonify({"success": True, "data": data}), 200

        payload = request.get_json(silent=True) or {}
        for k in keys:
            if k not in payload:
                continue
            v = payload.get(k)
            row = SystemConfig.query.filter_by(key=k).first()
            if row:
                row.value = json.dumps(v, ensure_ascii=False)
                row.updated_at = _utcnow()
            else:
                row = SystemConfig(key=k, value=json.dumps(v, ensure_ascii=False), description="系统设置")
                db.session.add(row)

        db.session.commit()
        return jsonify({"success": True, "message": "配置已保存"}), 200
    except Exception as e:
        db.session.rollback()
        logger.exception(f"[/api/admin/config] 失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/admin/cleanup_old_data", methods=["POST"])
@login_required
def admin_cleanup_old_data():
    """按保留天数清理历史数据（仅 NodeData）"""
    try:
        payload = request.get_json(silent=True) or {}
        retention_days = int(payload.get("retention_days", 30))
        if retention_days <= 0:
            return jsonify({"success": False, "error": "retention_days 必须大于 0"}), 400

        cutoff = _utcnow() - timedelta(days=retention_days)
        deleted = NodeData.query.filter(NodeData.timestamp < cutoff).delete(synchronize_session=False)
        db.session.commit()
        return jsonify({"success": True, "details": {"node_data_deleted": int(deleted or 0)}}), 200
    except Exception as e:
        db.session.rollback()
        logger.exception(f"[/api/admin/cleanup_old_data] 失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/admin/clear_all_data", methods=["POST"])
@login_required
def admin_clear_all_data():
    """清空所有采集数据（仅 NodeData，高危）"""
    try:
        deleted = NodeData.query.delete(synchronize_session=False)
        db.session.commit()
        return jsonify({"success": True, "details": {"node_data_deleted": int(deleted or 0)}}), 200
    except Exception as e:
        db.session.rollback()
        logger.exception(f"[/api/admin/clear_all_data] 失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/admin/delete_node_data", methods=["POST"])
@login_required
def admin_delete_node_data():
    """
    按节点删除采集数据（仅 NodeData）

    说明：
    - 仅删除指定 node_id 在 node_data 表中的历史记录
    - 不会删除用户/配置等其他表
    - 会尝试从 active_nodes 缓存中移除该 node_id（避免“删除后列表仍显示空节点”的困惑）
    """
    try:
        payload = request.get_json(silent=True) or {}
        node_id = (payload.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"success": False, "error": "缺少 node_id"}), 400

        # 统计 + 删除
        deleted = (
            NodeData.query.filter(NodeData.node_id == node_id)
            .delete(synchronize_session=False)
        )
        db.session.commit()

        # 从内存在线缓存移除（可选）
        try:
            active_nodes.pop(node_id, None)
        except Exception:
            pass

        return jsonify({"success": True, "details": {"node_id": node_id, "node_data_deleted": int(deleted or 0)}}), 200
    except Exception as e:
        db.session.rollback()
        logger.exception(f"[/api/admin/delete_node_data] 失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/admin/reset_data", methods=["POST"])
@login_required
def admin_reset_data_alias():
    """
    兼容旧设置页：/api/admin/reset_data
    实际行为等同于 clear_all_data（仅清空 NodeData）。
    """
    return admin_clear_all_data()


@api_bp.route("/admin/vacuum", methods=["POST"])
@login_required
def admin_vacuum():
    """
    SQLite 数据库压缩（VACUUM）

    重要说明（为什么要单独做）：SQLite 的 DELETE 只会把空间标记为可复用（freelist），不会自动缩小 .db 文件；
    只有执行 VACUUM（重建数据库文件）后，磁盘占用才会真实下降。
    """
    try:
        # 仅对 SQLite 生效
        db_uri = (app_instance.config.get("SQLALCHEMY_DATABASE_URI") if app_instance else "") or ""
        if not str(db_uri).startswith("sqlite"):
            return jsonify({"success": False, "error": "当前数据库不是 SQLite，无法执行 VACUUM"}), 400

        sqlite_path = _resolve_sqlite_path(_sqlite_db_path_from_uri(db_uri))
        before = _sqlite_file_sizes_mb(sqlite_path)

        # VACUUM 不能在事务内执行：先确保 session 已提交
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()

        # 使用 AUTOCOMMIT 执行 PRAGMA / VACUUM，避免 “cannot VACUUM from within a transaction”
        with db.engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            # 若启用了 WAL，先做一次 checkpoint + truncate，避免 .db-wal 长期占用磁盘
            try:
                conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
            except Exception:
                pass
            conn.execute(text("VACUUM"))
            try:
                conn.execute(text("PRAGMA optimize"))
            except Exception:
                pass

        after = _sqlite_file_sizes_mb(sqlite_path)
        return (
            jsonify(
                {
                    "success": True,
                    "message": "数据库压缩完成（VACUUM）",
                    "details": {
                        "before": before,
                        "after": after,
                    },
                }
            ),
            200,
        )
    except Exception as e:
        logger.exception(f"[/api/admin/vacuum] 失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


