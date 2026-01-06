"""查询数据库中的用户信息"""
import sqlite3
import sys
from pathlib import Path

# 数据库路径
db_path = Path(__file__).parent.parent / 'database' / 'wind_farm.db'

try:
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    # 查询所有用户
    cursor.execute('SELECT id, username FROM users')
    users = cursor.fetchall()
    
    print("=" * 60)
    print("数据库中的用户账号：")
    print("=" * 60)
    
    if users:
        for user_id, username in users:
            print(f"ID: {user_id}, 用户名: {username}")
    else:
        print("未找到任何用户")
    
    print("=" * 60)
    print("\n注意：密码已加密存储，无法直接查看。")
    print("如果忘记密码，可以：")
    print("1. 查看日志文件 logs/windsight.log 中是否有首次创建时的随机密码")
    print("2. 或者在 windsight.env 中设置 WINDSIGHT_DEFAULT_ADMIN_PASSWORD 后重启服务器")
    
    conn.close()
except Exception as e:
    print(f"错误: {e}")
    sys.exit(1)

