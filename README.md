# 双项目教师交付仓库

本仓库按教学要求保留两个**可独立获取、独立启动、独立演示**的服务器项目：

| 目录 | 项目 | 用途 |
| --- | --- | --- |
| [`wind-turbine-demo/`](./wind-turbine-demo/) | WindSight 风力发电机演示版 | 固定风机协议、原四指标实时曲线与历史回放 |
| [`wanwu-data-platform/`](./wanwu-data-platform/) | 万物数驱通用数据平台 | 任意传感器/设备 JSON、动态字段、单位与语义、实时与历史曲线 |

两者不共享运行目录、数据库、虚拟环境或环境变量。请进入对应目录阅读各自的 `使用说明.md`。

## 获取与选择

```bash
git clone https://github.com/lin-han-li/WindSight.git
cd WindSight
```

- 想演示“风力发电机固定通道监测”：进入 `wind-turbine-demo`。
- 想演示“任意传感器节点数据类型”：进入 `wanwu-data-platform`。

> 两个目录都刻意不包含密码、AccessKey、SSH 配置、数据库、日志或虚拟环境。首次启动会在各自 `database/` 目录创建本地 SQLite 文件。

## 共用前提

- Python 3.11
- Windows PowerShell（下方示例）或等效的 Linux/macOS Shell
- 浏览器

## 仓库版本来源

- `wind-turbine-demo` 来源于上游 `main` 的 `e7d1660`；
- `wanwu-data-platform` 来源于万物数驱版本 `e395fde`；
- 两个版本以源码目录方式分别固定在仓库中，使用者无需切换 Git 分支。
