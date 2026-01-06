"""
WindSight 智风监测系统 - Flask 后端主程序

本文件是应用的入口点，负责：
1. 初始化Flask应用和各类扩展
2. 注册蓝图（路由模块化）
3. 配置日志和中间件
4. 启动应用

大部分业务逻辑已移至 edgewind 模块（历史包名，保留以减少重命名风险），保持此文件简洁。
"""
import os
import logging
import threading
import time
import secrets
import string
from logging.handlers import RotatingFileHandler
from flask import Flask
from flask_cors import CORS
from flask_socketio import SocketIO
from flask_login import LoginManager
from concurrent.futures import ThreadPoolExecutor
from sqlalchemy import text

# ==================== 环境变量加载 ====================
try:
    from dotenv import load_dotenv
    # 说明：部分环境（例如某些 IDE/全局忽略规则）会阻止创建/读取 .env。
    # 为了让“配置文件激活”更稳定，这里支持按优先级加载：
    # 1) 环境变量 WINDSIGHT_ENV_FILE 指定的文件
    # 2) 项目根目录下的 edgewind.env（推荐）
    # 3) 默认的 .env（如果存在）
    env_file = os.environ.get("WINDSIGHT_ENV_FILE")
    if env_file and str(env_file).strip():
        load_dotenv(str(env_file).strip())
    else:
        # 先尝试 edgewind.env（不容易被忽略规则拦截）
        load_dotenv("edgewind.env")
        # 再尝试默认 .env（如果存在）
        load_dotenv()
except ImportError:
    pass

# ==================== 导入配置和模型 ====================
from edgewind.config import Config
from edgewind.models import db, User

# ==================== Flask应用初始化 ====================
app = Flask(__name__)
app.config.from_object(Config)

# ==================== 模板热更新（避免“改了侧边栏但页面没变”）====================
# 说明：
# - 当前项目通常以 debug=False 运行（生产式启动），Jinja2 会缓存模板；
# - 这会导致你修改 templates/base.html 后，浏览器刷新仍看不到变化，必须重启服务才会加载新模板。
# - 这里提供一个开关：WINDSIGHT_TEMPLATE_AUTO_RELOAD=1 时启用模板自动重载（开发/联调更省心）。
try:
    _tpl_reload = os.environ.get("WINDSIGHT_TEMPLATE_AUTO_RELOAD", "1").strip() == "1"
    app.config["TEMPLATES_AUTO_RELOAD"] = bool(_tpl_reload)
    app.jinja_env.auto_reload = bool(_tpl_reload)
except Exception:
    pass

# ==================== 日志系统初始化 ====================
def setup_logging():
    """配置结构化日志系统"""
    os.makedirs('logs', exist_ok=True)
    
    log_level = getattr(logging, app.config['LOG_LEVEL'].upper(), logging.INFO)
    
    # 简化版格式用于控制台
    simple_formatter = logging.Formatter('%(levelname)s: %(message)s')
    detailed_formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - [%(filename)s:%(lineno)d] - %(message)s'
    )
    
    # 文件处理器
    file_handler = RotatingFileHandler(
        app.config['LOG_FILE'],
        maxBytes=10*1024*1024,  # 10MB
        backupCount=10,
        encoding='utf-8'
    )
    file_handler.setFormatter(detailed_formatter)
    file_handler.setLevel(log_level)
    
    # 控制台处理器
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(simple_formatter)
    console_handler.setLevel(logging.INFO)  # 改为INFO以便看到启动信息
    
    # 配置根日志记录器
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)
    
    # 配置Flask日志
    app.logger.setLevel(log_level)
    app.logger.addHandler(file_handler)
    
    # 禁用werkzeug访问日志
    logging.getLogger('werkzeug').setLevel(logging.ERROR)
    
    app.logger.info("=" * 60)
    app.logger.info("WindSight 日志系统已初始化")
    app.logger.info(f"日志级别: {app.config['LOG_LEVEL']}")
    app.logger.info(f"日志文件: {app.config['LOG_FILE']}")
    app.logger.info("=" * 60)

setup_logging()

# ==================== 数据库初始化 ====================
db.init_app(app)

# ==================== CORS配置 ====================
allowed_origins = app.config['ALLOWED_ORIGINS']
if allowed_origins == '*':
    CORS(app)
    app.logger.warning("CORS: 允许所有来源（开发环境）")
else:
    origins_list = [origin.strip() for origin in allowed_origins.split(',')]
    CORS(app, origins=origins_list)
    app.logger.info(f"CORS: 限制为 {origins_list}")

# ==================== Flask-SocketIO 初始化 ====================
def _select_async_mode():
    """
    选择 SocketIO 异步模式（eventlet / gevent / threading）
    
    说明（非常重要）：
    - 在 Windows + Python 3.12+（你当前是 3.14）环境下，eventlet 0.33.x 可能因标准库变更而无法导入/运行，
      常见报错包括：
      - ModuleNotFoundError: No module named 'distutils'
      - AttributeError: module 'ssl' has no attribute 'wrap_socket'
    - 因此默认采用“自动探测”，并提供 FORCE_ASYNC_MODE 环境变量用于强制指定。
    
    环境变量：
    - FORCE_ASYNC_MODE=auto|eventlet|gevent|threading
      - auto（默认）：按 eventlet -> gevent -> threading 顺序尝试
      - eventlet/gevent/threading：强制使用；若失败将直接抛错，避免“悄悄回退”造成误判
    """
    import sys
    force = os.environ.get('FORCE_ASYNC_MODE', 'auto').strip().lower()
    app.logger.info(f"Python版本: {sys.version}")
    app.logger.info(f"FORCE_ASYNC_MODE={force}")

    def _try_eventlet():
        import eventlet  # noqa: F401
        # Windows + SQLAlchemy 场景下，thread 相关 monkey_patch 有概率导致锁语义差异，
        # 进而触发 “cannot notify on un-acquired lock”。
        # 这里禁用 thread patch，只保留 socket/select/time 等 I/O 相关 patch。
        eventlet.monkey_patch(thread=False)
        return 'eventlet'

    def _try_gevent():
        import gevent  # noqa: F401
        return 'gevent'

    if force in ('threading', 'gevent', 'eventlet'):
        try:
            if force == 'eventlet':
                mode = _try_eventlet()
            elif force == 'gevent':
                mode = _try_gevent()
            else:
                mode = 'threading'
            app.logger.info(f"异步模式(强制): {mode}")
            return mode
        except Exception as e:
            # 强制模式失败：直接抛错，避免误以为已启用 eventlet/gevent
            app.logger.exception(f"强制异步模式失败: {force} - {e}")
            raise RuntimeError(
                f"强制异步模式失败: {force}。"
                f"当前Python={sys.version}。"
                f"若要使用 eventlet，建议使用 Python 3.10/3.11 重新创建虚拟环境。"
            ) from e

    # auto：依次尝试
    try:
        mode = _try_eventlet()
        app.logger.info("使用 eventlet 异步模式")
        return mode
    except Exception as e:
        app.logger.warning(f"eventlet 不可用，回退尝试 gevent: {e}")

    try:
        mode = _try_gevent()
        app.logger.info("使用 gevent 异步模式")
        return mode
    except Exception as e:
        app.logger.warning(f"gevent 不可用，回退到 threading: {e}")
        return 'threading'


ASYNC_MODE = _select_async_mode()

socketio_cors_origins = app.config['ALLOWED_ORIGINS']
if socketio_cors_origins != '*':
    socketio_cors_origins = [origin.strip() for origin in socketio_cors_origins.split(',')]

socketio = SocketIO(
    app,
    cors_allowed_origins=socketio_cors_origins,
    async_mode=ASYNC_MODE,
    logger=False,
    engineio_logger=False,
    ping_timeout=app.config['SOCKET_PING_TIMEOUT'],
    ping_interval=app.config['SOCKET_PING_INTERVAL'],
    max_http_buffer_size=int(app.config['MAX_HTTP_BUFFER_SIZE']),
    transports=['websocket', 'polling'],
    allow_upgrades=True,
    cookie=None,
    max_connections=app.config['MAX_CONNECTIONS'],
    compression=True,
    cors_credentials=False
)

# ==================== Flask-Login 初始化 ====================
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'auth.login'
login_manager.login_message = '请先登录以访问此页面。'
login_manager.login_message_category = 'info'

@login_manager.user_loader
def load_user(user_id):
    """Flask-Login 需要的用户加载函数"""
    return User.query.get(int(user_id))

# ==================== 全局变量（节点管理） ====================
active_nodes = {}
node_commands = {}
NODE_TIMEOUT = 10

# ==================== 后台任务线程池 ====================
db_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="DB-Worker")

# ==================== 注册蓝图 ====================
from edgewind.routes.auth import auth_bp
from edgewind.routes.pages import pages_bp
from edgewind.routes.api import api_bp, init_api_blueprint

# 初始化API蓝图
init_api_blueprint(app, socketio, db_executor, active_nodes, node_commands)

# 注册蓝图
app.register_blueprint(auth_bp)
app.register_blueprint(pages_bp)
app.register_blueprint(api_bp)

app.logger.info("所有路由蓝图已注册")

# ==================== WebSocket事件初始化 ====================
from edgewind.socket_events import init_socket_events
init_socket_events(socketio, active_nodes)
app.logger.info("WebSocket事件处理器已初始化")

# ==================== 数据库初始化 ====================
with app.app_context():
    db.create_all()

    # ==================== 数据库清理（去除旧项目残留）====================
    # 说明：
    # - 你反馈“数据库里还有很多原本项目的数据”，典型表现是残留旧表：
    #   devices / datapoints / work_orders / fault_snapshots
    # - WindSight 最终需求只需要：users / system_config / node_data
    # - 这里做“启动期清理”，确保即使 DB 文件被旧版本污染，也会自动修正
    # - 注意：默认只删除旧表，不会清空 node_data（避免你重启服务器时历史波形被清掉）
    #   如需“重置数据表”，请设置环境变量：WINDSIGHT_CLEAN_DB_ON_START=1
    try:
        # 1) 删除旧表（若存在就删；不存在也不会报错）
        legacy_tables = ["devices", "datapoints", "work_orders", "fault_snapshots"]
        for t in legacy_tables:
            db.session.execute(text(f"DROP TABLE IF EXISTS {t}"))

        # 2) 可选：清空数据表（保留用户表，避免把默认账号也清掉）
        #    仅在显式开启 WINDSIGHT_CLEAN_DB_ON_START=1 时执行
        do_reset = (os.environ.get("WINDSIGHT_CLEAN_DB_ON_START", "0").strip() == "1")
        if do_reset:
            db.session.execute(text("DELETE FROM node_data"))
            db.session.execute(text("DELETE FROM system_config"))

        db.session.commit()
        if do_reset:
            app.logger.info("数据库清理完成：已移除旧表并清空 node_data/system_config（保留 users）")
        else:
            app.logger.info("数据库清理完成：已移除旧表（未清空 node_data）")
    except Exception as e:
        db.session.rollback()
        app.logger.warning(f"数据库清理失败（可忽略，不影响启动）：{e}")
    
    # 创建默认管理员账户（用于首次登录）
    # 说明：
    # - 为了便于演示/部署，这里支持“首次启动自动创建管理员”
    # - 公开仓库不再写死默认密码，请通过环境变量指定；未指定则生成随机密码并打印到日志
    default_admin_enabled = (os.environ.get("WINDSIGHT_DEFAULT_ADMIN_ENABLED", "1").strip() == "1")
    default_admin_username = (os.environ.get("WINDSIGHT_DEFAULT_ADMIN_USERNAME", "WindSight") or "WindSight").strip()
    default_admin_password = (os.environ.get("WINDSIGHT_DEFAULT_ADMIN_PASSWORD") or "").strip()

    def _gen_password(min_len: int = 12) -> str:
        """
        生成一个满足常见密码策略的随机密码（至少包含：大写/小写/数字）。
        说明：本项目默认不强制特殊字符，因此无需包含符号也可通过验证。
        """
        min_len = max(8, int(min_len or 12))
        alphabet = string.ascii_letters + string.digits
        pw = [
            secrets.choice(string.ascii_uppercase),
            secrets.choice(string.ascii_lowercase),
            secrets.choice(string.digits),
        ]
        for _ in range(max(0, min_len - len(pw))):
            pw.append(secrets.choice(alphabet))
        secrets.SystemRandom().shuffle(pw)
        return "".join(pw)

    # 兼容迁移：历史版本使用 Edge_Wind 作为默认账号
    admin = User.query.filter_by(username=default_admin_username).first()
    legacy_admin = User.query.filter_by(username='Edge_Wind').first()

    if default_admin_enabled and (not admin) and legacy_admin:
        try:
            legacy_admin.username = default_admin_username
            db.session.commit()
            app.logger.info(f"默认管理员账户已迁移（用户名已改为 {default_admin_username}，密码保持不变）")
        except Exception as e:
            db.session.rollback()
            app.logger.warning(f"迁移默认管理员失败: {e}")

    admin = User.query.filter_by(username=default_admin_username).first()
    if default_admin_enabled and (not admin):
        admin = User(username=default_admin_username)
        try:
            # 若未指定默认密码，则生成随机密码（更适合公开仓库/生产部署）
            if not default_admin_password:
                min_len = int(app.config.get("PASSWORD_MIN_LENGTH", 12) or 12)
                default_admin_password = _gen_password(min_len=min_len)
                app.logger.warning(
                    f"未设置 WINDSIGHT_DEFAULT_ADMIN_PASSWORD，已为首次启动生成随机管理员密码：{default_admin_password}"
                )
                app.logger.warning("请尽快登录后修改密码，或在 edgewind.env 中设置固定管理员密码。")

            admin.set_password(default_admin_password, app.config)
            db.session.add(admin)
            db.session.commit()
            app.logger.info(f"默认管理员账户已创建（用户名：{default_admin_username}）")
        except ValueError as e:
            app.logger.warning(f"创建默认管理员失败: {e}")
    else:
        if default_admin_enabled:
            app.logger.info(f"管理员账户已存在（{default_admin_username}）")
        else:
            app.logger.info("已关闭默认管理员自动创建（WINDSIGHT_DEFAULT_ADMIN_ENABLED=0）")

app.logger.info("数据库初始化完成")

# ==================== 后台定时任务 ====================
def auto_cleanup_old_data():
    """后台定时任务：自动清理过期数据（仅清理 NodeData）"""
    from edgewind.models import NodeData
    from datetime import timedelta, datetime
    
    while True:
        try:
            time.sleep(86400)  # 24小时
            
            with app.app_context():
                retention_days = app.config['DATA_RETENTION_DAYS']
                
                if retention_days <= 0:
                    continue
                
                cutoff_date = datetime.utcnow() - timedelta(days=retention_days)
                
                deleted = NodeData.query.filter(NodeData.timestamp < cutoff_date).delete(synchronize_session=False)
                
                db.session.commit()
                app.logger.info(f"[AutoCleanup] 清理完成：node_data_deleted={int(deleted or 0)}")
                
        except Exception as e:
            app.logger.error(f"[AutoCleanup] 失败: {str(e)}")
            db.session.rollback()

# 启动后台清理任务
cleanup_thread = threading.Thread(target=auto_cleanup_old_data, daemon=True, name="AutoCleanup")
cleanup_thread.start()
app.logger.info("后台定时清理任务已启动")

# ==================== 应用启动 ====================
if __name__ == '__main__':
    # 尝试多个端口
    PORT = int(os.environ.get('PORT', 5000))  # 默认改回5000（与模拟器默认一致）
    
    print("=" * 60)
    print("WindSight 智风监测系统启动")
    print(f"访问地址: http://localhost:{PORT}")
    print(f"模式: {'开发' if app.debug else '生产'}")
    print(f"异步: {ASYNC_MODE}")
    print("=" * 60)
    
    app.logger.info(f"准备在端口 {PORT} 启动服务器...")
    
    try:
        socketio.run(
            app,
            host='0.0.0.0',
            port=PORT,
            debug=False,
            use_reloader=False,
            log_output=False,
            allow_unsafe_werkzeug=True
        )
    except OSError as e:
        winerror = getattr(e, 'winerror', None)
        if 'address already in use' in str(e).lower() or winerror == 10048:
            print(f"\n错误: 端口 {PORT} 被占用（WinError 10048）！")
            print("解决方法:")
            print("1. 关闭/结束占用端口的程序（Windows 上 PID=4 的 System 通常无法结束）")
            print("2. 或改用备用端口，例如: set PORT=5002")
            app.logger.error(f"端口 {PORT} 被占用: {e}")
        else:
            raise
