"""
页面路由蓝图
处理前端页面渲染
"""
from flask import Blueprint, render_template
from flask_login import login_required

pages_bp = Blueprint('pages', __name__)


@pages_bp.route('/')
@login_required
def index():
    """主页面：数据概览（Dashboard）"""
    return render_template('overview.html')


@pages_bp.route('/overview')
@login_required
def overview():
    """数据概览（Dashboard）"""
    return render_template('overview.html')


@pages_bp.route('/settings')
@login_required
def settings():
    """节点管理 / 系统设置页面"""
    return render_template('settings.html')


@pages_bp.route('/monitor')
@login_required
def monitor():
    """三窗口波形监测页面（电压/电流/转速）"""
    return render_template('monitor.html')


@pages_bp.route('/system_overview')
@login_required
def system_overview():
    """系统概览（统计卡片 + 节点状态墙）"""
    return render_template('system_overview.html')