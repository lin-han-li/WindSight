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
from sqlalchemy import text
from sqlalchemy.orm import selectinload

from windsight.models import NodeUpload, SystemConfig, TurbineMeasurement, db
from windsight.protocol import ProtocolValidationError, parse_turbine_upload
from windsight.time_utils import iso_beijing, parse_client_datetime_to_utc

api_bp = Blueprint("api", __name__, url_prefix="/api")
logger = logging.getLogger(__name__)

MAX_HISTORY_LIMIT = 20000
active_nodes = {}
NODE_TIMEOUT = 10
db_executor = None
socketio_instance = None
app_instance = None


def init_api_blueprint(app, socketio, executor, nodes, commands):
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


def _sqlite_db_path_from_uri(db_uri: str):
    if not isinstance(db_uri, str) or not db_uri.startswith("sqlite:///"):
        return None
    raw = db_uri[len("sqlite:///") :]
    return Path(raw) if raw else None


def _resolve_sqlite_path(sqlite_path: Path | None) -> Path | None:
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


def _load_latest_upload(node_id: str):
    return (
        NodeUpload.query.options(selectinload(NodeUpload.measurements))
        .filter_by(node_id=node_id)
        .order_by(NodeUpload.timestamp.desc(), NodeUpload.id.desc())
        .first()
    )


def _build_node_item(node_id: str, latest_upload, now_ts: float):
    info = active_nodes.get(node_id) or {}
    online = _is_online(info, now_ts)
    last_utc = info.get("last_upload_utc") or (latest_upload.timestamp if latest_upload else None)
    turbine_codes = info.get("turbines") or (latest_upload.turbine_codes() if latest_upload else [])
    turbine_count = info.get("turbine_count") or (latest_upload.turbine_count if latest_upload else 0)
    return {
        "node_id": node_id,
        "online": bool(online),
        "last_upload": iso_beijing(last_utc) if last_utc else None,
        "turbine_count": int(turbine_count or 0),
        "turbines": turbine_codes,
    }


def _base_upload_query(node_id: str):
    return NodeUpload.query.options(selectinload(NodeUpload.measurements)).filter_by(node_id=node_id)


def _apply_time_filters(query, start_utc, end_utc):
    if start_utc:
        query = query.filter(NodeUpload.timestamp >= start_utc)
    if end_utc:
        query = query.filter(NodeUpload.timestamp <= end_utc)
    return query


def _get_filtered_rows(node_id: str, limit: int, start_utc, end_utc):
    query = _apply_time_filters(_base_upload_query(node_id), start_utc, end_utc)
    if start_utc:
        return query.order_by(NodeUpload.timestamp.asc(), NodeUpload.id.asc()).limit(limit).all()
    rows = query.order_by(NodeUpload.timestamp.desc(), NodeUpload.id.desc()).limit(limit).all()
    rows.reverse()
    return rows


def _update_active_node_cache(node_id: str, upload_row):
    turbine_codes = upload_row.turbine_codes()
    first_code = turbine_codes[0] if turbine_codes else None
    active_nodes[node_id] = {
        "timestamp": _now_ts(),
        "last_upload_utc": upload_row.timestamp,
        "turbine_count": upload_row.turbine_count,
        "turbines": turbine_codes,
        "last_values": upload_row.turbines_dict().get(first_code) if first_code else {},
    }


def _emit_upload_events(node_id: str, upload_row):
    if not socketio_instance:
        return

    row_data = upload_row.to_row_dict()
    now_ts = _now_ts()
    socketio_instance.emit(
        "node_data_update",
        {"node_id": node_id, "data": row_data},
        room=f"node_{node_id}",
        namespace="/",
    )
    socketio_instance.emit(
        "monitor_update",
        {"node_id": node_id, "data": row_data, "is_initial": False},
        room=f"node_{node_id}",
        namespace="/",
    )
    socketio_instance.emit(
        "node_status_update",
        {
            "node_id": node_id,
            "online": True,
            "timestamp": now_ts,
            "turbine_count": upload_row.turbine_count,
        },
        namespace="/",
    )


@api_bp.route("/upload", methods=["POST"])
def upload_node_data():
    payload = request.get_json(silent=True)
    try:
        parsed = parse_turbine_upload(payload)
    except ProtocolValidationError as exc:
        return jsonify({"status": "error", "error": str(exc)}), 400

    timestamp = _utcnow()
    try:
        row = NodeUpload(
            node_id=parsed.node_id,
            turbine_count=parsed.turbine_count,
            timestamp=timestamp,
            raw_payload=json.dumps(payload, ensure_ascii=False),
        )
        for index, code in enumerate(parsed.turbine_codes(), start=1):
            sample = parsed.turbines[code]
            row.measurements.append(
                TurbineMeasurement(
                    node_id=parsed.node_id,
                    turbine_code=code,
                    turbine_index=index,
                    timestamp=timestamp,
                    voltage=sample.voltage,
                    current=sample.current,
                    speed=sample.speed,
                    temperature=sample.temperature,
                )
            )

        db.session.add(row)
        db.session.commit()

        _update_active_node_cache(parsed.node_id, row)
        _emit_upload_events(parsed.node_id, row)
        return jsonify({"status": "success", "upload_id": row.id}), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/upload] failed: %s", exc)
        return jsonify({"status": "error", "error": str(exc)}), 500


@api_bp.route("/nodes", methods=["GET"])
def list_nodes():
    try:
        now_ts = _now_ts()
        db_node_ids = [row[0] for row in db.session.query(NodeUpload.node_id).distinct().all()]
        all_ids = sorted(set(db_node_ids) | set(active_nodes.keys()))
        items = []
        for node_id in all_ids:
            latest_upload = _load_latest_upload(node_id)
            items.append(_build_node_item(node_id, latest_upload, now_ts))
        return jsonify({"success": True, "nodes": items}), 200
    except Exception as exc:
        logger.exception("[/api/nodes] failed: %s", exc)
        return jsonify({"success": False, "nodes": [], "error": str(exc)}), 500


@api_bp.route("/node_data", methods=["GET"])
@login_required
def get_node_data():
    try:
        node_id = (request.args.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"success": False, "error": "missing node_id"}), 400

        limit = max(1, min(int(request.args.get("limit", 600)), MAX_HISTORY_LIMIT))
        start_utc = parse_client_datetime_to_utc(request.args.get("start") or request.args.get("start_time"))
        end_utc = parse_client_datetime_to_utc(request.args.get("end") or request.args.get("end_time"))
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"success": False, "error": "invalid time range"}), 400

        rows = _get_filtered_rows(node_id, limit, start_utc, end_utc)
        return jsonify({"success": True, "node_id": node_id, "data": [row.to_row_dict() for row in rows]}), 200
    except Exception as exc:
        logger.exception("[/api/node_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/data", methods=["GET"])
@login_required
def get_data():
    try:
        node_id = (request.args.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"status": "error", "error": "missing node_id"}), 400

        limit = max(1, min(int(request.args.get("limit", 600)), MAX_HISTORY_LIMIT))
        start_utc = parse_client_datetime_to_utc(request.args.get("start") or request.args.get("start_time"))
        end_utc = parse_client_datetime_to_utc(request.args.get("end") or request.args.get("end_time"))
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"status": "error", "error": "invalid time range"}), 400

        rows = _get_filtered_rows(node_id, limit, start_utc, end_utc)
        return jsonify({"status": "success", "node_id": node_id, "data": [row.to_row_dict() for row in rows]}), 200
    except Exception as exc:
        logger.exception("[/api/data] failed: %s", exc)
        return jsonify({"status": "error", "error": str(exc)}), 500


@api_bp.route("/data_meta", methods=["GET"])
@login_required
def data_meta():
    try:
        node_id = (request.args.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"status": "error", "error": "missing node_id"}), 400

        mode = (request.args.get("mode") or "").strip().lower()
        if mode not in ("nth", "count"):
            return jsonify({"status": "error", "error": "mode must be nth or count"}), 400

        start_utc = parse_client_datetime_to_utc(request.args.get("start") or request.args.get("start_time"))
        end_utc = parse_client_datetime_to_utc(request.args.get("end") or request.args.get("end_time"))
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"status": "error", "error": "invalid time range"}), 400

        query = _apply_time_filters(NodeUpload.query.filter_by(node_id=node_id), start_utc, end_utc)
        total_count = int(query.count())

        if mode == "count":
            if not start_utc or not end_utc:
                return jsonify({"status": "error", "error": "count mode requires start and end"}), 400
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

        if not start_utc:
            return jsonify({"status": "error", "error": "nth mode requires start"}), 400

        requested = max(1, min(int(request.args.get("limit", 0) or 0), MAX_HISTORY_LIMIT))
        nth_row = query.order_by(NodeUpload.timestamp.asc(), NodeUpload.id.asc()).offset(requested - 1).limit(1).first()
        last_row = query.order_by(NodeUpload.timestamp.desc(), NodeUpload.id.desc()).first() if total_count > 0 else None
        return jsonify(
            {
                "status": "success",
                "node_id": node_id,
                "mode": "nth",
                "requested": requested,
                "count": total_count,
                "nth_ts": iso_beijing(nth_row.timestamp, with_seconds=True, with_ms=True) if nth_row else None,
                "last_ts": iso_beijing(last_row.timestamp, with_seconds=True, with_ms=True) if last_row else None,
            }
        ), 200
    except Exception as exc:
        logger.exception("[/api/data_meta] failed: %s", exc)
        return jsonify({"status": "error", "error": str(exc)}), 500


@api_bp.route("/dashboard/stats", methods=["GET"])
@login_required
def dashboard_stats():
    try:
        now_ts = _now_ts()
        online_ids = [node_id for node_id, info in list(active_nodes.items()) if _is_online(info, now_ts)]
        db_ids = {row[0] for row in db.session.query(NodeUpload.node_id).distinct().all()}
        all_ids = db_ids | set(active_nodes.keys())
        latest_ts = db.session.query(db.func.max(NodeUpload.timestamp)).scalar()
        total_records = db.session.query(db.func.count(NodeUpload.id)).scalar() or 0
        records_24h = (
            db.session.query(db.func.count(NodeUpload.id))
            .filter(NodeUpload.timestamp >= (_utcnow() - timedelta(hours=24)))
            .scalar()
            or 0
        )

        db_uri = (app_instance.config.get("SQLALCHEMY_DATABASE_URI") if app_instance else "") or ""
        db_size_mb = 0.0
        sqlite_path = _resolve_sqlite_path(_sqlite_db_path_from_uri(db_uri))
        if sqlite_path is not None and sqlite_path.exists():
            db_size_mb = round(sqlite_path.stat().st_size / (1024 * 1024), 2)

        return jsonify(
            {
                "total_nodes": int(len(all_ids)),
                "online_nodes": int(len(online_ids)),
                "total_records": int(total_records),
                "records_24h": int(records_24h),
                "latest_upload": iso_beijing(latest_ts) if latest_ts else None,
                "database_size_mb": float(db_size_mb),
                "node_timeout_sec": int(NODE_TIMEOUT),
            }
        ), 200
    except Exception as exc:
        logger.exception("[/api/dashboard/stats] failed: %s", exc)
        return jsonify({"total_nodes": 0, "online_nodes": 0, "error": str(exc)}), 500


@api_bp.route("/get_active_nodes", methods=["GET"])
@login_required
def get_active_nodes():
    try:
        now_ts = _now_ts()
        nodes = []
        for node_id, info in list(active_nodes.items()):
            if not _is_online(info, now_ts):
                continue
            nodes.append(
                {
                    "node_id": node_id,
                    "status": "online",
                    "last_upload": iso_beijing(info.get("last_upload_utc")) if info.get("last_upload_utc") else None,
                    "turbine_count": int(info.get("turbine_count") or 0),
                }
            )
        return jsonify({"success": True, "nodes": nodes, "count": len(nodes)}), 200
    except Exception as exc:
        logger.exception("[/api/get_active_nodes] failed: %s", exc)
        return jsonify({"success": False, "nodes": [], "error": str(exc)}), 500


@api_bp.route("/devices", methods=["GET"])
@login_required
def devices_compat():
    try:
        now_ts = _now_ts()
        rows = (
            db.session.query(NodeUpload.node_id, db.func.max(NodeUpload.timestamp))
            .group_by(NodeUpload.node_id)
            .all()
        )
        devices = []
        for node_id, last_ts in rows:
            info = active_nodes.get(node_id) or {}
            devices.append(
                {
                    "device_id": node_id,
                    "location": node_id,
                    "status": "online" if _is_online(info, now_ts) else "offline",
                    "last_heartbeat": iso_beijing(last_ts) if last_ts else None,
                    "turbine_count": int(info.get("turbine_count") or 0),
                }
            )
        return jsonify({"success": True, "devices": devices}), 200
    except Exception as exc:
        logger.exception("[/api/devices] failed: %s", exc)
        return jsonify({"success": False, "devices": [], "error": str(exc)}), 500


@api_bp.route("/admin/system_info", methods=["GET"])
@login_required
def admin_system_info():
    try:
        version = os.environ.get("WINDSIGHT_VERSION", "v1.0.0")
        async_mode = getattr(socketio_instance, "async_mode", None) if socketio_instance else None

        db_uri = (app_instance.config.get("SQLALCHEMY_DATABASE_URI") if app_instance else "") or ""
        sqlite_path = _resolve_sqlite_path(_sqlite_db_path_from_uri(db_uri))
        sizes = _sqlite_file_sizes_mb(sqlite_path)

        now_ts = _now_ts()
        online_count = len([node_id for node_id, info in list(active_nodes.items()) if _is_online(info, now_ts)])
        total_nodes = db.session.query(db.func.count(db.distinct(NodeUpload.node_id))).scalar() or 0
        total_rows = db.session.query(db.func.count(NodeUpload.id)).scalar() or 0

        return jsonify(
            {
                "success": True,
                "data": {
                    "version": version,
                    "database_size_mb": float(sizes.get("db_mb") or 0.0),
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
    except Exception as exc:
        logger.exception("[/api/admin/system_info] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/config", methods=["GET", "POST"])
@login_required
def admin_config():
    keys = ["poll_interval", "auto_refresh", "show_debug_log", "log_retention"]
    try:
        if request.method == "GET":
            data = {}
            for key in keys:
                row = SystemConfig.query.filter_by(key=key).first()
                if row and row.value is not None:
                    try:
                        data[key] = json.loads(row.value)
                    except Exception:
                        data[key] = row.value
            return jsonify({"success": True, "data": data}), 200

        payload = request.get_json(silent=True) or {}
        for key in keys:
            if key not in payload:
                continue
            row = SystemConfig.query.filter_by(key=key).first()
            if row:
                row.value = json.dumps(payload.get(key), ensure_ascii=False)
                row.updated_at = _utcnow()
            else:
                db.session.add(
                    SystemConfig(
                        key=key,
                        value=json.dumps(payload.get(key), ensure_ascii=False),
                        description="system config",
                    )
                )

        db.session.commit()
        return jsonify({"success": True, "message": "saved"}), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/config] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/cleanup_old_data", methods=["POST"])
@login_required
def admin_cleanup_old_data():
    try:
        payload = request.get_json(silent=True) or {}
        retention_days = int(payload.get("retention_days", 30))
        if retention_days <= 0:
            return jsonify({"success": False, "error": "retention_days must be > 0"}), 400

        cutoff = _utcnow() - timedelta(days=retention_days)
        measurement_deleted = TurbineMeasurement.query.filter(
            TurbineMeasurement.timestamp < cutoff
        ).delete(synchronize_session=False)
        upload_deleted = NodeUpload.query.filter(NodeUpload.timestamp < cutoff).delete(synchronize_session=False)
        db.session.commit()

        for node_id, info in list(active_nodes.items()):
            last_upload_utc = info.get("last_upload_utc")
            if last_upload_utc and last_upload_utc < cutoff and not _is_online(info, _now_ts()):
                active_nodes.pop(node_id, None)

        return jsonify(
            {
                "success": True,
                "details": {
                    "node_uploads_deleted": int(upload_deleted or 0),
                    "turbine_measurements_deleted": int(measurement_deleted or 0),
                    "node_data_deleted": int(upload_deleted or 0),
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/cleanup_old_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/clear_all_data", methods=["POST"])
@login_required
def admin_clear_all_data():
    try:
        measurement_deleted = TurbineMeasurement.query.delete(synchronize_session=False)
        upload_deleted = NodeUpload.query.delete(synchronize_session=False)
        db.session.commit()
        active_nodes.clear()
        return jsonify(
            {
                "success": True,
                "details": {
                    "node_uploads_deleted": int(upload_deleted or 0),
                    "turbine_measurements_deleted": int(measurement_deleted or 0),
                    "node_data_deleted": int(upload_deleted or 0),
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/clear_all_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/delete_node_data", methods=["POST"])
@login_required
def admin_delete_node_data():
    try:
        payload = request.get_json(silent=True) or {}
        node_id = (payload.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"success": False, "error": "missing node_id"}), 400

        measurement_deleted = TurbineMeasurement.query.filter(
            TurbineMeasurement.node_id == node_id
        ).delete(synchronize_session=False)
        upload_deleted = NodeUpload.query.filter(NodeUpload.node_id == node_id).delete(synchronize_session=False)
        db.session.commit()
        active_nodes.pop(node_id, None)

        return jsonify(
            {
                "success": True,
                "details": {
                    "node_id": node_id,
                    "node_uploads_deleted": int(upload_deleted or 0),
                    "turbine_measurements_deleted": int(measurement_deleted or 0),
                    "node_data_deleted": int(upload_deleted or 0),
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/delete_node_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/reset_data", methods=["POST"])
@login_required
def admin_reset_data_alias():
    return admin_clear_all_data()


@api_bp.route("/admin/vacuum", methods=["POST"])
@login_required
def admin_vacuum():
    try:
        db_uri = (app_instance.config.get("SQLALCHEMY_DATABASE_URI") if app_instance else "") or ""
        if not str(db_uri).startswith("sqlite"):
            return jsonify({"success": False, "error": "VACUUM is only supported for SQLite"}), 400

        sqlite_path = _resolve_sqlite_path(_sqlite_db_path_from_uri(db_uri))
        before = _sqlite_file_sizes_mb(sqlite_path)

        try:
            db.session.commit()
        except Exception:
            db.session.rollback()

        with db.engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
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
        return jsonify(
            {
                "success": True,
                "message": "vacuum complete",
                "details": {"before": before, "after": after},
            }
        ), 200
    except Exception as exc:
        logger.exception("[/api/admin/vacuum] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500
