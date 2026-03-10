# WindSight Mini Server（接收服务器）— 全面介绍

`mini_server/` 是一个**独立可运行**的最小接收服务，用于教学/演示/上云测试。

它的目标很明确：

- 接收终端/模拟器通过 HTTP 上报的 JSON 数据
- 按 `node_id` 将数据通过 Socket.IO 实时推送给网页
- 页面同时展示：**原始 JSON（纯文本）**与**解析摘要**

> 不依赖数据库、不需要登录，方便快速部署与联调。

---

## 功能清单

- **HTTP 上报接口**：`POST /api/upload`
- **WebSocket 实时推送**：Socket.IO 事件 `mini_update`（按房间 `node_<node_id>` 推送）
- **单页面展示**：`GET /?node_id=WIND_001`
  - 统计卡片：当前节点 / 连接状态 / 已接收帧数 / 最近接收时间
  - 2 个区域：解析摘要 / 原始 JSON
  - 按钮：清空显示（仅清前端）

---

## 目录结构

- `app.py`：后端入口（Flask + Flask‑SocketIO）
- `templates/index.html`：单页面（中文 + 与原项目一致的 UI 风格）
- `static/app.js`：前端逻辑（订阅 node_id、接收推送、渲染 JSON）
- `requirements.txt`：依赖
- `server_ctl.ps1` / `server_toggle.bat` / `服务器开关.bat`：Windows 一键控制脚本（可自动创建 venv 并安装依赖）

---

## 上报协议（/api/upload）

### 1）最低要求（最宽松）

只要是合法 JSON，且包含：

- `node_id`：非空字符串

即可被接收并推送到页面。

示例：

```bash
curl -X POST "http://127.0.0.1:5000/api/upload" ^
  -H "Content-Type: application/json" ^
  -d "{\"node_id\":\"WIND_001\",\"note\":\"hello\"}"
```

### 2）兼容 WindSight 32 通道格式（可选）

如果 payload 中出现了 `voltages` / `currents` / `speeds` 任意一个字段，则要求：

- 三个字段必须**同时存在**
- 每个字段必须是**长度 32** 的数组
- 每个元素必须可转 `float`

示例（32 通道）：

```bash
curl -X POST "http://127.0.0.1:5000/api/upload" ^
  -H "Content-Type: application/json" ^
  -d "{\"node_id\":\"WIND_001\",\"voltages\":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],\"currents\":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],\"speeds\":[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]}"
```

返回：

- 成功：`{"status":"success"}`
- 失败：HTTP 400，返回 `{"status":"error","error":"..."}`（通常是 JSON 不合法、缺 node_id、或数组格式不对）

---

## 本地运行

### Windows（推荐：双击）

- 双击 `服务器开关.bat`
- 或命令行：
  - `server_toggle.bat start|stop|restart|status|toggle`

脚本会在本目录创建 `venv/` 并自动安装依赖。

### 手动运行（Windows / Linux 通用）

```bash
cd mini_server
python -m venv venv
venv\\Scripts\\activate   # Windows
# source venv/bin/activate  # Linux
pip install -r requirements.txt
python app.py
```

打开：

```text
http://127.0.0.1:5000/?node_id=WIND_001
```

---

## Socket.IO 版本说明（重要）

本项目后端使用 `flask-socketio==5.3.5`（Engine.IO v4），因此前端必须使用 **Socket.IO JS client v4**。

页面已固定加载：

- `https://cdn.socket.io/4.7.5/socket.io.min.js`

若部署环境无法访问外网 CDN，请改为本地引入（或换成你能访问的国内 CDN）。

---

## 部署到阿里云

详见：`DEPLOY_ALIYUN.md`
