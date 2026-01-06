"""
认证路由蓝图
处理登录、登出等认证相关功能
"""
from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import login_user, logout_user, login_required
from edgewind.models import User

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    """登录页面和处理"""
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        remember = request.form.get('remember') == 'on'  # 复选框：'on' 表示选中
        
        if not username or not password:
            flash('请输入用户名和密码', 'error')
            return render_template('login.html')
        
        user = User.query.filter_by(username=username).first()
        
        if user and user.check_password(password):
            # 使用 remember 参数，如果为 True，Flask-Login 会设置持久化 cookie
            login_user(user, remember=remember)
            next_page = request.args.get('next')
            # 重定向到请求的页面，如果没有则重定向到概览页
            return redirect(next_page or url_for('pages.overview'))
        else:
            flash('用户名或密码错误', 'error')
    
    return render_template('login.html')


@auth_bp.route('/logout')
@login_required
def logout():
    """登出"""
    logout_user()
    flash('您已成功登出', 'info')
    return redirect(url_for('auth.login'))

