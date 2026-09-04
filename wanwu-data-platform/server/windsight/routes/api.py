from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user, login_required
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from windsight.models import (
    NodeAuthNonce,
    NodeCredential,
    NodeUpload,
    RegisteredNode,
    RegistrationInvite,
    SystemConfig,
    TelemetryMetric,
    TelemetryRecord,
    TurbineMeasurement,
    User,
    UserSetting,
    db,
)
from windsight.protocol import (
    ProtocolValidationError,
    is_turbine_upload_candidate,
    parse_telemetry_upload,
    parse_turbine_upload,
)
from windsight.time_utils import iso_beijing, parse_client_datetime_to_utc

api_bp = Blueprint("api", __name__, url_prefix="/api")
logger = logging.getLogger(__name__)

MAX_HISTORY_LIMIT = 20000
NODE_ID_RE = re.compile(r"^[A-Z0-9_-]{3,64}$")
active_nodes = {}
DEFAULT_NODE_TIMEOUT = int(os.environ.get("NODE_TIMEOUT_SECONDS", os.environ.get("NODE_TIMEOUT", 10)))
DEFAULT_INVITE_EXPIRES_DAYS = 7
MAX_INVITE_BATCH_COUNT = 50
UPLOAD_SIGNATURE_VERSION = "v1"
UPLOAD_SIGNATURE_ALGORITHM = "HMAC-SHA256"
UPLOAD_TIMESTAMP_WINDOW_SECONDS = int(os.environ.get("WINDSIGHT_UPLOAD_SIGNATURE_WINDOW_SECONDS", "300"))
UPLOAD_NONCE_TTL_SECONDS = UPLOAD_TIMESTAMP_WINDOW_SECONDS + 60
ALLOW_LEGACY_NODE_KEY_UPLOAD = os.environ.get("WINDSIGHT_ALLOW_LEGACY_NODE_KEY_UPLOAD", "1").strip() != "0"
DEFAULT_UPLOAD_INTERVAL_SECONDS = 60
MIN_UPLOAD_INTERVAL_SECONDS = 5
MAX_UPLOAD_INTERVAL_SECONDS = 86400
UPLOAD_GAP_THRESHOLD_MULTIPLIER = 1.5
MIN_UPLOAD_GAP_THRESHOLD_SECONDS = 120
USER_CONFIG_DEFAULTS = {
    "poll_interval": 3000,
    "auto_refresh": True,
    "show_debug_log": False,
    "log_retention": 30,
}
db_executor = None
socketio_instance = None
app_instance = None


def init_api_blueprint(app, socketio, executor, nodes, commands):
    global active_nodes, db_executor, socketio_instance, app_instance
    active_nodes = nodes
    db_executor = executor
    socketio_instance = socketio
    app_instance = app


def _normalize_node_id(value) -> str:
    return str(value or "").strip().upper()


def _validate_node_id(value: str) -> tuple[bool, str]:
    node_id = _normalize_node_id(value)
    if not node_id:
        return False, "node_id is required"
    if not NODE_ID_RE.match(node_id):
        return False, "node_id must be 3-64 chars: A-Z, 0-9, _ or -"
    return True, node_id


def _normalize_node_display_name(value, fallback_node_id: str) -> str:
    display_name = str(value or "").strip()
    return display_name[:120] or fallback_node_id


def _normalize_upload_interval_seconds(value) -> int:
    try:
        interval = int(value)
    except (TypeError, ValueError):
        raise ValueError("upload_interval_seconds must be an integer between 5 and 86400") from None
    if interval < MIN_UPLOAD_INTERVAL_SECONDS or interval > MAX_UPLOAD_INTERVAL_SECONDS:
        raise ValueError("upload_interval_seconds must be an integer between 5 and 86400")
    return interval


def _node_upload_interval_seconds(registered_node_or_node_id) -> int:
    if isinstance(registered_node_or_node_id, RegisteredNode):
        raw_value = getattr(registered_node_or_node_id, "upload_interval_seconds", None)
    else:
        node_id = _normalize_node_id(registered_node_or_node_id)
        registered_node = RegisteredNode.query.filter_by(node_id=node_id, is_active=True).first() if node_id else None
        raw_value = getattr(registered_node, "upload_interval_seconds", None)
    try:
        return _normalize_upload_interval_seconds(raw_value if raw_value is not None else DEFAULT_UPLOAD_INTERVAL_SECONDS)
    except ValueError:
        return DEFAULT_UPLOAD_INTERVAL_SECONDS


def _node_gap_threshold_seconds(upload_interval_seconds: int) -> float:
    return round(max(MIN_UPLOAD_GAP_THRESHOLD_SECONDS, float(upload_interval_seconds) * UPLOAD_GAP_THRESHOLD_MULTIPLIER), 3)


def _utcnow() -> datetime:
    return datetime.utcnow()


def _json_error(message: str, status_code: int = 400, error_code: str = "bad_request"):
    return jsonify({"success": False, "status": "error", "error": message, "error_code": error_code}), status_code


def _credential_cipher() -> Fernet:
    configured = (os.environ.get("WINDSIGHT_CREDENTIAL_ENCRYPTION_KEY") or "").strip()
    if configured:
        try:
            return Fernet(configured.encode("utf-8"))
        except Exception as exc:
            raise RuntimeError("WINDSIGHT_CREDENTIAL_ENCRYPTION_KEY is not a valid Fernet key") from exc

    secret_key = str(current_app.config.get("SECRET_KEY") or os.environ.get("SECRET_KEY") or "windsight-dev")
    derived = base64.urlsafe_b64encode(hashlib.sha256(secret_key.encode("utf-8")).digest())
    return Fernet(derived)


def _encrypt_credential_secret(secret: str) -> str:
    return _credential_cipher().encrypt(secret.encode("utf-8")).decode("utf-8")


def _decrypt_credential_secret(credential: NodeCredential) -> str:
    try:
        return _credential_cipher().decrypt(credential.secret_encrypted.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("credential secret cannot be decrypted") from exc


def _credential_public_dict(
    credential: NodeCredential | None,
    include_secret: bool = False,
    secret: str | None = None,
) -> dict | None:
    if not credential:
        return None
    data = {
        "key_id": credential.key_id,
        "algorithm": credential.algorithm,
        "status": credential.status,
        "auth_version": UPLOAD_SIGNATURE_VERSION,
        "created_at": iso_beijing(credential.created_at, with_seconds=True) if credential.created_at else None,
        "activated_at": iso_beijing(credential.activated_at, with_seconds=True) if credential.activated_at else None,
        "expires_at": iso_beijing(credential.expires_at, with_seconds=True) if credential.expires_at else None,
        "revoked_at": iso_beijing(credential.revoked_at, with_seconds=True) if credential.revoked_at else None,
        "last_used_at": iso_beijing(credential.last_used_at, with_seconds=True) if credential.last_used_at else None,
        "last_failed_at": iso_beijing(credential.last_failed_at, with_seconds=True) if credential.last_failed_at else None,
        "last_failure_reason": credential.last_failure_reason or "",
        "secret_fingerprint": (credential.secret_hash or "")[:16],
    }
    if include_secret:
        data["secret"] = secret if secret is not None else _decrypt_credential_secret(credential)
        data["secret_visible"] = True
    else:
        data["secret_visible"] = False
    return data


def _current_node_credential(registered_node: RegisteredNode) -> NodeCredential | None:
    credentials = list(getattr(registered_node, "credentials", []) or [])
    if not credentials:
        return None
    order = {
        NodeCredential.STATUS_ACTIVE: 0,
        NodeCredential.STATUS_GRACE: 1,
        NodeCredential.STATUS_REVOKED: 2,
    }
    credentials.sort(key=lambda item: (order.get(item.status, 9), item.created_at or datetime.min), reverse=False)
    return credentials[0]


def _create_node_credential(registered_node: RegisteredNode) -> tuple[NodeCredential, str]:
    secret = NodeCredential.generate_secret()
    key_id = ""
    for _ in range(30):
        candidate = NodeCredential.generate_key_id()
        if not NodeCredential.query.filter_by(key_id=candidate).first():
            key_id = candidate
            break
    if not key_id:
        raise RuntimeError("failed to generate unique credential key_id")
    credential = NodeCredential(
        registered_node=registered_node,
        registered_node_id=registered_node.id,
        node_id=registered_node.node_id,
        key_id=key_id,
        secret_encrypted=_encrypt_credential_secret(secret),
        secret_hash=NodeCredential.hash_secret(secret),
        algorithm=UPLOAD_SIGNATURE_ALGORITHM,
        status=NodeCredential.STATUS_ACTIVE,
        created_at=_utcnow(),
        activated_at=_utcnow(),
    )
    db.session.add(credential)
    return credential, secret


def _rotate_node_credential(registered_node: RegisteredNode, grace_hours: int = 0) -> tuple[NodeCredential, str]:
    now = _utcnow()
    grace_hours = max(0, min(24, int(grace_hours or 0)))
    for credential in list(getattr(registered_node, "credentials", []) or []):
        if credential.status == NodeCredential.STATUS_ACTIVE:
            if grace_hours > 0:
                credential.status = NodeCredential.STATUS_GRACE
                credential.expires_at = now + timedelta(hours=grace_hours)
            else:
                credential.status = NodeCredential.STATUS_REVOKED
                credential.revoked_at = now
                credential.expires_at = now
    return _create_node_credential(registered_node)


def build_upload_canonical_string(
    *,
    method: str,
    path: str,
    device_id: str,
    key_id: str,
    timestamp: str,
    nonce: str,
    body_sha256: str,
) -> str:
    return "\n".join(
        [
            "WIND-SIGHT-HMAC-SHA256",
            UPLOAD_SIGNATURE_VERSION,
            method.upper(),
            path,
            device_id,
            key_id,
            timestamp,
            nonce,
            body_sha256,
        ]
    )


def sign_upload_request(secret: str, canonical_string: str) -> str:
    return hmac.new(secret.encode("utf-8"), canonical_string.encode("utf-8"), hashlib.sha256).hexdigest()


def _parse_upload_timestamp(raw_value: str) -> datetime | None:
    value = str(raw_value or "").strip()
    if not value:
        return None
    try:
        return datetime.utcfromtimestamp(float(value))
    except Exception:
        pass
    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except Exception:
        return None


def _signature_headers_present() -> bool:
    marker_headers = (
        "X-WindSight-Signature-Version",
        "X-WindSight-Key-Id",
        "X-WindSight-Signature",
    )
    return any((request.headers.get(name) or "").strip() for name in marker_headers)


def _record_credential_failure(credential: NodeCredential | None, reason: str):
    if not credential:
        return
    try:
        credential.last_failed_at = _utcnow()
        credential.last_failure_reason = str(reason or "auth_failed")[:255]
        db.session.commit()
    except Exception:
        db.session.rollback()


def _authenticate_upload_request(raw_body: bytes, payload: dict, parsed):
    node_id = _normalize_node_id(parsed.node_id)
    body_sha256 = hashlib.sha256(raw_body or b"").hexdigest()
    registered_node = RegisteredNode.query.filter_by(node_id=node_id, is_active=True).first()

    if not get_upload_auth_required():
        if not registered_node:
            return None, None, _json_error("registered node not found", 403, "node_not_registered")
        return registered_node, {"version": "node-id-only"}, None

    if _signature_headers_present():
        required = {
            "version": "X-WindSight-Signature-Version",
            "algorithm": "X-WindSight-Algorithm",
            "device_id": "X-WindSight-Device-Id",
            "key_id": "X-WindSight-Key-Id",
            "timestamp": "X-WindSight-Timestamp",
            "nonce": "X-WindSight-Nonce",
            "body_sha256": "X-WindSight-Body-SHA256",
            "signature": "X-WindSight-Signature",
        }
        headers = {key: (request.headers.get(name) or "").strip() for key, name in required.items()}
        missing = [name for key, name in required.items() if not headers[key]]
        if missing:
            return None, None, _json_error("missing HMAC auth headers", 403, "missing_hmac_headers")
        if headers["version"] != UPLOAD_SIGNATURE_VERSION:
            return None, None, _json_error("unsupported signature version", 403, "unsupported_signature_version")
        if headers["algorithm"].upper() != UPLOAD_SIGNATURE_ALGORITHM:
            return None, None, _json_error("unsupported signature algorithm", 403, "unsupported_signature_algorithm")
        device_id = _normalize_node_id(headers["device_id"])
        if device_id != node_id:
            return None, None, _json_error("header device id does not match payload node_id", 403, "device_id_mismatch")
        if not registered_node:
            return None, None, _json_error("registered node not found", 403, "node_not_registered")

        credential = NodeCredential.query.filter_by(key_id=headers["key_id"]).first()
        if (
            not credential
            or credential.node_id != node_id
            or credential.registered_node_id != registered_node.id
            or credential.algorithm != UPLOAD_SIGNATURE_ALGORITHM
        ):
            return None, None, _json_error("credential not found", 403, "credential_not_found")
        now = _utcnow()
        if not credential.is_usable(now):
            _record_credential_failure(credential, "credential_revoked_or_expired")
            return None, None, _json_error("credential revoked or expired", 403, "credential_revoked")

        signed_at = _parse_upload_timestamp(headers["timestamp"])
        if not signed_at or abs((now - signed_at).total_seconds()) > UPLOAD_TIMESTAMP_WINDOW_SECONDS:
            _record_credential_failure(credential, "timestamp_out_of_window")
            return None, None, _json_error("timestamp is outside allowed window", 403, "timestamp_out_of_window")
        if not hmac.compare_digest(headers["body_sha256"].lower(), body_sha256):
            _record_credential_failure(credential, "body_sha256_mismatch")
            return None, None, _json_error("body sha256 mismatch", 403, "body_sha256_mismatch")
        if len(headers["nonce"]) > 128:
            _record_credential_failure(credential, "nonce_too_long")
            return None, None, _json_error("nonce too long", 403, "nonce_too_long")

        try:
            secret = _decrypt_credential_secret(credential)
        except RuntimeError:
            logger.exception("[/api/upload] failed to decrypt credential secret for key_id=%s", credential.key_id)
            return None, None, _json_error("credential secret unavailable", 500, "credential_secret_unavailable")

        canonical = build_upload_canonical_string(
            method=request.method,
            path=request.path,
            device_id=device_id,
            key_id=headers["key_id"],
            timestamp=headers["timestamp"],
            nonce=headers["nonce"],
            body_sha256=body_sha256,
        )
        expected_signature = sign_upload_request(secret, canonical)
        supplied_signature = headers["signature"].removeprefix("sha256=").lower()
        if not hmac.compare_digest(supplied_signature, expected_signature):
            _record_credential_failure(credential, "signature_mismatch")
            return None, None, _json_error("signature mismatch", 403, "signature_mismatch")

        try:
            NodeAuthNonce.query.filter(NodeAuthNonce.expires_at < now).delete(synchronize_session=False)
            db.session.add(
                NodeAuthNonce(
                    credential_id=credential.id,
                    node_id=node_id,
                    key_id=credential.key_id,
                    nonce=headers["nonce"],
                    body_sha256=body_sha256,
                    signature_sha256=hashlib.sha256(supplied_signature.encode("utf-8")).hexdigest(),
                    received_at=now,
                    expires_at=now + timedelta(seconds=UPLOAD_NONCE_TTL_SECONDS),
                )
            )
            db.session.flush()
        except IntegrityError:
            db.session.rollback()
            _record_credential_failure(credential, "nonce_replay")
            return None, None, _json_error("nonce has already been used", 403, "nonce_replay")

        credential.last_used_at = now
        credential.last_failure_reason = ""
        credential.last_failed_at = None
        return registered_node, {"version": "hmac-v1", "key_id": credential.key_id}, None

    node_key = (request.headers.get("X-WindSight-Node-Key") or "").strip()
    if not ALLOW_LEGACY_NODE_KEY_UPLOAD:
        return None, None, _json_error("legacy node key auth is disabled", 403, "legacy_auth_disabled")
    if not registered_node or not node_key or not registered_node.check_node_key(node_key):
        return None, None, _json_error("节点未注册或密钥错误", 403, "legacy_node_key_invalid")
    return registered_node, {"version": "legacy-node-key"}, None


def _is_admin_user(user=None) -> bool:
    user = user or current_user
    return bool(getattr(user, "is_authenticated", False) and getattr(user, "role", "") == "admin")


def admin_required(view_func):
    @wraps(view_func)
    @login_required
    def wrapper(*args, **kwargs):
        if not _is_admin_user():
            return jsonify({"success": False, "error": "admin required"}), 403
        return view_func(*args, **kwargs)

    return wrapper


def _registered_node_query_for_current_user():
    query = RegisteredNode.query.filter_by(is_active=True)
    if _is_admin_user():
        return query
    return query.filter_by(owner_user_id=current_user.id)


def _accessible_node_ids_for_current_user() -> set[str]:
    if not getattr(current_user, "is_authenticated", False):
        return set()
    rows = _registered_node_query_for_current_user().with_entities(RegisteredNode.node_id).all()
    return {_normalize_node_id(row[0]) for row in rows}


def _can_access_node(node_id: str) -> bool:
    if _is_admin_user():
        return True
    normalized = _normalize_node_id(node_id)
    return bool(
        RegisteredNode.query.filter_by(
            node_id=normalized,
            owner_user_id=current_user.id,
            is_active=True,
        ).first()
    )


def _owned_node_ids(user_id: int | None = None) -> list[str]:
    owner_id = int(user_id or current_user.id)
    rows = (
        RegisteredNode.query.filter_by(owner_user_id=owner_id, is_active=True)
        .with_entities(RegisteredNode.node_id)
        .all()
    )
    return [_normalize_node_id(row[0]) for row in rows]


def _delete_uploads_for_node_ids(node_ids: list[str], cutoff: datetime | None = None) -> tuple[int, int]:
    ids = [_normalize_node_id(node_id) for node_id in node_ids if _normalize_node_id(node_id)]
    if not ids:
        return 0, 0
    measurement_query = TurbineMeasurement.query.filter(TurbineMeasurement.node_id.in_(ids))
    upload_query = NodeUpload.query.filter(NodeUpload.node_id.in_(ids))
    if cutoff is not None:
        measurement_query = measurement_query.filter(TurbineMeasurement.timestamp < cutoff)
        upload_query = upload_query.filter(NodeUpload.timestamp < cutoff)
    measurement_deleted = measurement_query.delete(synchronize_session=False)
    upload_deleted = upload_query.delete(synchronize_session=False)
    return int(upload_deleted or 0), int(measurement_deleted or 0)


def _delete_telemetry_for_node_ids(node_ids: list[str], cutoff: datetime | None = None) -> tuple[int, int]:
    """Delete generic frames and their flattened numeric values together."""

    ids = [_normalize_node_id(node_id) for node_id in node_ids if _normalize_node_id(node_id)]
    if not ids:
        return 0, 0
    metric_query = TelemetryMetric.query.filter(TelemetryMetric.node_id.in_(ids))
    record_query = TelemetryRecord.query.filter(TelemetryRecord.node_id.in_(ids))
    if cutoff is not None:
        metric_query = metric_query.filter(TelemetryMetric.timestamp < cutoff)
        record_query = record_query.filter(TelemetryRecord.timestamp < cutoff)
    metric_deleted = metric_query.delete(synchronize_session=False)
    record_deleted = record_query.delete(synchronize_session=False)
    return int(record_deleted or 0), int(metric_deleted or 0)


def _load_user_config(user_id: int) -> dict:
    data = dict(USER_CONFIG_DEFAULTS)
    rows = UserSetting.query.filter_by(user_id=user_id).all()
    for row in rows:
        if row.key not in USER_CONFIG_DEFAULTS:
            continue
        try:
            data[row.key] = json.loads(row.value)
        except Exception:
            data[row.key] = row.value
    return _normalize_user_config(data)


def _normalize_user_config(data: dict) -> dict:
    normalized = dict(USER_CONFIG_DEFAULTS)
    if "poll_interval" in data:
        try:
            poll_interval = int(data.get("poll_interval"))
            normalized["poll_interval"] = min(30000, max(500, poll_interval))
        except Exception:
            normalized["poll_interval"] = USER_CONFIG_DEFAULTS["poll_interval"]
    if "auto_refresh" in data:
        normalized["auto_refresh"] = bool(data.get("auto_refresh"))
    if "show_debug_log" in data:
        normalized["show_debug_log"] = bool(data.get("show_debug_log"))
    if "log_retention" in data:
        try:
            log_retention = int(data.get("log_retention"))
            normalized["log_retention"] = log_retention if log_retention in {7, 30, 90, 180, 365, -1} else 30
        except Exception:
            normalized["log_retention"] = USER_CONFIG_DEFAULTS["log_retention"]
    return normalized


def _save_user_config(user_id: int, payload: dict) -> dict:
    data = _normalize_user_config(payload)
    existing = {
        row.key: row
        for row in UserSetting.query.filter_by(user_id=user_id).filter(UserSetting.key.in_(list(USER_CONFIG_DEFAULTS.keys())))
    }
    for key, value in data.items():
        row = existing.get(key)
        encoded = json.dumps(value, ensure_ascii=False)
        if row:
            row.value = encoded
            row.updated_at = _utcnow()
        else:
            db.session.add(UserSetting(user_id=user_id, key=key, value=encoded))
    return data


def _node_owner_display(registered_node: RegisteredNode | None) -> str:
    if not registered_node or not registered_node.owner:
        return ""
    return registered_node.owner.username


def _registered_node_geo(registered_node: RegisteredNode) -> dict | None:
    try:
        lng = float(registered_node.geo_lng)
        lat = float(registered_node.geo_lat)
    except (TypeError, ValueError):
        return None
    if lng < -180 or lng > 180 or lat < -90 or lat > 90:
        return None
    return {"lng": lng, "lat": lat}


def _registered_node_to_dict(
    registered_node: RegisteredNode,
    include_owner: bool = False,
    include_key: bool = False,
    include_auth: bool = False,
    include_credential_secret: bool = False,
):
    latest_upload = _load_latest_upload(registered_node.node_id)
    item = _build_node_item(registered_node.node_id, latest_upload, _now_ts())
    telemetry_fields = _telemetry_field_descriptors(registered_node.node_id)
    geo = _registered_node_geo(registered_node)
    item.update(
        {
            "id": registered_node.id,
            "display_name": registered_node.display_name or registered_node.node_id,
            "owner_user_id": registered_node.owner_user_id,
            "registered_at": iso_beijing(registered_node.created_at) if registered_node.created_at else None,
            "last_seen_at": iso_beijing(registered_node.last_seen_at) if registered_node.last_seen_at else None,
            "is_registered": True,
            "geo": geo,
            "geo_configured": bool(geo),
            "upload_interval_seconds": _node_upload_interval_seconds(registered_node),
            "telemetry_field_count": len(telemetry_fields),
            "telemetry_fields": telemetry_fields,
        }
    )
    if include_owner:
        item["owner_username"] = _node_owner_display(registered_node)
    if include_key:
        item["node_key"] = registered_node.node_key_plain or ""
        item["node_key_available"] = bool(registered_node.node_key_plain)
        include_auth = True
        include_credential_secret = True
    if include_auth:
        credential = _current_node_credential(registered_node)
        item["credential"] = _credential_public_dict(
            credential,
            include_secret=include_credential_secret,
        )
        item["auth"] = {
            "version": "hmac-v1" if credential else "legacy-node-key",
            "legacy_available": bool(registered_node.node_key_plain),
            "credential_available": bool(credential),
            "credential_status": credential.status if credential else "",
            "last_success_at": (
                iso_beijing(credential.last_used_at, with_seconds=True)
                if credential and credential.last_used_at
                else None
            ),
            "last_failure_reason": credential.last_failure_reason if credential else "",
        }
    return item


def _clean_geo_value(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        if value == "":
            return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise ValueError("经纬度必须是数字")
    return parsed


def _parse_geo_payload(payload: dict) -> tuple[float | None, float | None]:
    if not isinstance(payload, dict):
        raise ValueError("请求数据格式错误")
    source = payload.get("geo") if isinstance(payload.get("geo"), dict) else payload
    lng = _clean_geo_value(source.get("lng"))
    lat = _clean_geo_value(source.get("lat"))
    if lng is None and lat is None:
        return None, None
    if lng is None or lat is None:
        raise ValueError("经度和纬度必须同时填写")
    if lng < -180 or lng > 180:
        raise ValueError("经度范围必须在 -180 到 180 之间")
    if lat < -90 or lat > 90:
        raise ValueError("纬度范围必须在 -90 到 90 之间")
    return lng, lat


def _save_registered_node_location(registered_node: RegisteredNode, payload: dict):
    lng, lat = _parse_geo_payload(payload)
    registered_node.geo_lng = lng
    registered_node.geo_lat = lat
    db.session.commit()


def _user_to_admin_dict(user: User) -> dict:
    nodes = list(getattr(user, "registered_nodes", []) or [])
    active_count = len([node for node in nodes if node.is_active])
    latest_seen = None
    for node in nodes:
        if node.last_seen_at and (latest_seen is None or node.last_seen_at > latest_seen):
            latest_seen = node.last_seen_at
    created_at = getattr(user, "created_at", None)
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role or "user",
        "is_active": bool(user.is_active),
        "created_at": iso_beijing(created_at) if created_at else None,
        "node_count": active_count,
        "last_seen_at": iso_beijing(latest_seen) if latest_seen else None,
    }


INVITE_STATUS_LABELS = {
    "available": "可用",
    "used": "已使用",
    "expired": "已过期",
    "revoked": "已吊销",
}


def _invite_to_admin_dict(invite: RegistrationInvite, now: datetime | None = None) -> dict:
    status = invite.status(now or _utcnow())
    return {
        "id": invite.id,
        "code": invite.code,
        "status": status,
        "status_label": INVITE_STATUS_LABELS.get(status, status),
        "created_by_user_id": invite.created_by_user_id,
        "created_by_username": invite.created_by.username if invite.created_by else "",
        "created_at": iso_beijing(invite.created_at) if invite.created_at else None,
        "expires_at": iso_beijing(invite.expires_at) if invite.expires_at else None,
        "used_by_user_id": invite.used_by_user_id,
        "used_by_username": invite.used_by.username if invite.used_by else "",
        "used_at": iso_beijing(invite.used_at) if invite.used_at else None,
        "revoked_at": iso_beijing(invite.revoked_at) if invite.revoked_at else None,
    }


def _now_ts() -> float:
    return time.time()


def get_node_timeout_seconds() -> int:
    try:
        row = SystemConfig.query.filter_by(key="node_timeout_seconds").first()
        if row and row.value is not None:
            value = json.loads(row.value)
        else:
            value = DEFAULT_NODE_TIMEOUT
        timeout = int(value)
        if timeout < 1 or timeout > 86400:
            raise ValueError("node_timeout_seconds out of range")
        return timeout
    except Exception:
        return DEFAULT_NODE_TIMEOUT


def get_upload_auth_required() -> bool:
    try:
        row = SystemConfig.query.filter_by(key="upload_auth_required").first()
        if not row or row.value is None:
            return True
        value = json.loads(row.value)
        if isinstance(value, str):
            return value.strip().lower() not in {"0", "false", "off", "no"}
        return bool(value)
    except Exception:
        return True


def _is_online(node_info: dict, now_ts: float, timeout_sec: int | None = None) -> bool:
    try:
        timeout = int(timeout_sec if timeout_sec is not None else get_node_timeout_seconds())
        return (now_ts - float(node_info.get("timestamp", 0))) <= timeout
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


def _sort_turbine_codes(codes):
    normalized = {str(code).strip() for code in (codes or []) if str(code).strip()}
    return sorted(normalized, key=lambda code: (int(code) if code.isdigit() else 10**9, code))


def _normalize_turbine_code_param(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.isdigit():
        number = int(raw)
        if 1 <= number <= 999:
            return f"{number:03d}"
    if re.fullmatch(r"\d{3}", raw):
        return raw
    raise ValueError("turbine must be a 3-digit code")


def _merge_turbine_codes(*code_groups):
    merged = []
    for codes in code_groups:
        if codes:
            merged.extend(codes)
    return _sort_turbine_codes(merged)


def _load_node_turbine_codes(node_id: str):
    rows = (
        db.session.query(TurbineMeasurement.turbine_code)
        .filter(TurbineMeasurement.node_id == node_id)
        .distinct()
        .all()
    )
    return _sort_turbine_codes(row[0] for row in rows)


def _build_node_item(node_id: str, latest_upload, now_ts: float):
    info = active_nodes.get(node_id) or {}
    online = _is_online(info, now_ts)
    last_utc = info.get("last_upload_utc") or (latest_upload.timestamp if latest_upload else None)
    stored_codes = _load_node_turbine_codes(node_id) if latest_upload else []
    turbine_codes = _merge_turbine_codes(
        info.get("turbines"),
        latest_upload.turbine_codes() if latest_upload else [],
        stored_codes,
    )
    turbine_count = len(turbine_codes) or info.get("turbine_count") or (latest_upload.turbine_count if latest_upload else 0)
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


def _apply_turbine_filter(query, turbine_code: str | None):
    if not turbine_code:
        return query
    return query.join(TurbineMeasurement, NodeUpload.id == TurbineMeasurement.upload_id).filter(
        TurbineMeasurement.turbine_code == turbine_code
    )


def _get_filtered_rows(node_id: str, limit: int, start_utc, end_utc, turbine_code: str | None = None):
    query = _apply_time_filters(_base_upload_query(node_id), start_utc, end_utc)
    query = _apply_turbine_filter(query, turbine_code)
    if start_utc:
        return query.order_by(NodeUpload.timestamp.asc(), NodeUpload.id.asc()).limit(limit).all()
    rows = query.order_by(NodeUpload.timestamp.desc(), NodeUpload.id.desc()).limit(limit).all()
    rows.reverse()
    return rows


def _upload_rows_to_dicts(node_id: str, rows):
    upload_interval = _node_upload_interval_seconds(node_id)
    gap_threshold = _node_gap_threshold_seconds(upload_interval)
    result = []
    previous_ts = None
    for row in rows:
        item = row.to_row_dict()
        item["expected_interval_seconds"] = upload_interval
        item["gap_threshold_seconds"] = gap_threshold
        item["gap_from_previous_seconds"] = None
        item["is_gap_after_previous"] = False
        if previous_ts and row.timestamp:
            gap_seconds = round((row.timestamp - previous_ts).total_seconds(), 3)
            item["gap_from_previous_seconds"] = gap_seconds
            item["is_gap_after_previous"] = gap_seconds > gap_threshold
        previous_ts = row.timestamp
        result.append(item)
    return result


def _update_active_node_cache(node_id: str, upload_row):
    current_info = active_nodes.get(node_id) or {}
    turbine_codes = _merge_turbine_codes(current_info.get("turbines"), upload_row.turbine_codes())
    first_code = turbine_codes[0] if turbine_codes else None
    active_nodes[node_id] = {
        "timestamp": _now_ts(),
        "last_upload_utc": upload_row.timestamp,
        "turbine_count": len(turbine_codes) or upload_row.turbine_count,
        "turbines": turbine_codes,
        "last_values": upload_row.turbines_dict().get(first_code) if first_code else {},
    }


def _update_active_telemetry_cache(node_id: str, telemetry_row: TelemetryRecord):
    """Mark a generic source online without discarding its legacy turbine cache."""

    current_info = dict(active_nodes.get(node_id) or {})
    current_info.update(
        {
            "timestamp": _now_ts(),
            "last_upload_utc": telemetry_row.timestamp,
            "telemetry_metric_count": len(telemetry_row.metrics),
            "last_telemetry_values": telemetry_row.metrics_dict(),
        }
    )
    active_nodes[node_id] = current_info


def _emit_upload_events(node_id: str, upload_row):
    if not socketio_instance:
        return

    row_data = upload_row.to_row_dict()
    now_ts = _now_ts()
    turbine_codes = _merge_turbine_codes(
        (active_nodes.get(node_id) or {}).get("turbines"),
        upload_row.turbine_codes(),
    )
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
            "turbine_count": len(turbine_codes) or upload_row.turbine_count,
            "turbines": turbine_codes,
        },
        namespace="/",
    )


def _emit_telemetry_event(node_id: str, telemetry_row: TelemetryRecord):
    """Send generic telemetry only to clients subscribed to this source."""

    if not socketio_instance:
        return

    current_info = active_nodes.get(node_id) or {}
    socketio_instance.emit(
        "telemetry_update",
        {"node_id": node_id, "data": telemetry_row.to_event_dict()},
        room=f"node_{node_id}",
        namespace="/",
    )
    socketio_instance.emit(
        "node_status_update",
        {
            "node_id": node_id,
            "online": True,
            "timestamp": _now_ts(),
            "turbine_count": int(current_info.get("turbine_count") or 0),
            "turbines": _merge_turbine_codes(current_info.get("turbines")),
        },
        namespace="/",
    )


@api_bp.route("/upload", methods=["POST"])
def upload_node_data():
    raw_body = request.get_data(cache=True) or b""
    payload = request.get_json(silent=True)
    is_legacy_turbine_packet = is_turbine_upload_candidate(payload)
    try:
        parsed = parse_turbine_upload(payload) if is_legacy_turbine_packet else parse_telemetry_upload(payload)
    except ProtocolValidationError as exc:
        return _json_error(str(exc), 400, "protocol_invalid" if is_legacy_turbine_packet else "telemetry_invalid")

    node_id = _normalize_node_id(parsed.node_id)
    if not is_legacy_turbine_packet:
        valid_source, source_or_error = _validate_node_id(parsed.node_id)
        if not valid_source:
            return _json_error(source_or_error, 400, "source_identifier_invalid")
        node_id = source_or_error
    registered_node, auth_info, auth_error = _authenticate_upload_request(raw_body, payload, parsed)
    if auth_error:
        return auth_error

    timestamp = _utcnow()
    try:
        raw_payload = raw_body.decode("utf-8") if raw_body else json.dumps(payload, ensure_ascii=False)
        if is_legacy_turbine_packet:
            row = NodeUpload(
                node_id=node_id,
                turbine_count=parsed.turbine_count,
                timestamp=timestamp,
                raw_payload=raw_payload,
            )
            for index, code in enumerate(parsed.turbine_codes(), start=1):
                sample = parsed.turbines[code]
                row.measurements.append(
                    TurbineMeasurement(
                        node_id=node_id,
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
            registered_node.last_seen_at = timestamp
            db.session.commit()

            _update_active_node_cache(node_id, row)
            _emit_upload_events(node_id, row)
            return jsonify(
                {
                    "status": "success",
                    "upload_id": row.id,
                    "auth": auth_info,
                    "device_config": {
                        "upload_interval_seconds": _node_upload_interval_seconds(registered_node),
                    },
                }
            ), 200

        telemetry_row = TelemetryRecord(
            node_id=node_id,
            source_field=parsed.source_field,
            source_value=parsed.node_id,
            timestamp=timestamp,
            raw_payload=raw_payload,
        )
        for path, value in parsed.metrics.items():
            telemetry_row.metrics.append(
                TelemetryMetric(
                    node_id=node_id,
                    path=path,
                    value=value,
                    timestamp=timestamp,
                )
            )
        db.session.add(telemetry_row)
        registered_node.last_seen_at = timestamp
        db.session.commit()

        _update_active_telemetry_cache(node_id, telemetry_row)
        _emit_telemetry_event(node_id, telemetry_row)
        return jsonify(
            {
                "status": "success",
                "record_id": telemetry_row.id,
                "telemetry_id": telemetry_row.id,
                "source": {"field": telemetry_row.source_field, "id": telemetry_row.source_value},
                "metric_count": len(telemetry_row.metrics),
                "auth": auth_info,
                "device_config": {
                    "upload_interval_seconds": _node_upload_interval_seconds(registered_node),
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/upload] failed: %s", exc)
        return jsonify({"status": "error", "error": str(exc)}), 500


@api_bp.route("/nodes", methods=["GET"])
@login_required
def list_nodes():
    try:
        nodes = _registered_node_query_for_current_user().order_by(RegisteredNode.node_id.asc()).all()
        items = [_registered_node_to_dict(node, include_owner=_is_admin_user()) for node in nodes]
        return jsonify({"success": True, "nodes": items}), 200
    except Exception as exc:
        logger.exception("[/api/nodes] failed: %s", exc)
        return jsonify({"success": False, "nodes": [], "error": str(exc)}), 500


@api_bp.route("/my/registered_nodes", methods=["GET"])
@login_required
def my_registered_nodes():
    try:
        nodes = (
            RegisteredNode.query.filter_by(owner_user_id=current_user.id, is_active=True)
            .order_by(RegisteredNode.node_id.asc())
            .all()
        )
        return jsonify({"success": True, "nodes": [_registered_node_to_dict(node, include_key=True) for node in nodes]}), 200
    except Exception as exc:
        logger.exception("[/api/my/registered_nodes] failed: %s", exc)
        return jsonify({"success": False, "nodes": [], "error": str(exc)}), 500


@api_bp.route("/my/config", methods=["GET", "POST"])
@login_required
def my_config():
    try:
        if request.method == "GET":
            return jsonify({"success": True, "data": _load_user_config(current_user.id)}), 200

        payload = request.get_json(silent=True) or {}
        data = _save_user_config(current_user.id, payload)
        db.session.commit()
        return jsonify({"success": True, "data": data, "message": "saved"}), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/my/config] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/my/system_info", methods=["GET"])
@login_required
def my_system_info():
    try:
        node_ids = _owned_node_ids(current_user.id)
        online_count = sum(
            1
            for node_id in node_ids
            if node_id in active_nodes and _is_online(active_nodes.get(node_id) or {}, _now_ts())
        )
        upload_query = NodeUpload.query.filter(NodeUpload.node_id.in_(node_ids)) if node_ids else NodeUpload.query.filter(text("0=1"))
        measurement_query = (
            TurbineMeasurement.query.filter(TurbineMeasurement.node_id.in_(node_ids))
            if node_ids
            else TurbineMeasurement.query.filter(text("0=1"))
        )
        telemetry_query = (
            TelemetryRecord.query.filter(TelemetryRecord.node_id.in_(node_ids))
            if node_ids
            else TelemetryRecord.query.filter(text("0=1"))
        )
        telemetry_metric_query = (
            TelemetryMetric.query.filter(TelemetryMetric.node_id.in_(node_ids))
            if node_ids
            else TelemetryMetric.query.filter(text("0=1"))
        )
        latest_upload = upload_query.with_entities(db.func.max(NodeUpload.timestamp)).scalar() if node_ids else None
        latest_telemetry = (
            telemetry_query.with_entities(db.func.max(TelemetryRecord.timestamp)).scalar() if node_ids else None
        )
        latest_data = max((value for value in (latest_upload, latest_telemetry) if value is not None), default=None)
        legacy_record_count = int(upload_query.with_entities(db.func.count(NodeUpload.id)).scalar() or 0) if node_ids else 0
        telemetry_record_count = (
            int(telemetry_query.with_entities(db.func.count(TelemetryRecord.id)).scalar() or 0) if node_ids else 0
        )
        return jsonify(
            {
                "success": True,
                "data": {
                    "total_nodes": len(node_ids),
                    "active_nodes": int(online_count),
                    "node_uploads": legacy_record_count,
                    "turbine_measurements": int(
                        measurement_query.with_entities(db.func.count(TurbineMeasurement.id)).scalar() or 0
                    ) if node_ids else 0,
                    "telemetry_records": telemetry_record_count,
                    "telemetry_metrics": int(
                        telemetry_metric_query.with_entities(db.func.count(TelemetryMetric.id)).scalar() or 0
                    ) if node_ids else 0,
                    "total_records": legacy_record_count + telemetry_record_count,
                    "latest_upload": iso_beijing(latest_data, with_seconds=True) if latest_data else None,
                    "latest_telemetry": iso_beijing(latest_telemetry, with_seconds=True) if latest_telemetry else None,
                },
            }
        ), 200
    except Exception as exc:
        logger.exception("[/api/my/system_info] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/my/cleanup_old_data", methods=["POST"])
@login_required
def my_cleanup_old_data():
    try:
        payload = request.get_json(silent=True) or {}
        retention_days = int(payload.get("retention_days", _load_user_config(current_user.id).get("log_retention", 30)))
        if retention_days <= 0:
            return jsonify({"success": False, "error": "retention_days must be > 0"}), 400
        cutoff = _utcnow() - timedelta(days=retention_days)
        node_ids = _owned_node_ids(current_user.id)
        upload_deleted, measurement_deleted = _delete_uploads_for_node_ids(node_ids, cutoff=cutoff)
        telemetry_deleted, telemetry_metric_deleted = _delete_telemetry_for_node_ids(node_ids, cutoff=cutoff)
        db.session.commit()
        for node_id in node_ids:
            info = active_nodes.get(node_id)
            if not info:
                continue
            last_upload_utc = info.get("last_upload_utc")
            if last_upload_utc and last_upload_utc < cutoff and not _is_online(info, _now_ts()):
                active_nodes.pop(node_id, None)
        return jsonify(
            {
                "success": True,
                "details": {
                    "node_uploads_deleted": upload_deleted,
                    "turbine_measurements_deleted": measurement_deleted,
                    "telemetry_records_deleted": telemetry_deleted,
                    "telemetry_metrics_deleted": telemetry_metric_deleted,
                    "node_data_deleted": upload_deleted,
                },
            }
        ), 200
    except ValueError:
        db.session.rollback()
        return jsonify({"success": False, "error": "retention_days must be an integer"}), 400
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/my/cleanup_old_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/my/clear_data", methods=["POST"])
@login_required
def my_clear_data():
    try:
        payload = request.get_json(silent=True) or {}
        requested_node_id = _normalize_node_id(payload.get("node_id"))
        owned_ids = set(_owned_node_ids(current_user.id))
        if requested_node_id:
            if requested_node_id not in owned_ids:
                return jsonify({"success": False, "error": "registered node not found"}), 404
            node_ids = [requested_node_id]
        else:
            node_ids = sorted(owned_ids)
        upload_deleted, measurement_deleted = _delete_uploads_for_node_ids(node_ids)
        telemetry_deleted, telemetry_metric_deleted = _delete_telemetry_for_node_ids(node_ids)
        db.session.commit()
        for node_id in node_ids:
            active_nodes.pop(node_id, None)
        return jsonify(
            {
                "success": True,
                "details": {
                    "node_id": requested_node_id or "",
                    "node_uploads_deleted": upload_deleted,
                    "turbine_measurements_deleted": measurement_deleted,
                    "telemetry_records_deleted": telemetry_deleted,
                    "telemetry_metrics_deleted": telemetry_metric_deleted,
                    "node_data_deleted": upload_deleted,
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/my/clear_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/my/registered_nodes", methods=["POST"])
@login_required
def create_my_registered_node():
    try:
        payload = request.get_json(silent=True) or {}
        ok, node_id_or_error = _validate_node_id(payload.get("node_id"))
        if not ok:
            return jsonify({"success": False, "error": node_id_or_error}), 400
        node_id = node_id_or_error

        if RegisteredNode.query.filter_by(node_id=node_id).first():
            return jsonify({"success": False, "error": "node_id already registered"}), 409

        display_name = str(payload.get("display_name") or "").strip()[:120] or node_id
        upload_interval_seconds = DEFAULT_UPLOAD_INTERVAL_SECONDS
        if "upload_interval_seconds" in payload:
            try:
                upload_interval_seconds = _normalize_upload_interval_seconds(payload.get("upload_interval_seconds"))
            except ValueError as exc:
                return jsonify({"success": False, "error": str(exc)}), 400
        node_key = RegisteredNode.generate_node_key()
        registered_node = RegisteredNode(
            node_id=node_id,
            owner_user_id=current_user.id,
            display_name=display_name,
            upload_interval_seconds=upload_interval_seconds,
            is_active=True,
        )
        registered_node.set_node_key(node_key)
        db.session.add(registered_node)
        db.session.flush()
        credential, credential_secret = _create_node_credential(registered_node)
        db.session.commit()
        return (
            jsonify(
                {
                    "success": True,
                    "message": "registered",
                    "node": _registered_node_to_dict(registered_node, include_key=True),
                    "node_key": node_key,
                    "credential": _credential_public_dict(credential, include_secret=True, secret=credential_secret),
                    "warning": "node key and HMAC credential are visible on the registered node detail page",
                }
            ),
            201,
        )
    except Exception as exc:
        db.session.rollback()
        logger.exception("[POST /api/my/registered_nodes] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/my/registered_nodes/<node_id>/rotate_key", methods=["POST"])
@login_required
def rotate_my_registered_node_key(node_id):
    try:
        normalized = _normalize_node_id(node_id)
        query = RegisteredNode.query.filter_by(node_id=normalized, is_active=True)
        if not _is_admin_user():
            query = query.filter_by(owner_user_id=current_user.id)
        registered_node = query.first()
        if not registered_node:
            return jsonify({"success": False, "error": "registered node not found"}), 404

        payload = request.get_json(silent=True) or {}
        transition = str(payload.get("transition") or "").strip().lower()
        grace_hours = 24 if transition in {"grace", "keep_old_24h", "24h"} else 0
        node_key = RegisteredNode.generate_node_key()
        registered_node.set_node_key(node_key)
        credential, credential_secret = _rotate_node_credential(registered_node, grace_hours=grace_hours)
        db.session.commit()
        return (
            jsonify(
                {
                    "success": True,
                    "message": "node credential rotated",
                    "node": _registered_node_to_dict(
                        registered_node,
                        include_owner=_is_admin_user(),
                        include_key=True,
                    ),
                    "node_key": node_key,
                    "credential": _credential_public_dict(credential, include_secret=True, secret=credential_secret),
                    "transition": "grace_24h" if grace_hours else "immediate_revoke",
                    "warning": "node key and HMAC credential are visible on the registered node detail page",
                }
            ),
            200,
        )
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/my/registered_nodes/%s/rotate_key] failed: %s", node_id, exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/my/registered_nodes/<node_id>/location", methods=["PATCH"])
@login_required
def update_my_registered_node_location(node_id):
    try:
        ok, normalized_or_error = _validate_node_id(node_id)
        if not ok:
            return jsonify({"success": False, "error": normalized_or_error}), 400
        registered_node = RegisteredNode.query.filter_by(
            node_id=normalized_or_error,
            owner_user_id=current_user.id,
            is_active=True,
        ).first()
        if not registered_node:
            return jsonify({"success": False, "error": "registered node not found"}), 404

        _save_registered_node_location(registered_node, request.get_json(silent=True) or {})
        return jsonify({"success": True, "node": _registered_node_to_dict(registered_node)}), 200
    except ValueError as exc:
        db.session.rollback()
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:
        db.session.rollback()
        logger.exception("[PATCH /api/my/registered_nodes/%s/location] failed: %s", node_id, exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/my/registered_nodes/<node_id>", methods=["PATCH"])
@login_required
def update_my_registered_node(node_id):
    try:
        ok, normalized_or_error = _validate_node_id(node_id)
        if not ok:
            return jsonify({"success": False, "error": normalized_or_error}), 400
        registered_node = RegisteredNode.query.filter_by(
            node_id=normalized_or_error,
            owner_user_id=current_user.id,
            is_active=True,
        ).first()
        if not registered_node:
            return jsonify({"success": False, "error": "registered node not found"}), 404

        payload = request.get_json(silent=True) or {}
        if "display_name" in payload:
            registered_node.display_name = _normalize_node_display_name(
                payload.get("display_name"),
                registered_node.node_id,
            )
        if "upload_interval_seconds" in payload:
            registered_node.upload_interval_seconds = _normalize_upload_interval_seconds(payload.get("upload_interval_seconds"))
        db.session.commit()
        return jsonify({"success": True, "node": _registered_node_to_dict(registered_node, include_key=True)}), 200
    except ValueError as exc:
        db.session.rollback()
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:
        db.session.rollback()
        logger.exception("[PATCH /api/my/registered_nodes/%s] failed: %s", node_id, exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/my/registered_nodes/<node_id>", methods=["DELETE"])
@login_required
def delete_my_registered_node(node_id):
    try:
        ok, normalized_or_error = _validate_node_id(node_id)
        if not ok:
            return jsonify({"success": False, "error": normalized_or_error}), 400
        registered_node = RegisteredNode.query.filter_by(
            node_id=normalized_or_error,
            owner_user_id=current_user.id,
            is_active=True,
        ).first()
        if not registered_node:
            return jsonify({"success": False, "error": "registered node not found"}), 404

        upload_deleted, measurement_deleted = _delete_uploads_for_node_ids([registered_node.node_id])
        telemetry_deleted, telemetry_metric_deleted = _delete_telemetry_for_node_ids([registered_node.node_id])
        deleted_node_id = registered_node.node_id
        db.session.delete(registered_node)
        db.session.commit()
        active_nodes.pop(deleted_node_id, None)
        return jsonify(
            {
                "success": True,
                "deleted_node_id": deleted_node_id,
                "details": {
                    "node_uploads_deleted": upload_deleted,
                    "turbine_measurements_deleted": measurement_deleted,
                    "telemetry_records_deleted": telemetry_deleted,
                    "telemetry_metrics_deleted": telemetry_metric_deleted,
                    "node_data_deleted": upload_deleted,
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[DELETE /api/my/registered_nodes/%s] failed: %s", node_id, exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/users", methods=["GET"])
@admin_required
def admin_users():
    try:
        users = User.query.options(selectinload(User.registered_nodes)).order_by(User.id.asc()).all()
        return jsonify({"success": True, "users": [_user_to_admin_dict(user) for user in users]}), 200
    except Exception as exc:
        logger.exception("[/api/admin/users] failed: %s", exc)
        return jsonify({"success": False, "users": [], "error": str(exc)}), 500


@api_bp.route("/admin/users/<int:user_id>", methods=["DELETE"])
@admin_required
def admin_delete_user(user_id: int):
    try:
        user = db.session.get(User, user_id)
        if not user:
            return jsonify({"success": False, "error": "user not found"}), 404
        if user.id == current_user.id:
            return jsonify({"success": False, "error": "current admin cannot be deleted"}), 400
        if (user.role or "user") == "admin":
            return jsonify({"success": False, "error": "admin user cannot be deleted"}), 400

        deleted_username = user.username
        RegistrationInvite.query.filter(RegistrationInvite.created_by_user_id == user.id).update(
            {RegistrationInvite.created_by_user_id: None},
            synchronize_session=False,
        )
        RegistrationInvite.query.filter(RegistrationInvite.used_by_user_id == user.id).update(
            {RegistrationInvite.used_by_user_id: None},
            synchronize_session=False,
        )
        node_ids = [
            _normalize_node_id(row[0])
            for row in RegisteredNode.query.filter_by(owner_user_id=user.id)
            .with_entities(RegisteredNode.node_id)
            .all()
        ]
        deleted_nodes = len(node_ids)
        # RegisteredNode has no foreign key from historical data tables, so
        # explicitly remove both legacy and generic telemetry before deleting
        # the owner and its cascade-related node records.
        upload_deleted, measurement_deleted = _delete_uploads_for_node_ids(node_ids)
        telemetry_deleted, telemetry_metric_deleted = _delete_telemetry_for_node_ids(node_ids)
        db.session.delete(user)
        db.session.commit()
        for node_id in node_ids:
            active_nodes.pop(node_id, None)
        return (
            jsonify(
                {
                    "success": True,
                    "deleted_user_id": user_id,
                    "deleted_username": deleted_username,
                    "deleted_nodes": int(deleted_nodes or 0),
                    "details": {
                        "node_uploads_deleted": upload_deleted,
                        "turbine_measurements_deleted": measurement_deleted,
                        "telemetry_records_deleted": telemetry_deleted,
                        "telemetry_metrics_deleted": telemetry_metric_deleted,
                    },
                }
            ),
            200,
        )
    except Exception as exc:
        db.session.rollback()
        logger.exception("[DELETE /api/admin/users/%s] failed: %s", user_id, exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/invitations", methods=["GET", "POST"])
@admin_required
def admin_invitations():
    try:
        if request.method == "GET":
            now = _utcnow()
            rows = (
                RegistrationInvite.query.options(
                    selectinload(RegistrationInvite.created_by),
                    selectinload(RegistrationInvite.used_by),
                )
                .filter(RegistrationInvite.revoked_at.is_(None))
                .order_by(RegistrationInvite.created_at.desc(), RegistrationInvite.id.desc())
                .limit(200)
                .all()
            )
            return jsonify({"success": True, "invitations": [_invite_to_admin_dict(row, now) for row in rows]}), 200

        payload = request.get_json(silent=True) or {}
        try:
            count = int(payload.get("count", 1))
        except Exception:
            return jsonify({"success": False, "error": "count must be an integer"}), 400
        if count < 1 or count > MAX_INVITE_BATCH_COUNT:
            return jsonify({"success": False, "error": f"count must be between 1 and {MAX_INVITE_BATCH_COUNT}"}), 400

        try:
            expires_days = int(payload.get("expires_days", DEFAULT_INVITE_EXPIRES_DAYS))
        except Exception:
            return jsonify({"success": False, "error": "expires_days must be an integer"}), 400
        if expires_days < 1 or expires_days > 365:
            return jsonify({"success": False, "error": "expires_days must be between 1 and 365"}), 400

        now = _utcnow()
        expires_at = now + timedelta(days=expires_days)
        generated_codes = set()
        invitations = []
        for _ in range(count):
            code = ""
            for _attempt in range(30):
                candidate = RegistrationInvite.generate_code()
                if candidate in generated_codes:
                    continue
                if not RegistrationInvite.query.filter_by(code=candidate).first():
                    code = candidate
                    break
            if not code:
                raise RuntimeError("failed to generate unique invitation code")
            generated_codes.add(code)
            invite = RegistrationInvite(
                code=code,
                created_by_user_id=current_user.id,
                created_at=now,
                expires_at=expires_at,
            )
            db.session.add(invite)
            invitations.append(invite)

        db.session.commit()
        return jsonify({"success": True, "invitations": [_invite_to_admin_dict(row, now) for row in invitations]}), 201
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/invitations] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/invitations/<int:invite_id>/revoke", methods=["POST"])
@admin_required
def admin_revoke_invitation(invite_id: int):
    try:
        invite = db.session.get(RegistrationInvite, invite_id)
        if not invite:
            return jsonify({"success": False, "error": "invitation not found"}), 404
        if invite.used_at:
            return jsonify({"success": False, "error": "used invitation cannot be deleted"}), 400
        deleted_id = invite.id
        db.session.delete(invite)
        db.session.commit()
        return jsonify({"success": True, "deleted_id": deleted_id}), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/invitations/%s/revoke] failed: %s", invite_id, exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/users/<int:user_id>/registered_nodes", methods=["GET"])
@admin_required
def admin_user_registered_nodes(user_id: int):
    try:
        user = db.session.get(User, user_id, options=[selectinload(User.registered_nodes)])
        if not user:
            return jsonify({"success": False, "error": "user not found"}), 404
        nodes = (
            RegisteredNode.query.filter_by(owner_user_id=user.id, is_active=True)
            .order_by(RegisteredNode.node_id.asc())
            .all()
        )
        return (
            jsonify(
                {
                    "success": True,
                    "user": _user_to_admin_dict(user),
                    "nodes": [_registered_node_to_dict(node, include_auth=True) for node in nodes],
                }
            ),
            200,
        )
    except Exception as exc:
        logger.exception("[/api/admin/users/%s/registered_nodes] failed: %s", user_id, exc)
        return jsonify({"success": False, "nodes": [], "error": str(exc)}), 500


@api_bp.route("/admin/users/<int:user_id>/registered_nodes/<node_id>/credentials/revoke", methods=["POST"])
@admin_required
def admin_revoke_registered_node_credentials(user_id: int, node_id):
    try:
        user = db.session.get(User, user_id)
        if not user:
            return jsonify({"success": False, "error": "user not found"}), 404
        ok, normalized_or_error = _validate_node_id(node_id)
        if not ok:
            return jsonify({"success": False, "error": normalized_or_error}), 400
        registered_node = RegisteredNode.query.filter_by(
            node_id=normalized_or_error,
            owner_user_id=user.id,
            is_active=True,
        ).first()
        if not registered_node:
            return jsonify({"success": False, "error": "registered node not found"}), 404

        now = _utcnow()
        revoked_count = 0
        for credential in list(getattr(registered_node, "credentials", []) or []):
            if credential.status in {NodeCredential.STATUS_ACTIVE, NodeCredential.STATUS_GRACE}:
                credential.status = NodeCredential.STATUS_REVOKED
                credential.revoked_at = now
                credential.expires_at = now
                revoked_count += 1
        db.session.commit()
        return jsonify(
            {
                "success": True,
                "revoked_count": revoked_count,
                "node": _registered_node_to_dict(registered_node, include_owner=True, include_auth=True),
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception(
            "[POST /api/admin/users/%s/registered_nodes/%s/credentials/revoke] failed: %s",
            user_id,
            node_id,
            exc,
        )
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/users/<int:user_id>/registered_nodes/<node_id>", methods=["PATCH"])
@admin_required
def admin_update_registered_node(user_id: int, node_id):
    try:
        user = db.session.get(User, user_id)
        if not user:
            return jsonify({"success": False, "error": "user not found"}), 404
        ok, normalized_or_error = _validate_node_id(node_id)
        if not ok:
            return jsonify({"success": False, "error": normalized_or_error}), 400
        registered_node = RegisteredNode.query.filter_by(
            node_id=normalized_or_error,
            owner_user_id=user.id,
            is_active=True,
        ).first()
        if not registered_node:
            return jsonify({"success": False, "error": "registered node not found"}), 404

        payload = request.get_json(silent=True) or {}
        if "display_name" in payload:
            registered_node.display_name = _normalize_node_display_name(
                payload.get("display_name"),
                registered_node.node_id,
            )
        if "upload_interval_seconds" in payload:
            registered_node.upload_interval_seconds = _normalize_upload_interval_seconds(payload.get("upload_interval_seconds"))
        db.session.commit()
        return (
            jsonify({"success": True, "node": _registered_node_to_dict(registered_node, include_owner=True, include_auth=True)}),
            200,
        )
    except ValueError as exc:
        db.session.rollback()
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:
        db.session.rollback()
        logger.exception(
            "[PATCH /api/admin/users/%s/registered_nodes/%s] failed: %s",
            user_id,
            node_id,
            exc,
        )
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/users/<int:user_id>/registered_nodes/<node_id>/location", methods=["PATCH"])
@admin_required
def admin_update_registered_node_location(user_id: int, node_id):
    try:
        user = db.session.get(User, user_id)
        if not user:
            return jsonify({"success": False, "error": "user not found"}), 404
        ok, normalized_or_error = _validate_node_id(node_id)
        if not ok:
            return jsonify({"success": False, "error": normalized_or_error}), 400
        registered_node = RegisteredNode.query.filter_by(
            node_id=normalized_or_error,
            owner_user_id=user.id,
            is_active=True,
        ).first()
        if not registered_node:
            return jsonify({"success": False, "error": "registered node not found"}), 404

        _save_registered_node_location(registered_node, request.get_json(silent=True) or {})
        return (
            jsonify({"success": True, "node": _registered_node_to_dict(registered_node, include_owner=True)}),
            200,
        )
    except ValueError as exc:
        db.session.rollback()
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:
        db.session.rollback()
        logger.exception(
            "[PATCH /api/admin/users/%s/registered_nodes/%s/location] failed: %s",
            user_id,
            node_id,
            exc,
        )
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/node_data", methods=["GET"])
@login_required
def get_node_data():
    try:
        node_id = (request.args.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"success": False, "error": "missing node_id"}), 400
        node_id = _normalize_node_id(node_id)
        if not _can_access_node(node_id):
            return jsonify({"success": False, "error": "node access denied"}), 403

        limit = max(1, min(int(request.args.get("limit", 600)), MAX_HISTORY_LIMIT))
        turbine_code = _normalize_turbine_code_param(request.args.get("turbine") or request.args.get("turbine_code"))
        start_utc = parse_client_datetime_to_utc(request.args.get("start") or request.args.get("start_time"))
        end_utc = parse_client_datetime_to_utc(request.args.get("end") or request.args.get("end_time"))
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"success": False, "error": "invalid time range"}), 400

        rows = _get_filtered_rows(node_id, limit, start_utc, end_utc, turbine_code)
        upload_interval = _node_upload_interval_seconds(node_id)
        return jsonify(
            {
                "success": True,
                "node_id": node_id,
                "turbine": turbine_code,
                "expected_interval_seconds": upload_interval,
                "gap_threshold_seconds": _node_gap_threshold_seconds(upload_interval),
                "data": _upload_rows_to_dicts(node_id, rows),
            }
        ), 200
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
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
        node_id = _normalize_node_id(node_id)
        if not _can_access_node(node_id):
            return jsonify({"status": "error", "error": "node access denied"}), 403

        limit = max(1, min(int(request.args.get("limit", 600)), MAX_HISTORY_LIMIT))
        turbine_code = _normalize_turbine_code_param(request.args.get("turbine") or request.args.get("turbine_code"))
        start_utc = parse_client_datetime_to_utc(request.args.get("start") or request.args.get("start_time"))
        end_utc = parse_client_datetime_to_utc(request.args.get("end") or request.args.get("end_time"))
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"status": "error", "error": "invalid time range"}), 400

        rows = _get_filtered_rows(node_id, limit, start_utc, end_utc, turbine_code)
        upload_interval = _node_upload_interval_seconds(node_id)
        return jsonify(
            {
                "status": "success",
                "node_id": node_id,
                "turbine": turbine_code,
                "expected_interval_seconds": upload_interval,
                "gap_threshold_seconds": _node_gap_threshold_seconds(upload_interval),
                "data": _upload_rows_to_dicts(node_id, rows),
            }
        ), 200
    except ValueError as exc:
        return jsonify({"status": "error", "error": str(exc)}), 400
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
        node_id = _normalize_node_id(node_id)
        if not _can_access_node(node_id):
            return jsonify({"status": "error", "error": "node access denied"}), 403

        mode = (request.args.get("mode") or "").strip().lower()
        if mode not in ("nth", "nth_before", "count"):
            return jsonify({"status": "error", "error": "mode must be nth, nth_before or count"}), 400

        turbine_code = _normalize_turbine_code_param(request.args.get("turbine") or request.args.get("turbine_code"))
        start_utc = parse_client_datetime_to_utc(request.args.get("start") or request.args.get("start_time"))
        end_utc = parse_client_datetime_to_utc(request.args.get("end") or request.args.get("end_time"))
        if start_utc and end_utc and start_utc > end_utc:
            return jsonify({"status": "error", "error": "invalid time range"}), 400

        query = _apply_time_filters(NodeUpload.query.filter_by(node_id=node_id), start_utc, end_utc)
        query = _apply_turbine_filter(query, turbine_code)
        total_count = int(query.count())

        if mode == "count":
            if not start_utc or not end_utc:
                return jsonify({"status": "error", "error": "count mode requires start and end"}), 400
            return jsonify(
                {
                    "status": "success",
                    "node_id": node_id,
                    "turbine": turbine_code,
                    "mode": "count",
                    "count": total_count,
                    "start": iso_beijing(start_utc, with_seconds=True, with_ms=True),
                    "end": iso_beijing(end_utc, with_seconds=True, with_ms=True),
                }
            ), 200

        requested = max(1, min(int(request.args.get("limit", 0) or 0), MAX_HISTORY_LIMIT))

        if mode == "nth_before":
            if not end_utc:
                return jsonify({"status": "error", "error": "nth_before mode requires end"}), 400
            nth_row = query.order_by(NodeUpload.timestamp.desc(), NodeUpload.id.desc()).offset(requested - 1).limit(1).first()
            first_row = query.order_by(NodeUpload.timestamp.asc(), NodeUpload.id.asc()).first() if total_count > 0 else None
            last_row = query.order_by(NodeUpload.timestamp.desc(), NodeUpload.id.desc()).first() if total_count > 0 else None
            return jsonify(
                {
                    "status": "success",
                    "node_id": node_id,
                    "turbine": turbine_code,
                    "mode": "nth_before",
                    "requested": requested,
                    "count": total_count,
                    "nth_ts": iso_beijing(nth_row.timestamp, with_seconds=True, with_ms=True) if nth_row else None,
                    "first_ts": iso_beijing(first_row.timestamp, with_seconds=True, with_ms=True) if first_row else None,
                    "last_ts": iso_beijing(last_row.timestamp, with_seconds=True, with_ms=True) if last_row else None,
                }
            ), 200

        if not start_utc:
            return jsonify({"status": "error", "error": "nth mode requires start"}), 400

        nth_row = query.order_by(NodeUpload.timestamp.asc(), NodeUpload.id.asc()).offset(requested - 1).limit(1).first()
        first_row = query.order_by(NodeUpload.timestamp.asc(), NodeUpload.id.asc()).first() if total_count > 0 else None
        last_row = query.order_by(NodeUpload.timestamp.desc(), NodeUpload.id.desc()).first() if total_count > 0 else None
        return jsonify(
            {
                "status": "success",
                "node_id": node_id,
                "turbine": turbine_code,
                "mode": "nth",
                "requested": requested,
                "count": total_count,
                "nth_ts": iso_beijing(nth_row.timestamp, with_seconds=True, with_ms=True) if nth_row else None,
                "first_ts": iso_beijing(first_row.timestamp, with_seconds=True, with_ms=True) if first_row else None,
                "last_ts": iso_beijing(last_row.timestamp, with_seconds=True, with_ms=True) if last_row else None,
            }
        ), 200
    except ValueError as exc:
        return jsonify({"status": "error", "error": str(exc)}), 400
    except Exception as exc:
        logger.exception("[/api/data_meta] failed: %s", exc)
        return jsonify({"status": "error", "error": str(exc)}), 500


def _parse_telemetry_fields(raw_value) -> list[str]:
    """Parse the comma-separated field selector used by telemetry history."""

    if raw_value is None:
        return []
    raw_value = str(raw_value)
    # Field paths escape commas (and other path punctuation) with a backslash;
    # split only on delimiters that are not themselves escaped.  The escaped
    # spelling is retained so it matches the path stored in TelemetryMetric.
    chunks = []
    current = []
    escaped = False
    for char in raw_value:
        if char == "," and not escaped:
            chunks.append("".join(current))
            current = []
            continue
        current.append(char)
        if char == "\\" and not escaped:
            escaped = True
        else:
            escaped = False
    chunks.append("".join(current))

    fields = []
    seen = set()
    for value in chunks:
        path = value.strip()
        if not path or path in seen:
            continue
        if len(path) > 1024:
            raise ValueError("telemetry field path is too long")
        seen.add(path)
        fields.append(path)
    if len(fields) > 200:
        raise ValueError("at most 200 telemetry fields may be requested")
    return fields


def _telemetry_time_range_from_request() -> tuple[datetime | None, datetime | None]:
    start_utc = parse_client_datetime_to_utc(request.args.get("start") or request.args.get("start_time"))
    end_utc = parse_client_datetime_to_utc(request.args.get("end") or request.args.get("end_time"))
    if start_utc and end_utc and start_utc > end_utc:
        raise ValueError("invalid time range")
    return start_utc, end_utc


def _apply_telemetry_time_filters(query, start_utc, end_utc):
    if start_utc:
        query = query.filter(TelemetryRecord.timestamp >= start_utc)
    if end_utc:
        query = query.filter(TelemetryRecord.timestamp <= end_utc)
    return query


def _telemetry_field_schema_from_latest_record(node_id: str) -> dict[str, dict[str, str]]:
    """Read optional display metadata from the newest generic telemetry frame.

    Schema metadata deliberately stays inside the original JSON packet instead
    of adding a database column.  Devices can therefore revise labels or units
    on later frames, and the fields endpoint always reflects the most recently
    received declaration for that source.
    """

    latest_record = (
        TelemetryRecord.query.filter_by(node_id=node_id)
        .order_by(TelemetryRecord.timestamp.desc(), TelemetryRecord.id.desc())
        .first()
    )
    if not latest_record:
        return {}

    raw_schema = latest_record.payload_dict().get("telemetry_schema")
    if not isinstance(raw_schema, dict):
        return {}

    schema: dict[str, dict[str, str]] = {}
    for raw_path, raw_metadata in raw_schema.items():
        path = str(raw_path or "").strip()
        if not path or not isinstance(raw_metadata, dict):
            continue

        def _text(key: str) -> str:
            value = raw_metadata.get(key)
            return value.strip() if isinstance(value, str) else ""

        label = _text("label") or path
        schema[path] = {
            "label": label,
            "unit": _text("unit"),
            "semantic": _text("semantic"),
        }
    return schema


def _telemetry_field_descriptors(node_id: str, paths=None) -> list[dict[str, str]]:
    """Build compact field descriptors for node-tree and telemetry clients.

    ``paths`` can be supplied by the statistics query used by
    ``/api/telemetry/fields``.  When omitted, the distinct paths are read from
    the generic metric rows for this node.  Schema-only entries are not exposed
    as fields until a numeric value for that path has actually arrived.
    """

    if paths is None:
        paths = [
            row[0]
            for row in (
                db.session.query(TelemetryMetric.path)
                .filter(TelemetryMetric.node_id == node_id)
                .distinct()
                .order_by(TelemetryMetric.path.asc())
                .all()
            )
        ]

    schema = _telemetry_field_schema_from_latest_record(node_id)
    descriptors = []
    seen = set()
    for raw_path in paths:
        path = str(raw_path or "").strip()
        if not path or path in seen:
            continue
        seen.add(path)
        metadata = schema.get(path) or {}
        descriptors.append(
            {
                "path": path,
                "label": metadata.get("label") or path,
                "unit": metadata.get("unit") or "",
                "semantic": metadata.get("semantic") or "",
            }
        )
    return descriptors


@api_bp.route("/telemetry/sources", methods=["GET"])
@login_required
def telemetry_sources():
    """List generic telemetry sources visible to the current account."""

    try:
        node_ids = sorted(_accessible_node_ids_for_current_user())
        if not node_ids:
            return jsonify({"success": True, "status": "success", "sources": [], "count": 0}), 200

        record_rows = (
            db.session.query(
                TelemetryRecord.node_id,
                db.func.count(TelemetryRecord.id).label("record_count"),
                db.func.max(TelemetryRecord.timestamp).label("latest_timestamp"),
            )
            .filter(TelemetryRecord.node_id.in_(node_ids))
            .group_by(TelemetryRecord.node_id)
            .order_by(TelemetryRecord.node_id.asc())
            .all()
        )
        metric_counts = {
            row[0]: int(row[1] or 0)
            for row in (
                db.session.query(
                    TelemetryMetric.node_id,
                    db.func.count(db.func.distinct(TelemetryMetric.path)),
                )
                .filter(TelemetryMetric.node_id.in_(node_ids))
                .group_by(TelemetryMetric.node_id)
                .all()
            )
        }
        sources = [
            {
                "node_id": row.node_id,
                "record_count": int(row.record_count or 0),
                "field_count": int(metric_counts.get(row.node_id, 0)),
                "latest_timestamp": (
                    iso_beijing(row.latest_timestamp, with_seconds=True, with_ms=True)
                    if row.latest_timestamp
                    else None
                ),
            }
            for row in record_rows
        ]
        return jsonify({"success": True, "status": "success", "sources": sources, "count": len(sources)}), 200
    except Exception as exc:
        logger.exception("[/api/telemetry/sources] failed: %s", exc)
        return jsonify({"success": False, "status": "error", "sources": [], "error": str(exc)}), 500


@api_bp.route("/telemetry/fields", methods=["GET"])
@login_required
def telemetry_fields():
    """Return discoverable numeric field paths and aggregate metadata for one source."""

    try:
        node_id = _normalize_node_id(request.args.get("node_id"))
        if not node_id:
            return _json_error("missing node_id")
        if not _can_access_node(node_id):
            return _json_error("node access denied", 403, "node_access_denied")
        start_utc, end_utc = _telemetry_time_range_from_request()

        query = TelemetryMetric.query.filter(TelemetryMetric.node_id == node_id)
        if start_utc:
            query = query.filter(TelemetryMetric.timestamp >= start_utc)
        if end_utc:
            query = query.filter(TelemetryMetric.timestamp <= end_utc)
        rows = (
            query.with_entities(
                TelemetryMetric.path.label("path"),
                db.func.count(TelemetryMetric.id).label("count"),
                db.func.min(TelemetryMetric.value).label("min_value"),
                db.func.max(TelemetryMetric.value).label("max_value"),
                db.func.min(TelemetryMetric.timestamp).label("first_seen"),
                db.func.max(TelemetryMetric.timestamp).label("last_seen"),
            )
            .group_by(TelemetryMetric.path)
            .order_by(TelemetryMetric.path.asc())
            .all()
        )
        descriptors = {
            field["path"]: field
            for field in _telemetry_field_descriptors(node_id, [row.path for row in rows])
        }
        fields = [
            {
                "path": row.path,
                "label": descriptors.get(row.path, {}).get("label", row.path),
                "unit": descriptors.get(row.path, {}).get("unit", ""),
                "semantic": descriptors.get(row.path, {}).get("semantic", ""),
                "count": int(row.count or 0),
                "min": float(row.min_value),
                "max": float(row.max_value),
                "first_seen": iso_beijing(row.first_seen, with_seconds=True, with_ms=True) if row.first_seen else None,
                "last_seen": iso_beijing(row.last_seen, with_seconds=True, with_ms=True) if row.last_seen else None,
            }
            for row in rows
        ]
        return jsonify(
            {
                "success": True,
                "status": "success",
                "node_id": node_id,
                "fields": fields,
                "count": len(fields),
                "start": iso_beijing(start_utc, with_seconds=True, with_ms=True) if start_utc else None,
                "end": iso_beijing(end_utc, with_seconds=True, with_ms=True) if end_utc else None,
            }
        ), 200
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("[/api/telemetry/fields] failed: %s", exc)
        return jsonify({"success": False, "status": "error", "fields": [], "error": str(exc)}), 500


@api_bp.route("/telemetry/history", methods=["GET"])
@login_required
def telemetry_history():
    """Read generic telemetry frames in chronological order for charting or export."""

    try:
        node_id = _normalize_node_id(request.args.get("node_id"))
        if not node_id:
            return _json_error("missing node_id")
        if not _can_access_node(node_id):
            return _json_error("node access denied", 403, "node_access_denied")
        start_utc, end_utc = _telemetry_time_range_from_request()
        fields = _parse_telemetry_fields(request.args.get("fields"))
        limit = max(1, min(int(request.args.get("limit", 600)), MAX_HISTORY_LIMIT))

        query = _apply_telemetry_time_filters(
            TelemetryRecord.query.options(selectinload(TelemetryRecord.metrics)).filter_by(node_id=node_id),
            start_utc,
            end_utc,
        )
        if start_utc:
            records = query.order_by(TelemetryRecord.timestamp.asc(), TelemetryRecord.id.asc()).limit(limit).all()
        else:
            records = query.order_by(TelemetryRecord.timestamp.desc(), TelemetryRecord.id.desc()).limit(limit).all()
            records.reverse()
        data = [record.to_dict(fields) for record in records]
        return jsonify(
            {
                "success": True,
                "status": "success",
                "node_id": node_id,
                "fields": fields,
                "count": len(data),
                "limit": limit,
                "records": data,
                "data": data,
            }
        ), 200
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("[/api/telemetry/history] failed: %s", exc)
        return jsonify({"success": False, "status": "error", "records": [], "data": [], "error": str(exc)}), 500


@api_bp.route("/dashboard/stats", methods=["GET"])
@login_required
def dashboard_stats():
    try:
        now_ts = _now_ts()
        all_ids = _accessible_node_ids_for_current_user()
        online_ids = [node_id for node_id in all_ids if _is_online(active_nodes.get(node_id) or {}, now_ts)]
        upload_query = NodeUpload.query
        if all_ids:
            upload_query = upload_query.filter(NodeUpload.node_id.in_(all_ids))
        else:
            upload_query = upload_query.filter(text("1=0"))
        telemetry_query = TelemetryRecord.query
        if all_ids:
            telemetry_query = telemetry_query.filter(TelemetryRecord.node_id.in_(all_ids))
        else:
            telemetry_query = telemetry_query.filter(text("1=0"))
        legacy_latest_ts = upload_query.with_entities(db.func.max(NodeUpload.timestamp)).scalar()
        telemetry_latest_ts = telemetry_query.with_entities(db.func.max(TelemetryRecord.timestamp)).scalar()
        latest_ts = max((value for value in (legacy_latest_ts, telemetry_latest_ts) if value is not None), default=None)
        legacy_total_records = upload_query.with_entities(db.func.count(NodeUpload.id)).scalar() or 0
        telemetry_total_records = telemetry_query.with_entities(db.func.count(TelemetryRecord.id)).scalar() or 0
        legacy_records_24h = upload_query.filter(NodeUpload.timestamp >= (_utcnow() - timedelta(hours=24))).with_entities(
            db.func.count(NodeUpload.id)
        ).scalar() or 0
        telemetry_records_24h = telemetry_query.filter(
            TelemetryRecord.timestamp >= (_utcnow() - timedelta(hours=24))
        ).with_entities(db.func.count(TelemetryRecord.id)).scalar() or 0

        db_uri = (app_instance.config.get("SQLALCHEMY_DATABASE_URI") if app_instance else "") or ""
        db_size_mb = 0.0
        sqlite_path = _resolve_sqlite_path(_sqlite_db_path_from_uri(db_uri))
        if sqlite_path is not None and sqlite_path.exists():
            db_size_mb = round(sqlite_path.stat().st_size / (1024 * 1024), 2)

        return jsonify(
            {
                "total_nodes": int(len(all_ids)),
                "online_nodes": int(len(online_ids)),
                "total_records": int(legacy_total_records + telemetry_total_records),
                "records_24h": int(legacy_records_24h + telemetry_records_24h),
                "node_uploads": int(legacy_total_records),
                "telemetry_records": int(telemetry_total_records),
                "latest_upload": iso_beijing(latest_ts) if latest_ts else None,
                "database_size_mb": float(db_size_mb),
                "node_timeout_sec": int(get_node_timeout_seconds()),
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
        allowed_ids = _accessible_node_ids_for_current_user()
        nodes = []
        for node_id, info in list(active_nodes.items()):
            if _normalize_node_id(node_id) not in allowed_ids:
                continue
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
        registered_nodes = _registered_node_query_for_current_user().order_by(RegisteredNode.node_id.asc()).all()
        devices = []
        for registered_node in registered_nodes:
            node_id = registered_node.node_id
            info = active_nodes.get(node_id) or {}
            latest_upload = _load_latest_upload(node_id)
            last_ts = registered_node.last_seen_at or (latest_upload.timestamp if latest_upload else None)
            turbine_codes = _merge_turbine_codes(
                info.get("turbines"),
                latest_upload.turbine_codes() if latest_upload else [],
                _load_node_turbine_codes(node_id) if latest_upload else [],
            )
            devices.append(
                {
                    "device_id": node_id,
                    "location": registered_node.display_name or node_id,
                    "status": "online" if _is_online(info, now_ts) else "offline",
                    "last_heartbeat": iso_beijing(last_ts) if last_ts else None,
                    "turbine_count": int(
                        len(turbine_codes)
                        or info.get("turbine_count")
                        or (latest_upload.turbine_count if latest_upload else 0)
                        or 0
                    ),
                }
            )
        return jsonify({"success": True, "devices": devices}), 200
    except Exception as exc:
        logger.exception("[/api/devices] failed: %s", exc)
        return jsonify({"success": False, "devices": [], "error": str(exc)}), 500


@api_bp.route("/admin/system_info", methods=["GET"])
@admin_required
def admin_system_info():
    try:
        version = os.environ.get("WINDSIGHT_VERSION", "v2.0.0")
        async_mode = getattr(socketio_instance, "async_mode", None) if socketio_instance else None

        db_uri = (app_instance.config.get("SQLALCHEMY_DATABASE_URI") if app_instance else "") or ""
        sqlite_path = _resolve_sqlite_path(_sqlite_db_path_from_uri(db_uri))
        sizes = _sqlite_file_sizes_mb(sqlite_path)

        now_ts = _now_ts()
        registered_ids = {
            _normalize_node_id(row[0])
            for row in RegisteredNode.query.filter_by(is_active=True).with_entities(RegisteredNode.node_id).all()
        }
        online_count = len(
            [
                node_id
                for node_id, info in list(active_nodes.items())
                if _normalize_node_id(node_id) in registered_ids and _is_online(info, now_ts)
            ]
        )
        total_nodes = len(registered_ids)
        legacy_rows = db.session.query(db.func.count(NodeUpload.id)).scalar() or 0
        telemetry_rows = db.session.query(db.func.count(TelemetryRecord.id)).scalar() or 0
        telemetry_metric_rows = db.session.query(db.func.count(TelemetryMetric.id)).scalar() or 0

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
                    "total_records": int(legacy_rows + telemetry_rows),
                    "node_uploads": int(legacy_rows),
                    "telemetry_records": int(telemetry_rows),
                    "telemetry_metrics": int(telemetry_metric_rows),
                    "async_mode": async_mode or os.environ.get("FORCE_ASYNC_MODE", "auto"),
                    "python_version": sys.version.split()[0],
                },
            }
        ), 200
    except Exception as exc:
        logger.exception("[/api/admin/system_info] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/config", methods=["GET", "POST"])
@admin_required
def admin_config():
    keys = ["poll_interval", "auto_refresh", "show_debug_log", "log_retention", "node_timeout_seconds", "upload_auth_required"]
    try:
        if request.method == "GET":
            data = {
                "node_timeout_seconds": get_node_timeout_seconds(),
                "upload_auth_required": get_upload_auth_required(),
            }
            for key in keys:
                row = SystemConfig.query.filter_by(key=key).first()
                if row and row.value is not None:
                    try:
                        data[key] = json.loads(row.value)
                    except Exception:
                        data[key] = row.value
            return jsonify({"success": True, "data": data}), 200

        payload = request.get_json(silent=True) or {}
        if "node_timeout_seconds" in payload:
            try:
                payload["node_timeout_seconds"] = int(payload.get("node_timeout_seconds"))
                if payload["node_timeout_seconds"] < 1 or payload["node_timeout_seconds"] > 86400:
                    raise ValueError
            except Exception:
                return jsonify({"success": False, "error": "node_timeout_seconds must be an integer between 1 and 86400"}), 400
        if "upload_auth_required" in payload:
            value = payload.get("upload_auth_required")
            if isinstance(value, str):
                payload["upload_auth_required"] = value.strip().lower() not in {"0", "false", "off", "no"}
            else:
                payload["upload_auth_required"] = bool(value)

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
@admin_required
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
        telemetry_metric_deleted = TelemetryMetric.query.filter(
            TelemetryMetric.timestamp < cutoff
        ).delete(synchronize_session=False)
        telemetry_deleted = TelemetryRecord.query.filter(TelemetryRecord.timestamp < cutoff).delete(
            synchronize_session=False
        )
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
                    "telemetry_records_deleted": int(telemetry_deleted or 0),
                    "telemetry_metrics_deleted": int(telemetry_metric_deleted or 0),
                    "node_data_deleted": int(upload_deleted or 0),
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/cleanup_old_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/clear_all_data", methods=["POST"])
@admin_required
def admin_clear_all_data():
    try:
        measurement_deleted = TurbineMeasurement.query.delete(synchronize_session=False)
        upload_deleted = NodeUpload.query.delete(synchronize_session=False)
        telemetry_metric_deleted = TelemetryMetric.query.delete(synchronize_session=False)
        telemetry_deleted = TelemetryRecord.query.delete(synchronize_session=False)
        db.session.commit()
        active_nodes.clear()
        return jsonify(
            {
                "success": True,
                "details": {
                    "node_uploads_deleted": int(upload_deleted or 0),
                    "turbine_measurements_deleted": int(measurement_deleted or 0),
                    "telemetry_records_deleted": int(telemetry_deleted or 0),
                    "telemetry_metrics_deleted": int(telemetry_metric_deleted or 0),
                    "node_data_deleted": int(upload_deleted or 0),
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/clear_all_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/delete_node_data", methods=["POST"])
@admin_required
def admin_delete_node_data():
    try:
        payload = request.get_json(silent=True) or {}
        node_id = _normalize_node_id(payload.get("node_id"))
        if not node_id:
            return jsonify({"success": False, "error": "missing node_id"}), 400

        measurement_deleted = TurbineMeasurement.query.filter(
            TurbineMeasurement.node_id == node_id
        ).delete(synchronize_session=False)
        upload_deleted = NodeUpload.query.filter(NodeUpload.node_id == node_id).delete(synchronize_session=False)
        telemetry_metric_deleted = TelemetryMetric.query.filter(
            TelemetryMetric.node_id == node_id
        ).delete(synchronize_session=False)
        telemetry_deleted = TelemetryRecord.query.filter(TelemetryRecord.node_id == node_id).delete(
            synchronize_session=False
        )
        db.session.commit()
        active_nodes.pop(node_id, None)

        return jsonify(
            {
                "success": True,
                "details": {
                    "node_id": node_id,
                    "node_uploads_deleted": int(upload_deleted or 0),
                    "turbine_measurements_deleted": int(measurement_deleted or 0),
                    "telemetry_records_deleted": int(telemetry_deleted or 0),
                    "telemetry_metrics_deleted": int(telemetry_metric_deleted or 0),
                    "node_data_deleted": int(upload_deleted or 0),
                },
            }
        ), 200
    except Exception as exc:
        db.session.rollback()
        logger.exception("[/api/admin/delete_node_data] failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@api_bp.route("/admin/reset_data", methods=["POST"])
@admin_required
def admin_reset_data_alias():
    return admin_clear_all_data()


@api_bp.route("/admin/vacuum", methods=["POST"])
@admin_required
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
