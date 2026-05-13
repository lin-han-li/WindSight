# WindSight 子项目总览（用于拆分部署）

本仓库包含三个**完全独立**的小项目，用于教学/演示/上云测试：

## 1）`mini_server/`（接收服务器）

- **用途**：接收终端/模拟器上报的 JSON，并通过 Socket.IO 实时推送给浏览器页面；页面展示“原始 JSON + 解析摘要”。  
- **对外接口**：`POST /api/upload`  
- **协议**：最宽松，只要求合法 JSON 且包含非空 `node_id`；若使用旧版 `voltages/currents/speeds` 数组，则校验 32 通道格式。
- **页面**：`GET /?node_id=WIND_001`（单节点）或查看全部节点。
- **部署**：适合部署到阿里云（详见 `mini_server/DEPLOY_ALIYUN.md`）。  

## 2）`mini_one_node/`（新协议轻量接收 + 手动模拟）

- **用途**：无登录、无数据库的轻量接收端，严格校验当前 WindSight 新协议，并通过 Socket.IO 实时展示最新上报。
- **对外接口**：`POST /api/upload`
- **协议**：与主系统一致，要求 `node_id`、`sub`、连续 `001..NNN` 风机键，每台风机为 `[voltage, current, speed, temperature]`。
- **页面**：`GET /` 查看全部节点，或 `GET /?node_id=WIN_001` 过滤单节点。
- **模拟器**：内置 `sim.py` 与 `templates/simulator.html`，默认手动上报页面为 `http://127.0.0.1:5100`。

## 3）`mini_simulator/`（手动上报模拟器）

- **用途**：本地网页工具，手动填写目标 IP/端口/路径，粘贴任意 JSON，点击“发送”即可 POST 上报，并显示响应结果。  
- **协议**：默认示例生成当前新协议 payload，也保留自由 JSON 编辑能力。
- **页面**：默认 `http://127.0.0.1:5100`  
- **部署建议**：通常只需在本地运行；当然也可单独部署到服务器（安全起见建议限制访问）。  

## 兼容性说明

- `mini_server/` 的前端 Socket.IO 使用 v4 客户端（与 Flask‑SocketIO 5.x 协议匹配）。  
- `mini_one_node/` 与主系统使用同一类新协议校验逻辑，适合验证终端 payload 是否符合主系统要求。
- 三个项目互不依赖，不需要数据库、也不需要登录。
