from __future__ import annotations

from functools import wraps

from flask import Blueprint, abort, redirect, render_template, url_for
from flask_login import current_user, login_required

pages_bp = Blueprint("pages", __name__)


def admin_page_required(view_func):
    @wraps(view_func)
    @login_required
    def wrapper(*args, **kwargs):
        if getattr(current_user, "role", "") != "admin":
            abort(403)
        return view_func(*args, **kwargs)

    return wrapper


@pages_bp.route("/")
@login_required
def index():
    if getattr(current_user, "role", "") == "admin":
        return redirect(url_for("pages.overview"))
    return redirect(url_for("pages.my_tree"))


@pages_bp.route("/my/tree")
@login_required
def my_tree():
    return render_template("my_tree.html")


@pages_bp.route("/admin/users")
@admin_page_required
def admin_users():
    return render_template("admin_users.html")


@pages_bp.route("/overview")
@login_required
def overview():
    return render_template("overview.html")


@pages_bp.route("/map")
@login_required
def map_overview():
    return render_template("map.html")


@pages_bp.route("/settings")
@login_required
def settings():
    if getattr(current_user, "role", "") != "admin":
        return render_template("user_settings.html")
    return render_template("settings.html")


@pages_bp.route("/monitor")
@login_required
def monitor():
    return render_template("monitor.html")


@pages_bp.route("/system_overview")
@admin_page_required
def system_overview():
    return render_template("system_overview.html")
