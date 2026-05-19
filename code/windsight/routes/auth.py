from __future__ import annotations

import html
import random
import re
import secrets
import string
from datetime import datetime

from flask import Blueprint, Response, current_app, flash, redirect, render_template, request, session, url_for
from flask_login import login_required, login_user, logout_user

from windsight.models import RegistrationInvite, User, db

auth_bp = Blueprint("auth", __name__)

ROLE_LABELS = {
    "admin": "管理员",
    "user": "用户",
}


def _normalize_role(value: str | None) -> str:
    return value if value in ROLE_LABELS else "admin"


def _new_captcha_text() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(4))


def _captcha_matches(value: str | None) -> bool:
    expected = (session.get("captcha_text") or "").strip().upper()
    submitted = (value or "").strip().upper()
    session.pop("captcha_text", None)
    return bool(expected and submitted and secrets.compare_digest(expected, submitted))


def _password_message(message: str) -> str:
    if "at least" in message:
        return "密码长度不符合要求"
    if "uppercase" in message:
        return "密码必须包含大写字母"
    if "digit" in message:
        return "密码必须包含数字"
    if "special" in message:
        return "密码必须包含特殊字符"
    return message


@auth_bp.route("/captcha")
def captcha():
    text = _new_captcha_text()
    session["captcha_text"] = text

    width = 138
    height = 52
    chars = []
    for index, char in enumerate(text):
        x = 18 + index * 28 + random.randint(-2, 2)
        y = 34 + random.randint(-4, 4)
        rotate = random.randint(-12, 12)
        chars.append(
            f'<text x="{x}" y="{y}" transform="rotate({rotate} {x} {y})" '
            'font-size="24" font-weight="800" '
            'font-family="Inter, Arial, sans-serif" fill="#dbeafe">'
            f"{html.escape(char)}</text>"
        )

    lines = []
    for _ in range(5):
        x1 = random.randint(0, width)
        y1 = random.randint(0, height)
        x2 = random.randint(0, width)
        y2 = random.randint(0, height)
        opacity = random.uniform(0.2, 0.55)
        lines.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'stroke="#38bdf8" stroke-width="1.4" opacity="{opacity:.2f}" />'
        )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f2d5c"/>
      <stop offset="100%" stop-color="#10233f"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="14" fill="url(#g)"/>
  <rect x="1" y="1" width="{width - 2}" height="{height - 2}" rx="13" fill="none" stroke="#60a5fa" opacity="0.5"/>
  {''.join(lines)}
  {''.join(chars)}
</svg>"""
    response = Response(svg, mimetype="image/svg+xml")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    selected_role = _normalize_role(request.values.get("role"))
    username_value = ""

    if request.method == "POST":
        selected_role = _normalize_role(request.form.get("role"))
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        captcha_text = request.form.get("captcha") or ""
        remember = request.form.get("remember") == "on"
        username_value = username

        if not username or not password:
            flash("请输入用户名和密码", "error")
            return render_template("login.html", selected_role=selected_role, username_value=username_value)

        if not _captcha_matches(captcha_text):
            flash("验证码错误，请重新输入", "error")
            return render_template("login.html", selected_role=selected_role, username_value=username_value)

        user = User.query.filter_by(username=username).first()
        if not user or not user.check_password(password):
            flash("用户名或密码错误", "error")
            return render_template("login.html", selected_role=selected_role, username_value=username_value)

        if user.role != selected_role:
            flash(f"当前账号不是{ROLE_LABELS[selected_role]}账号，请切换登录身份", "error")
            return render_template("login.html", selected_role=selected_role, username_value=username_value)

        login_user(user, remember=remember)
        next_page = request.args.get("next")
        default_page = url_for("pages.overview") if user.role == "admin" else url_for("pages.my_tree")
        return redirect(next_page or default_page)

    return render_template("login.html", selected_role=selected_role, username_value=username_value)


@auth_bp.route("/register", methods=["GET", "POST"])
def register():
    username_value = ""

    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        confirm_password = request.form.get("confirm_password") or ""
        invite_code = (request.form.get("invite_code") or "").strip()
        captcha_text = request.form.get("captcha") or ""
        username_value = username

        if not _captcha_matches(captcha_text):
            flash("验证码错误，请重新输入", "error")
            return render_template("register.html", username_value=username_value)

        now = datetime.utcnow()
        invite = RegistrationInvite.query.filter_by(
            code=RegistrationInvite.normalize_code(invite_code)
        ).first()
        if not invite or not invite.is_available(now):
            flash("邀请码错误，请确认后重试", "error")
            return render_template("register.html", username_value=username_value)

        if not re.fullmatch(r"[A-Za-z0-9_-]{3,32}", username):
            flash("用户名只能包含字母、数字、下划线或短横线，长度 3-32 位", "error")
            return render_template("register.html", username_value=username_value)

        reserved_names = {"admin", "administrator", "root"}
        default_admin = (current_app.config.get("DEFAULT_ADMIN_USERNAME") or "WindSight").strip().lower()
        reserved_names.add(default_admin)
        if username.lower() in reserved_names:
            flash("该用户名为系统保留账号，请更换后重试", "error")
            return render_template("register.html", username_value=username_value)

        if password != confirm_password:
            flash("两次输入的密码不一致", "error")
            return render_template("register.html", username_value=username_value)

        if User.query.filter_by(username=username).first():
            flash("用户名已存在，请更换后重试", "error")
            return render_template("register.html", username_value=username_value)

        user = User(username=username, role="user")
        try:
            user.set_password(password, current_app.config)
            db.session.add(user)
            db.session.flush()

            updated = (
                RegistrationInvite.query.filter(
                    RegistrationInvite.id == invite.id,
                    RegistrationInvite.used_at.is_(None),
                    RegistrationInvite.revoked_at.is_(None),
                    RegistrationInvite.expires_at >= now,
                ).update(
                    {
                        "used_by_user_id": user.id,
                        "used_at": now,
                    },
                    synchronize_session=False,
                )
            )
            if updated != 1:
                raise ValueError("邀请码已失效，请联系管理员重新获取")

            db.session.commit()
        except ValueError as exc:
            db.session.rollback()
            flash(_password_message(str(exc)), "error")
            return render_template("register.html", username_value=username_value)
        except Exception:
            db.session.rollback()
            current_app.logger.exception("创建普通用户失败")
            flash("注册失败，请稍后重试", "error")
            return render_template("register.html", username_value=username_value)

        flash("普通用户注册成功，请使用用户身份登录", "info")
        return redirect(url_for("auth.login", role="user"))

    return render_template("register.html", username_value=username_value)


@auth_bp.route("/logout")
@login_required
def logout():
    logout_user()
    flash("您已成功退出登录", "info")
    return redirect(url_for("auth.login"))
