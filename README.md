# WindSight（智风监测系统）

基于 **Flask + Flask-SocketIO + SQLAlchemy(SQLite)** 的轻量级工业数据采集与可视化回放系统，支持节点数据上报、实时监测、历史回放、数据管理（清理/按节点删除/数据库压缩 VACUUM）。

> 说明：项目历史包名为 `edgewind/`，为降低重命名风险暂不改名。

## 功能概览

- **节点数据上报**：HTTP `POST /api/upload`（32 通道：电压/电流/转速）
- **实时监测**：WebSocket 推送 + 页面实时追加（`monitor_update`/`node_data_update`）
- **数据概览**：按节点/通道回放历史曲线（支持自定义缩放与 Grab 平移）
- **系统设置**：
  - 历史数据清理（按保留天数）
  - 按节点删除数据
  - 清空所有数据（高危）
  - **压缩数据库（VACUUM）**：释放 SQLite 磁盘空间

## 技术栈

- **后端**：Python 3.11、Flask、Flask-SocketIO、SQLAlchemy（SQLite）
- **前端**：HTML5、原生 JavaScript、Bootstrap 5、ECharts 5

## 目录结构（核心）

- `app.py`：后端入口（加载环境变量、初始化 Flask、注册蓝图、启动服务）
- `edgewind/`：后端业务模块
  - `routes/`：接口与页面路由
  - `models.py`：SQLAlchemy 模型（`User`/`SystemConfig`/`NodeData`）
- `templates/`：页面模板
- `static/js/`：前端逻辑（图表交互/Socket 订阅/回放）
- `sim.py`：模拟器（用于本地生成/上报测试数据）

## 本地运行（Windows 推荐）

### 1）创建并激活虚拟环境

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### 2）配置环境变量

复制模板：

```bash
copy env.example edgewind.env
```

至少建议修改：

- `SECRET_KEY`：必须改成随机强密钥（生产环境必做）
- `ALLOWED_ORIGINS`：生产环境不要长期用 `*`
- `DATABASE_URL`：默认 `sqlite:///instance/wind_farm.db`（已加入 `.gitignore`）

### 3）启动服务

```bash
python app.py
```

启动后访问：

- `http://localhost:5000`

### 默认管理员（首次启动）

系统支持首次启动自动创建管理员：

- `WINDSIGHT_DEFAULT_ADMIN_USERNAME`：默认 `WindSight`
- `WINDSIGHT_DEFAULT_ADMIN_PASSWORD`：
  - 若未设置，后端会生成随机密码并打印到日志（更安全）
  - 建议在 `edgewind.env` 中显式设置强密码

## 数据库大小为什么不变？

SQLite 的 `DELETE` 只会把空间标记为可复用，并不会自动缩小 `.db` 文件。需要执行 **VACUUM** 才会物理收缩。

本项目已提供：

- 设置页按钮：**压缩数据库（释放磁盘空间）**
- 后端接口：`POST /api/admin/vacuum`

## 推送到 GitHub 前的注意事项

- 不要提交本机配置：`edgewind.env` / `.env`（已在 `.gitignore` 排除）
- 不要提交数据库与日志：`instance/*.db`、`logs/*.log`（已在 `.gitignore` 排除）
- 不要提交虚拟环境：`venv*/`（已在 `.gitignore` 排除）


