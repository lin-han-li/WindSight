# WindSight Mini Server 部署到阿里云（Ubuntu 24.04）

本文档面向 **Ubuntu 24.04**，将 `mini_server/` 部署到阿里云 ECS/轻量应用服务器，用于公网测试。

部署目标：

- 外网通过 **80 端口**访问：`http://<公网IP>/`
- 后端服务在本机 `127.0.0.1:5000` 监听
- 使用 **Nginx** 反向代理 + **systemd** 守护 + **gunicorn(eventlet)** 运行

---

## 1）阿里云侧设置

- 安全组放行：
  - `22`（SSH）
  - `80`（HTTP）
- 不建议放行 `5000`（让 Nginx 反代即可）

---

## 2）服务器安装依赖

```bash
sudo apt update -y
sudo apt install -y python3 python3-venv python3-pip nginx git
```

---

## 3）拉取代码并准备目录

建议放到 `/opt/WindSight`：

```bash
sudo mkdir -p /opt/WindSight
sudo chown -R $USER:$USER /opt/WindSight
cd /opt/WindSight
git clone <你的仓库地址> .
```

> 如果你已经把仓库放在其它路径，请在后续步骤中替换路径即可。

---

## 4）安装 mini_server 依赖（venv）

```bash
cd /opt/WindSight/mini_server
python3 -m venv venv
source venv/bin/activate
pip install -U pip
pip install -r requirements.txt
```

---

## 5）先手工试跑（确认能启动）

```bash
cd /opt/WindSight/mini_server
source venv/bin/activate
PORT=5000 gunicorn -k eventlet -w 1 -b 127.0.0.1:5000 app:app
```

保持该命令运行，另开一个 SSH 窗口执行：

```bash
curl -sS http://127.0.0.1:5000/ | head
```

确认 OK 后 `Ctrl+C` 停止 gunicorn，继续下一步。

---

## 6）systemd 服务（开机自启）

创建 service 文件：

```bash
sudo nano /etc/systemd/system/mini-windsight.service
```

写入（注意替换路径）：

```ini
[Unit]
Description=WindSight Mini Server (Flask-SocketIO)
After=network.target

[Service]
WorkingDirectory=/opt/WindSight/mini_server
Environment="PORT=5000"
ExecStart=/opt/WindSight/mini_server/venv/bin/gunicorn -k eventlet -w 1 -b 127.0.0.1:5000 app:app
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动并设为开机启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mini-windsight
sudo systemctl status mini-windsight --no-pager
```

查看日志：

```bash
sudo journalctl -u mini-windsight -f
```

---

## 7）Nginx 反向代理（支持 WebSocket）

创建站点配置：

```bash
sudo nano /etc/nginx/sites-available/mini-windsight
```

内容（无域名就写公网 IP；有域名再换成域名）：

```nginx
server {
  listen 80;
  server_name _;

  location / {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Socket.IO / WebSocket
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300;
  }
}
```

启用并重载：

```bash
sudo ln -sf /etc/nginx/sites-available/mini-windsight /etc/nginx/sites-enabled/mini-windsight
sudo nginx -t
sudo systemctl reload nginx
```

---

## 8）访问与测试

### 打开页面

- `http://<公网IP>/?node_id=WIND_001`

### 上报数据（从本地/模拟器发送）

```bash
curl -X POST "http://<公网IP>/api/upload" \
  -H "Content-Type: application/json" \
  -d '{"node_id":"WIND_001","note":"hello aliyun"}'
```

---

## 常见问题

### 1）页面显示 “未加载 Socket.IO 客户端库”

说明服务器无法访问 `https://cdn.socket.io/4.7.5/socket.io.min.js`。可选方案：

- 换成你能访问的 CDN（建议国内可用 CDN）
- 或将 `socket.io.min.js` 放到 `mini_server/static/` 并在 `templates/index.html` 改为本地引用

### 2）WebSocket 不通/一直断线

- 必须确保 Nginx 配置里有：
  - `proxy_set_header Upgrade $http_upgrade;`
  - `proxy_set_header Connection "upgrade";`

### 3）端口冲突

- `mini-windsight.service` 里监听的是 `127.0.0.1:5000`
- Nginx 监听 `80`
- 若 `5000` 被占用，先 `sudo lsof -i :5000` 查占用，再调整端口
