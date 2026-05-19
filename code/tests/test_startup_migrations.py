import os
import unittest
from pathlib import Path

os.environ.setdefault("WINDSIGHT_ENV_FILE", str(Path(__file__).with_name("__missing_test_env__.env")))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("WINDSIGHT_DEFAULT_ADMIN_ENABLED", "0")

from sqlalchemy import text  # noqa: E402

from app import app, migrate_registered_node_geo_columns, migrate_user_role_column  # noqa: E402
from windsight.models import db  # noqa: E402


class StartupMigrationTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        with app.app_context():
            db.drop_all()
            db.session.commit()

    def tearDown(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()

    def _columns(self, table_name):
        rows = db.session.execute(text(f"PRAGMA table_info({table_name})")).fetchall()
        return {row[1] for row in rows}

    def test_user_role_migration_adds_default_role_to_old_users_table(self):
        with app.app_context():
            db.session.execute(
                text(
                    """
                    CREATE TABLE users (
                        id INTEGER PRIMARY KEY,
                        username VARCHAR(100) UNIQUE NOT NULL,
                        password_hash VARCHAR(200)
                    )
                    """
                )
            )
            db.session.execute(text("INSERT INTO users (username, password_hash) VALUES ('alice', 'hash')"))
            db.session.commit()

            self.assertTrue(migrate_user_role_column())
            self.assertIn("role", self._columns("users"))
            role = db.session.execute(text("SELECT role FROM users WHERE username = 'alice'")).scalar_one()
            self.assertEqual(role, "user")
            self.assertFalse(migrate_user_role_column())

    def test_registered_node_geo_migration_adds_missing_location_columns(self):
        with app.app_context():
            db.session.execute(
                text(
                    """
                    CREATE TABLE registered_nodes (
                        id INTEGER PRIMARY KEY,
                        node_id VARCHAR(100) UNIQUE NOT NULL,
                        owner_user_id INTEGER NOT NULL,
                        node_key_hash VARCHAR(255) NOT NULL,
                        display_name VARCHAR(120),
                        created_at DATETIME,
                        last_seen_at DATETIME,
                        is_active BOOLEAN NOT NULL DEFAULT 1
                    )
                    """
                )
            )
            db.session.commit()

            self.assertTrue(migrate_registered_node_geo_columns())
            columns = self._columns("registered_nodes")
            self.assertIn("geo_lng", columns)
            self.assertIn("geo_lat", columns)
            self.assertFalse(migrate_registered_node_geo_columns())


if __name__ == "__main__":
    unittest.main()
