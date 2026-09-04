import os
import unittest
from datetime import datetime, timedelta
from pathlib import Path

os.environ["WINDSIGHT_ENV_FILE"] = str(Path(__file__).with_name("__missing_test_env__.env"))
os.environ["DATABASE_URL"] = "sqlite+pysqlite:///:memory:"
os.environ["SECRET_KEY"] = "test-secret"
os.environ["WINDSIGHT_DEFAULT_ADMIN_ENABLED"] = "0"
os.environ["WINDSIGHT_USER_INVITE_CODE"] = "INVITE-2026"

from app import app  # noqa: E402
from windsight.models import RegisteredNode, RegistrationInvite, User, db  # noqa: E402


class AuthRoleTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True, USER_INVITE_CODE="INVITE-2026")
        self.client = app.test_client()
        with app.app_context():
            db.drop_all()
            db.create_all()
            admin = User(username="admin", role="admin")
            admin.set_password("Admin123", app.config)
            db.session.add(admin)
            db.session.commit()
            self.admin_id = admin.id

    def _captcha(self, value="ABCD"):
        with self.client.session_transaction() as sess:
            sess["captcha_text"] = value
        return value

    def _login_user_id(self, user_id):
        with self.client.session_transaction() as sess:
            sess["_user_id"] = str(user_id)
            sess["_fresh"] = True

    def _create_invite(self, code="INVITE-2026", expires_at=None):
        with app.app_context():
            invite = RegistrationInvite(
                code=RegistrationInvite.normalize_code(code),
                created_by_user_id=self.admin_id,
                expires_at=expires_at or (datetime.utcnow() + timedelta(days=7)),
            )
            db.session.add(invite)
            db.session.commit()
            return invite.id

    def test_admin_login_requires_admin_role_selection(self):
        captcha = self._captcha()
        response = self.client.post(
            "/login",
            data={
                "role": "admin",
                "username": "admin",
                "password": "Admin123",
                "captcha": captcha,
            },
        )
        self.assertEqual(response.status_code, 302)

    def test_admin_login_rejects_user_role_selection(self):
        captcha = self._captcha()
        response = self.client.post(
            "/login",
            data={
                "role": "user",
                "username": "admin",
                "password": "Admin123",
                "captcha": captcha,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("当前账号不是用户账号".encode("utf-8"), response.data)

    def test_register_requires_valid_invite_and_captcha(self):
        self._create_invite("INVITE-2026")

        captcha = self._captcha()
        response = self.client.post(
            "/register",
            data={
                "username": "operator",
                "password": "User1234",
                "confirm_password": "User1234",
                "invite_code": "WRONG",
                "captcha": captcha,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("邀请码错误".encode("utf-8"), response.data)

        captcha = self._captcha()
        response = self.client.post(
            "/register",
            data={
                "username": "operator",
                "password": "User1234",
                "confirm_password": "User1234",
                "invite_code": "INVITE-2026",
                "captcha": captcha,
            },
        )
        self.assertEqual(response.status_code, 302)
        with app.app_context():
            user = User.query.filter_by(username="operator").first()
            self.assertIsNotNone(user)
            self.assertEqual(user.role, "user")
            invite = RegistrationInvite.query.filter_by(code="INVITE-2026").first()
            self.assertIsNotNone(invite.used_at)
            self.assertEqual(invite.used_by_user_id, user.id)

        captcha = self._captcha()
        response = self.client.post(
            "/register",
            data={
                "username": "operator2",
                "password": "User1234",
                "confirm_password": "User1234",
                "invite_code": "INVITE-2026",
                "captcha": captcha,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("邀请码错误".encode("utf-8"), response.data)

    def test_user_login_rejects_admin_role_selection(self):
        with app.app_context():
            user = User(username="operator", role="user")
            user.set_password("User1234", app.config)
            db.session.add(user)
            db.session.commit()

        captcha = self._captcha()
        response = self.client.post(
            "/login",
            data={
                "role": "admin",
                "username": "operator",
                "password": "User1234",
                "captcha": captcha,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("当前账号不是管理员账号".encode("utf-8"), response.data)

        captcha = self._captcha()
        response = self.client.post(
            "/login",
            data={
                "role": "user",
                "username": "operator",
                "password": "User1234",
                "captcha": captcha,
            },
        )
        self.assertEqual(response.status_code, 302)

    def test_register_rejects_reserved_admin_username(self):
        self._create_invite("INVITE-2026")

        captcha = self._captcha()
        response = self.client.post(
            "/register",
            data={
                "username": "admin",
                "password": "User1234",
                "confirm_password": "User1234",
                "invite_code": "INVITE-2026",
                "captcha": captcha,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("系统保留账号".encode("utf-8"), response.data)

    def test_register_rejects_expired_and_revoked_invites(self):
        self._create_invite("OLD-CODE", expires_at=datetime.utcnow() - timedelta(seconds=1))
        with app.app_context():
            revoked = RegistrationInvite(
                code="REVOKED-CODE",
                created_by_user_id=self.admin_id,
                expires_at=datetime.utcnow() + timedelta(days=7),
                revoked_at=datetime.utcnow(),
            )
            db.session.add(revoked)
            db.session.commit()

        for invite_code in ("OLD-CODE", "REVOKED-CODE"):
            captcha = self._captcha()
            response = self.client.post(
                "/register",
                data={
                    "username": f"user_{invite_code.split('-')[0].lower()}",
                    "password": "User1234",
                    "confirm_password": "User1234",
                    "invite_code": invite_code,
                    "captcha": captcha,
                },
            )
            self.assertEqual(response.status_code, 200)
            self.assertIn("邀请码错误".encode("utf-8"), response.data)

    def test_admin_can_manage_registration_invitations(self):
        with app.app_context():
            user = User(username="operator", role="user")
            user.set_password("User1234", app.config)
            db.session.add(user)
            db.session.add(
                RegistrationInvite(
                    code="LEGACY-REVOKED",
                    created_by_user_id=self.admin_id,
                    expires_at=datetime.utcnow() + timedelta(days=7),
                    revoked_at=datetime.utcnow(),
                )
            )
            db.session.commit()
            user_id = user.id

        self._login_user_id(user_id)
        response = self.client.get("/api/admin/invitations")
        self.assertEqual(response.status_code, 403)

        self._login_user_id(self.admin_id)
        response = self.client.post("/api/admin/invitations", json={"count": 2})
        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(len(data["invitations"]), 2)
        self.assertEqual(len(data["invitations"][0]["code"]), 16)

        response = self.client.get("/api/admin/invitations")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(len(data["invitations"]), 2)
        self.assertEqual(data["invitations"][0]["status"], "available")
        self.assertTrue(data["invitations"][0]["code"])

        invite_id = data["invitations"][0]["id"]
        response = self.client.post(f"/api/admin/invitations/{invite_id}/revoke")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["deleted_id"], invite_id)

        response = self.client.get("/api/admin/invitations")
        self.assertEqual(response.status_code, 200)
        remaining_ids = [row["id"] for row in response.get_json()["invitations"]]
        self.assertNotIn(invite_id, remaining_ids)

    def test_admin_can_delete_regular_user_directly(self):
        with app.app_context():
            user = User(username="operator", role="user")
            user.set_password("User1234", app.config)
            other_admin = User(username="other_admin", role="admin")
            other_admin.set_password("Admin123", app.config)
            db.session.add_all([user, other_admin])
            db.session.flush()
            node = RegisteredNode(
                node_id="WIN_DELETE",
                owner_user_id=user.id,
                node_key_hash="hash",
                display_name="Delete Me",
            )
            created_invite = RegistrationInvite(
                code="CREATED-BY-USER",
                created_by_user_id=user.id,
                expires_at=datetime.utcnow() + timedelta(days=7),
            )
            used_invite = RegistrationInvite(
                code="USED-BY-USER",
                created_by_user_id=self.admin_id,
                used_by_user_id=user.id,
                used_at=datetime.utcnow(),
                expires_at=datetime.utcnow() + timedelta(days=7),
            )
            db.session.add_all([node, created_invite, used_invite])
            db.session.commit()
            user_id = user.id
            other_admin_id = other_admin.id

        self._login_user_id(user_id)
        response = self.client.delete(f"/api/admin/users/{self.admin_id}")
        self.assertEqual(response.status_code, 403)

        self._login_user_id(self.admin_id)
        response = self.client.delete(f"/api/admin/users/{self.admin_id}")
        self.assertEqual(response.status_code, 400)
        response = self.client.delete(f"/api/admin/users/{other_admin_id}")
        self.assertEqual(response.status_code, 400)

        response = self.client.delete(f"/api/admin/users/{user_id}")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["deleted_user_id"], user_id)
        self.assertEqual(payload["deleted_nodes"], 1)

        with app.app_context():
            self.assertIsNone(db.session.get(User, user_id))
            self.assertIsNone(RegisteredNode.query.filter_by(node_id="WIN_DELETE").first())
            self.assertIsNone(RegistrationInvite.query.filter_by(code="CREATED-BY-USER").first().created_by_user_id)
            self.assertIsNone(RegistrationInvite.query.filter_by(code="USED-BY-USER").first().used_by_user_id)


if __name__ == "__main__":
    unittest.main()
