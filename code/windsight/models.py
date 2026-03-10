from __future__ import annotations

import json
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

    def set_password(self, password, config):
        is_valid, message = validate_password(password, config)
        if not is_valid:
            raise ValueError(message)
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class SystemConfig(db.Model):
    __tablename__ = "system_config"

    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(100), unique=True, nullable=False, index=True)
    value = db.Column(db.Text)
    description = db.Column(db.String(200))
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


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
