"""
应用配置模块
集中管理所有配置项，支持环境变量
"""
import os
import secrets
from sqlalchemy.pool import NullPool

class Config:
    """应用配置类（支持环境变量）"""
    
    # ==================== 安全配置 ====================
    # 说明：
    # - 生产环境务必设置环境变量 SECRET_KEY（否则会导致会话/登录状态在重启后失效）
    # - 为了避免把“固定弱口令密钥”写死到公开仓库，这里在未配置时自动生成随机密钥（仅适合本地/演示）
    _sk = (os.environ.get('SECRET_KEY') or '').strip()
    SECRET_KEY = _sk if _sk else secrets.token_urlsafe(32)
    
    # ==================== 数据库配置 ====================
    # 重要：默认使用 instance/ 目录下的数据库文件，保持与原项目一致（避免“看起来没有识别到数据库”的错觉）
    # 如需自定义数据库路径，请设置环境变量 DATABASE_URL
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL', 'sqlite:///instance/windsight.db')

    # ==================== SQLite 路径稳健性处理（Windows 重点）====================
    # 说明：
    # - sqlite:///xxx.db 这种相对路径会依赖“当前工作目录”，不同启动方式（IDE/脚本/服务）
    #   可能导致 CWD 不同，从而出现 sqlite3.OperationalError: unable to open database file。
    # - 这里把相对路径统一转换为“项目根目录的绝对路径”，并确保目录存在。
    if isinstance(SQLALCHEMY_DATABASE_URI, str) and SQLALCHEMY_DATABASE_URI.startswith("sqlite:///"):
        rel_path = SQLALCHEMY_DATABASE_URI[len("sqlite:///"):]
        # 仅处理相对路径，绝对路径（例如 C:/xxx.db 或 /xxx.db）保持不变
        if rel_path and not os.path.isabs(rel_path):
            project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
            abs_db_path = os.path.abspath(os.path.join(project_root, rel_path))
            os.makedirs(os.path.dirname(abs_db_path), exist_ok=True)
            # SQLAlchemy 在 Windows 下更推荐使用正斜杠
            abs_db_path_norm = abs_db_path.replace("\\", "/")
            SQLALCHEMY_DATABASE_URI = f"sqlite:///{abs_db_path_norm}"
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        'connect_args': {
            'timeout': int(os.environ.get('DB_TIMEOUT', 20)),
            'check_same_thread': False
        },
        'pool_pre_ping': False
    }

    # ==================== eventlet + SQLite 兼容性（Windows 推荐）====================
    # 说明：
    # - 当使用 eventlet（特别是 Windows 环境）时，SQLAlchemy 默认连接池内部 Condition/Lock
    #   有概率触发 “cannot notify on un-acquired lock” 这类兼容性问题。
    # - 对 SQLite 来说，禁用连接池（NullPool）更安全，也符合 SQLite 的典型使用方式。
    # - 这里用环境变量 FORCE_ASYNC_MODE 判断（在启动脚本中已设置为 eventlet）。
    if os.environ.get('FORCE_ASYNC_MODE', 'auto').strip().lower() == 'eventlet' and \
       str(SQLALCHEMY_DATABASE_URI).startswith('sqlite'):
        SQLALCHEMY_ENGINE_OPTIONS['poolclass'] = NullPool
    
    # ==================== Flask 性能优化 ====================
    JSONIFY_PRETTYPRINT_REGULAR = False
    SEND_FILE_MAX_AGE_DEFAULT = 300
    
    # ==================== 跨域配置 ====================
    ALLOWED_ORIGINS = os.environ.get('ALLOWED_ORIGINS', '*')
    
    # ==================== 数据保留配置 ====================
    DATA_RETENTION_DAYS = int(os.environ.get('DATA_RETENTION_DAYS', 30))
    
    # ==================== 密码策略配置 ====================
    PASSWORD_MIN_LENGTH = int(os.environ.get('PASSWORD_MIN_LENGTH', 8))
    PASSWORD_REQUIRE_UPPERCASE = os.environ.get('PASSWORD_REQUIRE_UPPERCASE', 'True').lower() == 'true'
    PASSWORD_REQUIRE_DIGITS = os.environ.get('PASSWORD_REQUIRE_DIGITS', 'True').lower() == 'true'
    PASSWORD_REQUIRE_SPECIAL = os.environ.get('PASSWORD_REQUIRE_SPECIAL', 'False').lower() == 'true'
    
    # ==================== 日志配置 ====================
    LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')
    LOG_FILE = os.environ.get('LOG_FILE', 'logs/windsight.log')
    
    # ==================== SocketIO 配置 ====================
    SOCKET_PING_TIMEOUT = int(os.environ.get('SOCKET_PING_TIMEOUT', 20))
    SOCKET_PING_INTERVAL = int(os.environ.get('SOCKET_PING_INTERVAL', 10))
    MAX_HTTP_BUFFER_SIZE = 2e6  # 2MB
    MAX_CONNECTIONS = 1000

