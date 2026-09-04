import os
import unittest
import hashlib
import hmac
import json
import time
from pathlib import Path
from unittest.mock import Mock

os.environ.setdefault("WINDSIGHT_ENV_FILE", str(Path(__file__).with_name("__missing_test_env__.env")))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("WINDSIGHT_DEFAULT_ADMIN_ENABLED", "0")

from app import active_nodes, app  # noqa: E402
from windsight.models import RegisteredNode, TelemetryMetric, TelemetryRecord, User, db  # noqa: E402
from windsight.routes import api as api_routes  # noqa: E402


class GenericTelemetryTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()
        active_nodes.clear()
        with app.app_context():
            db.drop_all()
            db.create_all()

            self.alice = User(username="alice", role="user")
            self.alice.set_password("User1234", app.config)
            self.bob = User(username="bob", role="user")
            self.bob.set_password("User1234", app.config)
            self.admin = User(username="admin", role="admin")
            self.admin.set_password("Admin123", app.config)
            db.session.add_all([self.alice, self.bob, self.admin])
            db.session.flush()
            self.alice_id = self.alice.id
            self.bob_id = self.bob.id
            self.admin_id = self.admin.id

            node = RegisteredNode(
                node_id="SENSOR_01",
                owner_user_id=self.alice_id,
                display_name="Weather station",
                upload_interval_seconds=60,
                is_active=True,
            )
            node.set_node_key("SENSOR-KEY")
            db.session.add(node)
            db.session.commit()

    def _login(self, user_id):
        with self.client.session_transaction() as session:
            session["_user_id"] = str(user_id)
            session["_fresh"] = True

    def _payload(self):
        return {
            "device_id": "sensor_01",
            "temperature": 24.5,
            "environment": {"humidity": 61, "enabled": True},
            "samples": [1, {"voltage": 3.3}],
            "label": "north field",
        }

    def _post_telemetry(self, payload=None):
        return self.client.post(
            "/api/upload",
            json=payload or self._payload(),
            headers={"X-WindSight-Node-Key": "SENSOR-KEY"},
        )

    def _hmac_upload(self, payload, credential, nonce="telemetry-nonce"):
        raw_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        body_hash = hashlib.sha256(raw_body).hexdigest()
        timestamp = str(int(time.time()))
        device_id = str(payload.get("node_id") or payload.get("device_id") or payload.get("source_id")).upper()
        canonical = "\n".join(
            [
                "WIND-SIGHT-HMAC-SHA256",
                "v1",
                "POST",
                "/api/upload",
                device_id,
                credential["key_id"],
                timestamp,
                nonce,
                body_hash,
            ]
        )
        signature = hmac.new(
            credential["secret"].encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return self.client.post(
            "/api/upload",
            data=raw_body,
            content_type="application/json",
            headers={
                "X-WindSight-Signature-Version": "v1",
                "X-WindSight-Algorithm": "HMAC-SHA256",
                "X-WindSight-Device-Id": device_id,
                "X-WindSight-Key-Id": credential["key_id"],
                "X-WindSight-Timestamp": timestamp,
                "X-WindSight-Nonce": nonce,
                "X-WindSight-Body-SHA256": body_hash,
                "X-WindSight-Signature": signature,
            },
        )

    def test_generic_upload_persists_fields_and_emits_telemetry_update(self):
        emitter = Mock()
        original_emitter = api_routes.socketio_instance
        api_routes.socketio_instance = emitter
        try:
            response = self._post_telemetry()
        finally:
            api_routes.socketio_instance = original_emitter
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["source"], {"field": "device_id", "id": "sensor_01"})
        self.assertEqual(body["metric_count"], 4)

        with app.app_context():
            row = TelemetryRecord.query.one()
            self.assertEqual(row.node_id, "SENSOR_01")
            self.assertEqual(row.source_field, "device_id")
            self.assertEqual(row.metrics_dict(), {
                "temperature": 24.5,
                "environment.humidity": 61.0,
                "samples[0]": 1.0,
                "samples[1].voltage": 3.3,
            })
            self.assertEqual(TelemetryMetric.query.count(), 4)

        telemetry_call = next(
            call for call in emitter.emit.call_args_list if call.args and call.args[0] == "telemetry_update"
        )
        event = telemetry_call.args[1]
        self.assertEqual(event["node_id"], "SENSOR_01")
        self.assertEqual(
            set(event["data"]),
            {"record_id", "node_id", "timestamp", "metrics", "payload"},
        )
        self.assertEqual(event["data"]["metrics"]["environment.humidity"], 61.0)
        self.assertEqual(telemetry_call.kwargs["room"], "node_SENSOR_01")

    def test_telemetry_read_apis_obey_node_ownership_and_selected_fields(self):
        self._login(self.alice_id)
        self.assertEqual(self._post_telemetry().status_code, 200)

        response = self.client.get("/api/telemetry/sources")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["sources"][0]["node_id"], "SENSOR_01")
        self.assertEqual(response.get_json()["sources"][0]["field_count"], 4)

        response = self.client.get("/api/telemetry/fields?node_id=SENSOR_01")
        self.assertEqual(response.status_code, 200)
        fields = {item["path"]: item for item in response.get_json()["fields"]}
        self.assertEqual(fields["temperature"]["min"], 24.5)
        self.assertEqual(fields["samples[1].voltage"]["max"], 3.3)

        response = self.client.get(
            "/api/telemetry/history?node_id=SENSOR_01&fields=environment.humidity,samples[1].voltage&limit=5"
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["count"], 1)
        self.assertEqual(
            data["records"][0]["metrics"],
            {"environment.humidity": 61.0, "samples[1].voltage": 3.3},
        )
        self.assertEqual(data["records"][0]["payload"]["label"], "north field")

        self._login(self.bob_id)
        self.assertEqual(self.client.get("/api/telemetry/fields?node_id=SENSOR_01").status_code, 403)
        self.assertEqual(self.client.get("/api/telemetry/history?node_id=SENSOR_01").status_code, 403)
        self.assertEqual(self.client.get("/api/telemetry/sources").get_json()["sources"], [])

    def test_telemetry_fields_use_schema_from_latest_generic_packet(self):
        self._login(self.alice_id)
        payload = self._payload()
        payload["telemetry_schema"] = {
            "temperature": {
                "label": "空气温度",
                "unit": "°C",
                "semantic": "temperature",
            },
            "environment.humidity": {
                "label": "相对湿度",
                "unit": "%RH",
                "semantic": "humidity",
            },
            "unknown.path": {"label": "不在本帧的字段", "unit": "x", "semantic": "ignored"},
        }
        self.assertEqual(self._post_telemetry(payload).status_code, 200)

        response = self.client.get("/api/telemetry/fields?node_id=SENSOR_01")
        self.assertEqual(response.status_code, 200)
        fields = {item["path"]: item for item in response.get_json()["fields"]}
        self.assertEqual(
            {
                key: fields["temperature"][key]
                for key in ("label", "unit", "semantic")
            },
            {"label": "空气温度", "unit": "°C", "semantic": "temperature"},
        )
        self.assertEqual(
            {
                key: fields["environment.humidity"][key]
                for key in ("label", "unit", "semantic")
            },
            {"label": "相对湿度", "unit": "%RH", "semantic": "humidity"},
        )
        self.assertEqual(
            {
                key: fields["samples[1].voltage"][key]
                for key in ("label", "unit", "semantic")
            },
            {"label": "samples[1].voltage", "unit": "", "semantic": ""},
        )

        # The endpoint deliberately uses only the most recent packet schema:
        # a newer declaration may rename a field without a schema migration.
        payload["telemetry_schema"]["temperature"]["label"] = "最新温度"
        self.assertEqual(self._post_telemetry(payload).status_code, 200)
        response = self.client.get("/api/telemetry/fields?node_id=SENSOR_01")
        latest_fields = {item["path"]: item for item in response.get_json()["fields"]}
        self.assertEqual(latest_fields["temperature"]["label"], "最新温度")

    def test_node_tree_includes_generic_field_descriptors_for_user_and_admin(self):
        self._login(self.alice_id)
        payload = self._payload()
        payload["telemetry_schema"] = {
            "temperature": {"label": "空气温度", "unit": "°C", "semantic": "temperature"},
            "environment.humidity": {"label": "湿度", "unit": "%RH", "semantic": "humidity"},
        }
        self.assertEqual(self._post_telemetry(payload).status_code, 200)

        response = self.client.get("/api/nodes")
        self.assertEqual(response.status_code, 200)
        node = response.get_json()["nodes"][0]
        self.assertEqual(node["telemetry_field_count"], 4)
        descriptors = {field["path"]: field for field in node["telemetry_fields"]}
        self.assertEqual(descriptors["temperature"]["label"], "空气温度")
        self.assertEqual(descriptors["temperature"]["unit"], "°C")
        self.assertEqual(descriptors["environment.humidity"]["semantic"], "humidity")
        self.assertEqual(descriptors["samples[1].voltage"]["label"], "samples[1].voltage")
        # Generic descriptors are additive and do not rewrite legacy turbine fields.
        self.assertEqual(node["turbine_count"], 0)
        self.assertEqual(node["turbines"], [])

        self._login(self.admin_id)
        response = self.client.get(f"/api/admin/users/{self.alice_id}/registered_nodes")
        self.assertEqual(response.status_code, 200)
        admin_node = response.get_json()["nodes"][0]
        self.assertEqual(admin_node["telemetry_field_count"], 4)
        admin_descriptors = {field["path"]: field for field in admin_node["telemetry_fields"]}
        self.assertEqual(admin_descriptors["temperature"]["semantic"], "temperature")

    def test_generic_device_id_accepts_existing_hmac_credential(self):
        self._login(self.alice_id)
        registration = self.client.post("/api/my/registered_nodes", json={"node_id": "SENSOR_H1"})
        self.assertEqual(registration.status_code, 201)
        credential = registration.get_json()["credential"]

        response = self._hmac_upload(
            {"device_id": "sensor_h1", "measurements": {"temperature": 22.5}},
            credential,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["auth"]["version"], "hmac-v1")
        with app.app_context():
            row = TelemetryRecord.query.filter_by(node_id="SENSOR_H1").one()
            self.assertEqual(row.metrics_dict()["measurements.temperature"], 22.5)

    def test_generic_records_are_deleted_with_their_registered_node(self):
        self._login(self.alice_id)
        self.assertEqual(self._post_telemetry().status_code, 200)

        response = self.client.delete("/api/my/registered_nodes/SENSOR_01")
        self.assertEqual(response.status_code, 200)
        details = response.get_json()["details"]
        self.assertEqual(details["telemetry_records_deleted"], 1)
        self.assertEqual(details["telemetry_metrics_deleted"], 4)

        with app.app_context():
            self.assertEqual(TelemetryRecord.query.count(), 0)
            self.assertEqual(TelemetryMetric.query.count(), 0)

    def test_generic_records_participate_in_stats_and_account_clear(self):
        self._login(self.alice_id)
        self.assertEqual(self._post_telemetry().status_code, 200)

        response = self.client.get("/api/my/system_info")
        self.assertEqual(response.status_code, 200)
        info = response.get_json()["data"]
        self.assertEqual(info["telemetry_records"], 1)
        self.assertEqual(info["telemetry_metrics"], 4)
        self.assertEqual(info["total_records"], 1)

        response = self.client.get("/api/dashboard/stats")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["telemetry_records"], 1)
        self.assertEqual(response.get_json()["total_records"], 1)

        response = self.client.post("/api/my/clear_data", json={"node_id": "SENSOR_01"})
        self.assertEqual(response.status_code, 200)
        details = response.get_json()["details"]
        self.assertEqual(details["telemetry_records_deleted"], 1)
        self.assertEqual(details["telemetry_metrics_deleted"], 4)

        with app.app_context():
            self.assertEqual(TelemetryRecord.query.count(), 0)
            self.assertEqual(TelemetryMetric.query.count(), 0)


if __name__ == "__main__":
    unittest.main()
