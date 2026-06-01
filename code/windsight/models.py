from __future__ import annotations

import hashlib
import json
import secrets
import re
from datetime import datetime

from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import Index, UniqueConstraint
from sqlalchemy.orm import relationship
from werkzeug.security import check_password_hash, generate_password_hash

db = SQLAlchemy()


def validate_password(password, config):
    if len(password) < config["PASSWORD_MIN_LENGTH"]:
        return False, f"Password must be at least {config['PASSWORD_MIN_LENGTH']} chars"

    if config["PASSWORD_REQUIRE_UPPERCASE"] and not re.search(r"[A-Z]", password):
        return False, "Password must include an uppercase letter"

    if config["PASSWORD_REQUIRE_DIGITS"] and not re.search(r"\d", password):
        return False, "Password must include a digit"

    if config["PASSWORD_REQUIRE_SPECIAL"] and not re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
        return False, "Password must include a special character"

    return True, "ok"


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(200))
    role = db.Column(db.String(20), nullable=False, default="user")

    registered_nodes = relationship(
        "RegisteredNode",
        back_populates="owner",
        cascade="all, delete-orphan",
        passive_deletes=False,
        lazy="selectin",
    )
    settings = relationship(
        "UserSetting",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=False,
        lazy="selectin",
    )

    def set_password(self, password, config):
        is_valid, message = validate_password(password, config)
        if not is_valid:
            raise ValueError(message)
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    @property
    def is_admin(self):
        return self.role == "admin"


class RegisteredNode(db.Model):
    __tablename__ = "registered_nodes"

    id = db.Column(db.Integer, primary_key=True)
    node_id = db.Column(db.String(100), unique=True, nullable=False, index=True)
    owner_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    node_key_hash = db.Column(db.String(255), nullable=False)
    node_key_plain = db.Column(db.String(255))
    display_name = db.Column(db.String(120))
    geo_lng = db.Column(db.Float)
    geo_lat = db.Column(db.Float)
    upload_interval_seconds = db.Column(db.Integer, default=60, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at = db.Column(db.DateTime)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    owner = relationship("User", back_populates="registered_nodes")
    credentials = relationship(
        "NodeCredential",
        back_populates="registered_node",
        cascade="all, delete-orphan",
        passive_deletes=False,
        lazy="selectin",
        order_by="NodeCredential.created_at.desc()",
    )

    @staticmethod
    def generate_node_key():
        return secrets.token_urlsafe(24)

    def set_node_key(self, node_key):
        self.node_key_plain = node_key
        self.node_key_hash = generate_password_hash(node_key)

    def check_node_key(self, node_key):
        return check_password_hash(self.node_key_hash, node_key)


class NodeCredential(db.Model):
    __tablename__ = "node_credentials"

    STATUS_ACTIVE = "active"
    STATUS_GRACE = "grace"
    STATUS_REVOKED = "revoked"
    ALGORITHM_HMAC_SHA256 = "HMAC-SHA256"

    id = db.Column(db.Integer, primary_key=True)
    registered_node_id = db.Column(
        db.Integer,
        db.ForeignKey("registered_nodes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_id = db.Column(db.String(100), nullable=False, index=True)
    key_id = db.Column(db.String(64), unique=True, nullable=False, index=True)
    secret_encrypted = db.Column(db.Text, nullable=False)
    secret_hash = db.Column(db.String(64), nullable=False, index=True)
    algorithm = db.Column(db.String(32), nullable=False, default=ALGORITHM_HMAC_SHA256)
    status = db.Column(db.String(20), nullable=False, default=STATUS_ACTIVE, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    activated_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    expires_at = db.Column(db.DateTime, index=True)
    revoked_at = db.Column(db.DateTime)
    last_used_at = db.Column(db.DateTime)
    last_failed_at = db.Column(db.DateTime)
    last_failure_reason = db.Column(db.String(255))

    registered_node = relationship("RegisteredNode", back_populates="credentials")
    nonces = relationship(
        "NodeAuthNonce",
        back_populates="credential",
        cascade="all, delete-orphan",
        passive_deletes=False,
        lazy="selectin",
    )

    __table_args__ = (
        Index("ix_node_credentials_node_status", "node_id", "status"),
    )

    @staticmethod
    def generate_key_id():
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return "WSK_" + "".join(secrets.choice(alphabet) for _ in range(20))

    @staticmethod
    def generate_secret():
        return secrets.token_urlsafe(32)

    @staticmethod
    def hash_secret(secret: str) -> str:
        return hashlib.sha256(str(secret or "").encode("utf-8")).hexdigest()

    def is_usable(self, now: datetime | None = None) -> bool:
        now = now or datetime.utcnow()
        if self.status == self.STATUS_ACTIVE:
            return True
        if self.status == self.STATUS_GRACE and self.expires_at and self.expires_at >= now:
            return True
        return False


class NodeAuthNonce(db.Model):
    __tablename__ = "node_auth_nonces"

    id = db.Column(db.Integer, primary_key=True)
    credential_id = db.Column(
        db.Integer,
        db.ForeignKey("node_credentials.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_id = db.Column(db.String(100), nullable=False, index=True)
    key_id = db.Column(db.String(64), nullable=False, index=True)
    nonce = db.Column(db.String(128), nullable=False)
    body_sha256 = db.Column(db.String(64), nullable=False)
    signature_sha256 = db.Column(db.String(64), nullable=False)
    received_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False, index=True)

    credential = relationship("NodeCredential", back_populates="nonces")

    __table_args__ = (
        UniqueConstraint("credential_id", "nonce", name="uq_node_auth_nonce_credential_nonce"),
        Index("ix_node_auth_nonces_node_key_nonce", "node_id", "key_id", "nonce"),
    )


class SystemConfig(db.Model):
    __tablename__ = "system_config"

    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(100), unique=True, nullable=False, index=True)
    value = db.Column(db.Text)
    description = db.Column(db.String(200))
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class UserSetting(db.Model):
    __tablename__ = "user_settings"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    key = db.Column(db.String(100), nullable=False, index=True)
    value = db.Column(db.Text)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="settings")

    __table_args__ = (
        UniqueConstraint("user_id", "key", name="uq_user_settings_user_key"),
    )


class RegistrationInvite(db.Model):
    __tablename__ = "registration_invites"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(32), unique=True, nullable=False, index=True)
    created_by_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False, index=True)
    used_by_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    used_at = db.Column(db.DateTime)
    revoked_at = db.Column(db.DateTime)

    created_by = relationship("User", foreign_keys=[created_by_user_id])
    used_by = relationship("User", foreign_keys=[used_by_user_id])

    @staticmethod
    def normalize_code(code):
        return str(code or "").strip().upper()

    @staticmethod
    def generate_code(length: int = 16):
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return "".join(secrets.choice(alphabet) for _ in range(max(8, int(length or 16))))

    def status(self, now: datetime | None = None):
        now = now or datetime.utcnow()
        if self.used_at:
            return "used"
        if self.revoked_at:
            return "revoked"
        if self.expires_at and self.expires_at < now:
            return "expired"
        return "available"

    def is_available(self, now: datetime | None = None):
        return self.status(now) == "available"


class NodeData(db.Model):
    """
    Legacy table kept for backup only.
    New uploads are stored in NodeUpload/TurbineMeasurement.
    """

    __tablename__ = "node_data"

    id = db.Column(db.Integer, primary_key=True)
    node_id = db.Column(db.String(100), nullable=False, index=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    voltage_data = db.Column(db.Text, nullable=False)
    current_data = db.Column(db.Text, nullable=False)
    speed_data = db.Column(db.Text, nullable=False)

    def to_dict(self):
        from windsight.time_utils import iso_beijing

        return {
            "id": self.id,
            "node_id": self.node_id,
            "timestamp": iso_beijing(self.timestamp, with_seconds=True, with_ms=True),
            "voltages": json.loads(self.voltage_data) if self.voltage_data else [],
            "currents": json.loads(self.current_data) if self.current_data else [],
            "speeds": json.loads(self.speed_data) if self.speed_data else [],
        }


class NodeUpload(db.Model):
    __tablename__ = "node_uploads"

    id = db.Column(db.Integer, primary_key=True)
    node_id = db.Column(db.String(100), nullable=False, index=True)
    turbine_count = db.Column(db.Integer, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    raw_payload = db.Column(db.Text, nullable=False)

    measurements = relationship(
        "TurbineMeasurement",
        back_populates="upload",
        order_by="TurbineMeasurement.turbine_index",
        cascade="all, delete-orphan",
        passive_deletes=False,
        lazy="selectin",
    )

    __table_args__ = (
        Index("ix_node_uploads_node_id_timestamp", "node_id", "timestamp"),
    )

    def turbine_codes(self):
        return [m.turbine_code for m in self.measurements]

    def turbines_dict(self):
        return {m.turbine_code: m.to_value_dict() for m in self.measurements}

    def to_row_dict(self):
        from windsight.time_utils import iso_beijing

        return {
            "upload_id": self.id,
            "node_id": self.node_id,
            "timestamp": iso_beijing(self.timestamp, with_seconds=True, with_ms=True),
            "sub": self.turbine_count,
            "turbines": self.turbines_dict(),
        }


class TurbineMeasurement(db.Model):
    __tablename__ = "turbine_measurements"

    id = db.Column(db.Integer, primary_key=True)
    upload_id = db.Column(
        db.Integer,
        db.ForeignKey("node_uploads.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_id = db.Column(db.String(100), nullable=False, index=True)
    turbine_code = db.Column(db.String(3), nullable=False)
    turbine_index = db.Column(db.Integer, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)
    voltage = db.Column(db.Float, nullable=False)
    current = db.Column(db.Float, nullable=False)
    speed = db.Column(db.Float, nullable=False)
    temperature = db.Column(db.Float, nullable=False)

    upload = relationship("NodeUpload", back_populates="measurements")

    __table_args__ = (
        UniqueConstraint("upload_id", "turbine_code", name="uq_turbine_measurement_upload_code"),
        Index("ix_turbine_measurements_node_code_timestamp", "node_id", "turbine_code", "timestamp"),
    )

    def to_value_dict(self):
        return {
            "voltage": float(self.voltage),
            "current": float(self.current),
            "speed": float(self.speed),
            "temperature": float(self.temperature),
        }
