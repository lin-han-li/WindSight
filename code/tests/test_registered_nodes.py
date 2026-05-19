import json
import os
import unittest
from datetime import datetime, timedelta
from pathlib import Path

os.environ.setdefault("WINDSIGHT_ENV_FILE", str(Path(__file__).with_name("__missing_test_env__.env")))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("WINDSIGHT_DEFAULT_ADMIN_ENABLED", "0")
os.environ.setdefault("WINDSIGHT_USER_INVITE_CODE", "INVITE-2026")

from app import active_nodes, app, socketio  # noqa: E402
from windsight.models import NodeUpload, RegisteredNode, TurbineMeasurement, User, UserSetting, db  # noqa: E402
from windsight.socket_events import client_subscriptions  # noqa: E402


class RegisteredNodeTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True, USER_INVITE_CODE="INVITE-2026")
        self.client = app.test_client()
        active_nodes.clear()
        client_subscriptions.clear()
        with app.app_context():
            db.drop_all()
            db.create_all()

            admin = User(username="admin", role="admin")
            admin.set_password("Admin123", app.config)
            alice = User(username="alice", role="user")
            alice.set_password("User1234", app.config)
            bob = User(username="bob", role="user")
            bob.set_password("User1234", app.config)
            db.session.add_all([admin, alice, bob])
            db.session.commit()

            self.admin_id = admin.id
            self.alice_id = alice.id
            self.bob_id = bob.id

    def _login_user_id(self, user_id):
        with self.client.session_transaction() as sess:
            sess["_user_id"] = str(user_id)
            sess["_fresh"] = True

    def _payload(self, node_id="WIN_101"):
        return {
            "node_id": node_id,
            "sub": "1",
            "001": [2.5, 2.0, 1.5, 1.0],
        }

    def _register_node_row(self, owner_user_id, node_id, node_key="NODE-KEY", display_name=None):
        node = RegisteredNode(
            node_id=node_id,
            owner_user_id=owner_user_id,
            display_name=display_name or node_id,
            is_active=True,
        )
        node.set_node_key(node_key)
        db.session.add(node)
        db.session.commit()
        return node

    def _insert_upload(self, node_id, turbine_code="001", timestamp=None):
        upload_kwargs = {
            "node_id": node_id,
            "turbine_count": 1,
            "raw_payload": json.dumps(self._payload(node_id), ensure_ascii=False),
        }
        if timestamp is not None:
            upload_kwargs["timestamp"] = timestamp
        row = NodeUpload(**upload_kwargs)
        row.measurements.append(
            TurbineMeasurement(
                node_id=node_id,
                turbine_code=turbine_code,
                turbine_index=1,
                timestamp=timestamp or datetime.utcnow(),
                voltage=125.0,
                current=2.0,
                speed=750.0,
                temperature=20.0,
            )
        )
        db.session.add(row)
        db.session.commit()
        return row

    def test_user_registers_node_and_duplicate_conflicts(self):
        self._login_user_id(self.alice_id)
        response = self.client.post(
            "/api/my/registered_nodes",
            json={"node_id": "win_101", "display_name": "北侧测试节点"},
        )
        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["node"]["node_id"], "WIN_101")
        self.assertIn("node_key", data)
        self.assertEqual(data["node"]["node_key"], data["node_key"])
        self.assertTrue(data["node"]["node_key_available"])

        response = self.client.post("/api/my/registered_nodes", json={"node_id": "WIN_101"})
        self.assertEqual(response.status_code, 409)

        with app.app_context():
            node = RegisteredNode.query.filter_by(node_id="WIN_101").first()
            self.assertIsNotNone(node)
            self.assertEqual(node.owner_user_id, self.alice_id)
            self.assertNotEqual(node.node_key_hash, data["node_key"])
            self.assertEqual(node.node_key_plain, data["node_key"])

        response = self.client.get("/api/my/registered_nodes")
        self.assertEqual(response.status_code, 200)
        listed = response.get_json()["nodes"][0]
        self.assertEqual(listed["node_key"], data["node_key"])
        self.assertTrue(listed["node_key_available"])

    def test_upload_rejects_unregistered_missing_and_wrong_key(self):
        response = self.client.post("/api/upload", json=self._payload("WIN_404"))
        self.assertEqual(response.status_code, 403)

        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_101", "RIGHT-KEY")

        response = self.client.post("/api/upload", json=self._payload("WIN_101"))
        self.assertEqual(response.status_code, 403)

        response = self.client.post(
            "/api/upload",
            json=self._payload("WIN_101"),
            headers={"X-WindSight-Node-Key": "WRONG-KEY"},
        )
        self.assertEqual(response.status_code, 403)

        with app.app_context():
            self.assertEqual(NodeUpload.query.count(), 0)

    def test_upload_accepts_registered_node_with_correct_key(self):
        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_101", "RIGHT-KEY")

        response = self.client.post(
            "/api/upload",
            json=self._payload("WIN_101"),
            headers={"X-WindSight-Node-Key": "RIGHT-KEY"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "success")

        with app.app_context():
            self.assertEqual(NodeUpload.query.count(), 1)
            self.assertEqual(TurbineMeasurement.query.count(), 1)
            node = RegisteredNode.query.filter_by(node_id="WIN_101").first()
            self.assertIsNotNone(node.last_seen_at)

    def test_rotated_node_key_invalidates_old_key(self):
        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_101", "OLD-KEY")

        self._login_user_id(self.alice_id)
        response = self.client.post("/api/my/registered_nodes/WIN_101/rotate_key")
        self.assertEqual(response.status_code, 200)
        new_key = response.get_json()["node_key"]
        self.assertNotEqual(new_key, "OLD-KEY")
        self.assertEqual(response.get_json()["node"]["node_key"], new_key)

        response = self.client.post(
            "/api/upload",
            json=self._payload("WIN_101"),
            headers={"X-WindSight-Node-Key": "OLD-KEY"},
        )
        self.assertEqual(response.status_code, 403)

        response = self.client.post(
            "/api/upload",
            json=self._payload("WIN_101"),
            headers={"X-WindSight-Node-Key": new_key},
        )
        self.assertEqual(response.status_code, 200)

    def test_user_config_is_account_scoped(self):
        self._login_user_id(self.alice_id)
        response = self.client.get("/api/my/config")
        self.assertEqual(response.status_code, 200)
        defaults = response.get_json()["data"]
        self.assertEqual(defaults["poll_interval"], 3000)
        self.assertTrue(defaults["auto_refresh"])

        response = self.client.post(
            "/api/my/config",
            json={
                "poll_interval": 1500,
                "auto_refresh": False,
                "show_debug_log": True,
                "log_retention": 90,
                "node_timeout_seconds": 1,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()["data"]
        self.assertEqual(data["poll_interval"], 1500)
        self.assertFalse(data["auto_refresh"])
        self.assertTrue(data["show_debug_log"])
        self.assertEqual(data["log_retention"], 90)

        with app.app_context():
            self.assertEqual(UserSetting.query.filter_by(user_id=self.alice_id).count(), 4)

        self._login_user_id(self.bob_id)
        response = self.client.get("/api/my/config")
        self.assertEqual(response.status_code, 200)
        bob_data = response.get_json()["data"]
        self.assertEqual(bob_data["poll_interval"], 3000)
        self.assertTrue(bob_data["auto_refresh"])

    def test_user_data_maintenance_is_owner_scoped(self):
        old_time = datetime.utcnow() - timedelta(days=40)
        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_A01", "A-KEY")
            self._register_node_row(self.bob_id, "WIN_B01", "B-KEY")
            self._insert_upload("WIN_A01", timestamp=old_time)
            self._insert_upload("WIN_A01")
            self._insert_upload("WIN_B01", timestamp=old_time)

        self._login_user_id(self.alice_id)
        response = self.client.get("/api/my/system_info")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["data"]["total_nodes"], 1)
        self.assertEqual(response.get_json()["data"]["node_uploads"], 2)

        response = self.client.post("/api/my/cleanup_old_data", json={"retention_days": 30})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["details"]["node_uploads_deleted"], 1)

        with app.app_context():
            self.assertEqual(NodeUpload.query.filter_by(node_id="WIN_A01").count(), 1)
            self.assertEqual(NodeUpload.query.filter_by(node_id="WIN_B01").count(), 1)

        response = self.client.post("/api/my/clear_data", json={"node_id": "WIN_B01"})
        self.assertEqual(response.status_code, 404)

        response = self.client.post("/api/my/clear_data", json={"node_id": "WIN_A01"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["details"]["node_uploads_deleted"], 1)

        with app.app_context():
            self.assertEqual(NodeUpload.query.filter_by(node_id="WIN_A01").count(), 0)
            self.assertEqual(TurbineMeasurement.query.filter_by(node_id="WIN_A01").count(), 0)
            self.assertEqual(NodeUpload.query.filter_by(node_id="WIN_B01").count(), 1)

    def test_user_delete_node_removes_only_owned_node_and_data(self):
        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_A01", "A-KEY")
            self._register_node_row(self.bob_id, "WIN_B01", "B-KEY")
            self._insert_upload("WIN_A01")
            self._insert_upload("WIN_B01")

        self._login_user_id(self.alice_id)
        response = self.client.delete("/api/my/registered_nodes/WIN_B01")
        self.assertEqual(response.status_code, 404)

        response = self.client.delete("/api/my/registered_nodes/WIN_A01")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["deleted_node_id"], "WIN_A01")

        with app.app_context():
            self.assertIsNone(RegisteredNode.query.filter_by(node_id="WIN_A01").first())
            self.assertIsNotNone(RegisteredNode.query.filter_by(node_id="WIN_B01").first())
            self.assertEqual(NodeUpload.query.filter_by(node_id="WIN_A01").count(), 0)
            self.assertEqual(TurbineMeasurement.query.filter_by(node_id="WIN_A01").count(), 0)
            self.assertEqual(NodeUpload.query.filter_by(node_id="WIN_B01").count(), 1)

    def test_user_scope_and_admin_user_tree(self):
        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_A01", "A-KEY")
            self._register_node_row(self.bob_id, "WIN_B01", "B-KEY")
            self._insert_upload("WIN_A01")
            self._insert_upload("WIN_B01")

        self._login_user_id(self.alice_id)
        response = self.client.get("/api/nodes")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([node["node_id"] for node in response.get_json()["nodes"]], ["WIN_A01"])

        response = self.client.get("/api/data?node_id=WIN_B01")
        self.assertEqual(response.status_code, 403)

        response = self.client.get("/api/data?node_id=WIN_A01")
        self.assertEqual(response.status_code, 200)

        self._login_user_id(self.admin_id)
        response = self.client.get("/api/nodes")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            sorted(node["node_id"] for node in response.get_json()["nodes"]),
            ["WIN_A01", "WIN_B01"],
        )

        response = self.client.get("/api/admin/users")
        self.assertEqual(response.status_code, 200)
        self.assertIn("alice", [user["username"] for user in response.get_json()["users"]])

        response = self.client.get(f"/api/admin/users/{self.alice_id}/registered_nodes")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([node["node_id"] for node in response.get_json()["nodes"]], ["WIN_A01"])

    def test_socket_requires_login_and_blocks_unowned_node_subscription(self):
        socket_client = socketio.test_client(app, flask_test_client=self.client)
        self.assertFalse(socket_client.is_connected())

        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_A01", "A-KEY")
            self._register_node_row(self.bob_id, "WIN_B01", "B-KEY")

        self._login_user_id(self.alice_id)
        socket_client = socketio.test_client(app, flask_test_client=self.client)
        self.assertTrue(socket_client.is_connected())

        socket_client.emit("subscribe_node", {"node_id": "WIN_B01"})
        self.assertFalse(any("WIN_B01" in nodes for nodes in client_subscriptions.values()))

        socket_client.emit("subscribe_node", {"node_id": "WIN_A01"})
        self.assertTrue(any("WIN_A01" in nodes for nodes in client_subscriptions.values()))
        socket_client.disconnect()

    def test_user_updates_own_node_location_and_validation(self):
        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_A01", "A-KEY")
            self._register_node_row(self.bob_id, "WIN_B01", "B-KEY")

        self._login_user_id(self.alice_id)
        response = self.client.patch(
            "/api/my/registered_nodes/WIN_A01/location",
            json={"lng": 120.123456, "lat": 30.654321},
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["success"])
        self.assertTrue(data["node"]["geo_configured"])
        self.assertEqual(data["node"]["geo"], {"lng": 120.123456, "lat": 30.654321})

        response = self.client.patch("/api/my/registered_nodes/WIN_A01/location", json={"lng": 120})
        self.assertEqual(response.status_code, 400)

        response = self.client.patch("/api/my/registered_nodes/WIN_A01/location", json={"lng": 181, "lat": 30})
        self.assertEqual(response.status_code, 400)

        response = self.client.patch("/api/my/registered_nodes/WIN_B01/location", json={"lng": 120, "lat": 30})
        self.assertEqual(response.status_code, 404)

        response = self.client.patch("/api/my/registered_nodes/WIN_A01/location", json={"lng": "", "lat": ""})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertFalse(data["node"]["geo_configured"])
        self.assertIsNone(data["node"]["geo"])

    def test_admin_updates_selected_users_node_location(self):
        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_A01", "A-KEY")
            self._register_node_row(self.bob_id, "WIN_B01", "B-KEY")

        self._login_user_id(self.admin_id)
        response = self.client.patch(
            f"/api/admin/users/{self.alice_id}/registered_nodes/WIN_A01/location",
            json={"geo": {"lng": 121.5, "lat": 31.2}},
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["node"]["owner_user_id"], self.alice_id)
        self.assertEqual(data["node"]["geo"], {"lng": 121.5, "lat": 31.2})

        response = self.client.get(f"/api/admin/users/{self.alice_id}/registered_nodes")
        self.assertEqual(response.status_code, 200)
        nodes = response.get_json()["nodes"]
        self.assertEqual(nodes[0]["geo"], {"lng": 121.5, "lat": 31.2})
        self.assertTrue(nodes[0]["geo_configured"])

        response = self.client.patch(
            f"/api/admin/users/{self.alice_id}/registered_nodes/WIN_B01/location",
            json={"lng": 120, "lat": 30},
        )
        self.assertEqual(response.status_code, 404)

        response = self.client.patch(
            f"/api/admin/users/{self.alice_id}/registered_nodes/WIN_A01/location",
            json={"lng": "abc", "lat": 30},
        )
        self.assertEqual(response.status_code, 400)

    def test_data_meta_links_frame_count_start_and_end_times(self):
        base_utc = datetime(2026, 5, 17, 0, 0, 0)
        with app.app_context():
            self._register_node_row(self.alice_id, "WIN_A01", "A-KEY")
            for offset in range(5):
                self._insert_upload("WIN_A01", timestamp=base_utc + timedelta(minutes=offset))

        self._login_user_id(self.alice_id)

        response = self.client.get(
            "/api/data_meta?node_id=WIN_A01&mode=nth&start=2026-05-17T08:00:00&limit=3"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["count"], 5)
        self.assertIn("2026-05-17T08:02:00", payload["nth_ts"])

        response = self.client.get(
            "/api/data_meta?node_id=WIN_A01&mode=nth_before&end=2026-05-17T08:04:00&limit=3"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["count"], 5)
        self.assertIn("2026-05-17T08:02:00", payload["nth_ts"])

        response = self.client.get(
            "/api/data_meta?node_id=WIN_A01&mode=count&start=2026-05-17T08:01:00&end=2026-05-17T08:03:00"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["count"], 3)

        response = self.client.get(
            "/api/data_meta?node_id=WIN_A01&mode=count&start=2026-05-17T08:03:00&end=2026-05-17T08:01:00"
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
