"""重置用户密码脚本"""
import sys
import os
from pathlib import Path

# 添加当前目录到路径
BASE_DIR = Path(__file__).resolve().parent
os.chdir(str(BASE_DIR))

# 加载环境变量
try:
    from dotenv import load_dotenv
    load_dotenv(str(BASE_DIR / "windsight.env"))
    load_dotenv(str(BASE_DIR / ".env"))
except ImportError:
    pass

# 初始化Flask应用
from flask import Flask
from windsight.config import Config
from windsight.models import db, User

app = Flask(__name__)
app.config.from_object(Config)
db.init_app(app)

def reset_password(username, new_password):
    """重置指定用户的密码"""
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if not user:
            print(f"错误：用户 '{username}' 不存在")
            return False
        
        try:
            user.set_password(new_password, app.config)
            db.session.commit()
            print(f"✅ 成功重置用户 '{username}' 的密码")
            return True
        except ValueError as e:
            print(f"❌ 密码不符合要求: {e}")
            return False

def list_users():
    """列出所有用户"""
    with app.app_context():
        users = User.query.all()
        print("\n" + "=" * 60)
        print("当前数据库中的用户：")
        print("=" * 60)
        for user in users:
            print(f"  - {user.username} (ID: {user.id})")
        print("=" * 60 + "\n")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        list_users()
        print("用法: python reset_password.py <用户名> <新密码>")
        print("\n示例:")
        print("  python reset_password.py WindSight MyNewPassword123")
        sys.exit(1)
    
    username = sys.argv[1]
    new_password = sys.argv[2]
    
    list_users()
    reset_password(username, new_password)

