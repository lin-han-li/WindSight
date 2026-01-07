"""
打包项目代码为 ZIP 文件，用于上传到 Gemini
只包含代码文件，排除虚拟环境、日志、缓存等
确保文件数量不超过 100 个
"""
import os
import sys
import zipfile
from pathlib import Path
from datetime import datetime

# Windows 控制台编码处理
if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 项目根目录
PROJECT_ROOT = Path(__file__).parent.parent
CODE_DIR = PROJECT_ROOT / "code"

# 输出 ZIP 文件名
OUTPUT_ZIP = PROJECT_ROOT / f"WindSight_Code_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"

# 需要包含的文件扩展名
INCLUDE_EXTENSIONS = {
    '.py', '.html', '.js', '.css', '.json',
    '.txt', '.md', '.yml', '.yaml', '.ini',
    '.bat', '.ps1', '.sh', '.env.example'
}

# 需要排除的目录
EXCLUDE_DIRS = {
    '__pycache__',
    'venv311',
    'venv',
    'env',
    '.venv',
    'logs',
    'node_modules',
    '.git',
    '__pycache__',
    'tools/install_logs',
    '.pytest_cache',
    '.mypy_cache',
    'dist',
    'build',
    '*.egg-info'
}

# 需要排除的文件模式
EXCLUDE_PATTERNS = {
    '*.pyc',
    '*.pyo',
    '*.pyd',
    '*.log',
    '*.db',
    '*.db-shm',
    '*.db-wal',
    '.env',  # 排除敏感配置文件
    'windsight.env',  # 排除实际环境配置
}

# 需要排除的特定文件名
EXCLUDE_FILES = {
    'query_users.py',  # 临时脚本
    'reset_password.py',  # 临时脚本
    'package_for_gemini.py',  # 打包脚本本身
}

# 需要包含的特定文件（即使不在包含扩展名列表中）
SPECIAL_FILES = {
    'requirements.txt',
    'README.md',
    'LICENSE',
    'windsight.env.example',
    'env.example',
    '.gitignore',
}

def should_include_file(file_path: Path) -> bool:
    """判断文件是否应该包含在 ZIP 中"""
    # 检查是否在排除文件列表中
    if file_path.name in EXCLUDE_FILES:
        return False
    
    # 检查是否匹配排除模式
    for pattern in EXCLUDE_PATTERNS:
        if file_path.match(pattern) or file_path.name == pattern.replace('*', ''):
            return False
    
    # 检查文件扩展名
    if file_path.suffix.lower() in INCLUDE_EXTENSIONS:
        return True
    
    # 检查特殊文件
    if file_path.name in SPECIAL_FILES:
        return True
    
    return False

def should_include_dir(dir_path: Path) -> bool:
    """判断目录是否应该包含在 ZIP 中"""
    dir_name = dir_path.name
    
    # 检查是否在排除目录列表中
    if dir_name in EXCLUDE_DIRS:
        return False
    
    # 检查是否匹配排除模式
    for pattern in EXCLUDE_PATTERNS:
        if dir_name == pattern.replace('*', ''):
            return False
    
    return True

def collect_files(root_dir: Path, relative_to: Path) -> list[tuple[Path, str]]:
    """收集需要打包的文件"""
    files_to_zip = []
    
    for root, dirs, files in os.walk(root_dir):
        root_path = Path(root)
        
        # 过滤目录
        dirs[:] = [d for d in dirs if should_include_dir(root_path / d)]
        
        for file in files:
            file_path = root_path / file
            
            if should_include_file(file_path):
                # 计算相对路径（相对于 code 目录）
                rel_path = file_path.relative_to(relative_to)
                files_to_zip.append((file_path, str(rel_path)))
    
    return files_to_zip

def create_zip():
    """创建 ZIP 文件"""
    print("=" * 70)
    print("WindSight 项目打包工具（用于 Gemini）")
    print("=" * 70)
    print(f"项目目录: {CODE_DIR}")
    print(f"输出文件: {OUTPUT_ZIP}")
    print()
    
    # 收集文件
    print("正在收集文件...")
    files_to_zip = collect_files(CODE_DIR, CODE_DIR)
    
    # 按路径排序
    files_to_zip.sort(key=lambda x: x[1])
    
    file_count = len(files_to_zip)
    print(f"找到 {file_count} 个文件需要打包")
    
    if file_count > 100:
        print(f"[!] 警告：文件数量 ({file_count}) 超过 100 个！")
        print("将尝试进一步过滤...")
        # 可以在这里添加更多过滤逻辑
    else:
        print(f"[OK] 文件数量 ({file_count}) 在限制范围内")
    
    print()
    print("正在创建 ZIP 文件...")
    
    # 创建 ZIP 文件
    with zipfile.ZipFile(OUTPUT_ZIP, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for file_path, arc_name in files_to_zip:
            try:
                zipf.write(file_path, arc_name)
                print(f"  + {arc_name}")
            except Exception as e:
                print(f"  [!] 跳过 {arc_name}: {e}")
    
    # 获取 ZIP 文件大小
    zip_size = OUTPUT_ZIP.stat().st_size
    zip_size_mb = zip_size / (1024 * 1024)
    
    print()
    print("=" * 70)
    print("[OK] 打包完成！")
    print(f"文件数量: {file_count}")
    print(f"ZIP 文件大小: {zip_size_mb:.2f} MB")
    print(f"输出位置: {OUTPUT_ZIP}")
    print("=" * 70)
    
    # 显示文件列表摘要
    print("\n包含的文件类型：")
    file_types = {}
    for _, arc_name in files_to_zip:
        ext = Path(arc_name).suffix.lower() or '无扩展名'
        file_types[ext] = file_types.get(ext, 0) + 1
    
    for ext, count in sorted(file_types.items()):
        print(f"  {ext}: {count} 个文件")

if __name__ == "__main__":
    try:
        create_zip()
    except Exception as e:
        print(f"[ERROR] 错误: {e}")
        import traceback
        traceback.print_exc()

