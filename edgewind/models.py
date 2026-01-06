"""
数据库模型模块
定义所有SQLAlchemy数据库模型
"""
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
import json
import re

db = SQLAlchemy()

# ==================== 密码验证工具函数 ====================
def validate_password(password, config):
    """
    验证密码复杂度
    
    Args:
        password: 待验证的密码
        config: Flask config对象
    
    Returns:
        tuple: (is_valid: bool, message: str)
    """
    # 检查长度
    if len(password) < config['PASSWORD_MIN_LENGTH']:
        return False, f"密码长度至少{config['PASSWORD_MIN_LENGTH']}位"
    
    # 检查大写字母
    if config['PASSWORD_REQUIRE_UPPERCASE']:
        if not re.search(r'[A-Z]', password):
            return False, "密码必须包含至少一个大写字母"
    
    # 检查数字
    if config['PASSWORD_REQUIRE_DIGITS']:
        if not re.search(r'\d', password):
            return False, "密码必须包含至少一个数字"
    
    # 检查特殊字符
    if config['PASSWORD_REQUIRE_SPECIAL']:
        if not re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
            return False, "密码必须包含至少一个特殊字符"
    
    return True, "密码符合要求"


# ==================== 数据库模型 ====================

class User(UserMixin, db.Model):
    """用户表 - 用于身份认证"""
    __tablename__ = 'users'
    
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(200))
    
    def set_password(self, password, config):
        """设置密码（自动哈希，包含复杂度验证）"""
        # 验证密码复杂度
        is_valid, message = validate_password(password, config)
        if not is_valid:
            raise ValueError(message)
        
        self.password_hash = generate_password_hash(password)
    
    def check_password(self, password):
        """验证密码"""
        return check_password_hash(self.password_hash, password)


class SystemConfig(db.Model):
    """系统配置表"""
    __tablename__ = 'system_config'
    
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(100), unique=True, nullable=False, index=True)
    value = db.Column(db.Text)  # JSON格式存储配置值
    description = db.Column(db.String(200))
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class NodeData(db.Model):
    """
    终端上报数据表（WindSight 新核心）

    设计目标：
    - 每次上报是一帧“32通道电压/电流/转速”的瞬时值
    - 前端按时间轴回放：对选定 node_id + 选定通道，绘制三窗口曲线

    存储策略：
    - SQLite 兼容性优先，使用 Text 保存 JSON 字符串（避免不同数据库 JSON 类型差异）
    - 所有时间写入 UTC（datetime.utcnow），对外返回时再转北京时间
    """
    __tablename__ = 'node_data'

    id = db.Column(db.Integer, primary_key=True)
    node_id = db.Column(db.String(100), nullable=False, index=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)

    # JSON 字符串：长度固定 32 的数组
    voltage_data = db.Column(db.Text, nullable=False)
    current_data = db.Column(db.Text, nullable=False)
    speed_data = db.Column(db.Text, nullable=False)

    def to_dict(self):
        """转换为 API 输出格式（时间为北京时间 ISO，数组为 list[float]）。"""
        from edgewind.time_utils import iso_beijing
        return {
            'id': self.id,
            'node_id': self.node_id,
            # 说明：上报可能高于 1Hz（例如 500ms/帧），若只输出到“秒”，前端会出现同一时刻多点重叠，
            # tooltip 看起来像“同一通道同一时间有两个数据”。因此这里输出到毫秒。
            'timestamp': iso_beijing(self.timestamp, with_seconds=True, with_ms=True),
            'voltages': json.loads(self.voltage_data) if self.voltage_data else [],
            'currents': json.loads(self.current_data) if self.current_data else [],
            'speeds': json.loads(self.speed_data) if self.speed_data else [],
        }

