# Alibaba Cloud Linux 3 部署材料

本目录用于把风电演示版部署为独立服务。它使用独立的 Linux 用户、Python
虚拟环境、SQLite 数据库、日志目录、Systemd 服务和 Nginx 虚拟主机，不会替换
同一台机器上的其他项目。

## 运行布局

```text
/opt/wind-turbine-demo/current/server   应用源码
/opt/wind-turbine-demo/venv             Python 3.11 虚拟环境
/etc/wind-turbine-demo/                 私有环境变量文件
/var/lib/wind-turbine-demo/             SQLite 数据库
/var/log/wind-turbine-demo/             应用日志
```

## 1. 打包并上传

在 `wind-turbine-demo/` 根目录执行：

```bash
python deploy/aliyun/build_release.py
```

得到 `release/wind-turbine-demo.tar.gz`。上传该压缩包到服务器的 `/tmp/`。
压缩包不会包含 `.env`、`windsight.env`、数据库、日志、缓存和虚拟环境。

## 2. 初始化服务器

以下命令以 Alibaba Cloud Linux 3 为例，要求主机安装 Python 3.11：

```bash
sudo dnf install -y python3.11 python3.11-pip
sudo useradd --system --home-dir /opt/wind-turbine-demo --shell /sbin/nologin winddemo
sudo install -d -o winddemo -g winddemo /opt/wind-turbine-demo /opt/wind-turbine-demo/releases
sudo install -d -o winddemo -g winddemo /var/lib/wind-turbine-demo /var/log/wind-turbine-demo
sudo install -d -m 750 -o root -g winddemo /etc/wind-turbine-demo
sudo python3.11 -m venv /opt/wind-turbine-demo/venv
sudo chown -R winddemo:winddemo /opt/wind-turbine-demo/venv
```

创建一个不可变的本次发布目录并解压：

```bash
STAMP=$(date -u +%Y%m%d%H%M%S)
RELEASE=/opt/wind-turbine-demo/releases/$STAMP
sudo install -d -m 750 -o winddemo -g winddemo "$RELEASE"
sudo tar -xzf /tmp/wind-turbine-demo.tar.gz -C "$RELEASE"
sudo chown -R winddemo:winddemo "$RELEASE"
sudo ln -sfn "$RELEASE" /opt/wind-turbine-demo/current
```

安装运行依赖：

```bash
sudo -u winddemo /opt/wind-turbine-demo/venv/bin/pip install --upgrade pip wheel 'setuptools>=70.0.0'
sudo -u winddemo /opt/wind-turbine-demo/venv/bin/pip install \
  -r /opt/wind-turbine-demo/current/deploy/aliyun/requirements-production.txt
```

## 3. 私有环境变量和服务

复制模板为服务器私有文件，替换所有密钥和密码：

```bash
sudo cp /opt/wind-turbine-demo/current/deploy/aliyun/wind-turbine-demo.env.example \
  /etc/wind-turbine-demo/wind-turbine-demo.env
sudo editor /etc/wind-turbine-demo/wind-turbine-demo.env
sudo chown root:winddemo /etc/wind-turbine-demo/wind-turbine-demo.env
sudo chmod 640 /etc/wind-turbine-demo/wind-turbine-demo.env
# 640 + root:winddemo 已允许 winddemo 通过所属组读取此文件。
```

安装并启动 Systemd 服务：

```bash
sudo install -m 644 /opt/wind-turbine-demo/current/deploy/aliyun/wind-turbine-demo.service \
  /etc/systemd/system/wind-turbine-demo.service
sudo systemctl daemon-reload
sudo systemctl enable --now wind-turbine-demo
sudo systemctl status wind-turbine-demo --no-pager
curl -I http://127.0.0.1:8081/login
```

该服务固定为 **一个 Eventlet/Gunicorn worker**。SQLite、在线状态和
Socket.IO 房间均在同一进程中；未接入共享存储和消息队列前，不应增加 worker 数。

## 4. Nginx 与实时连接

为新域名创建 A 记录，解析到服务器公网 IP。替换模板中的 `DOMAIN` 后安装为独立
虚拟主机：

```bash
sudo sed 's/DOMAIN/wind.example.com/g' \
  /opt/wind-turbine-demo/current/deploy/aliyun/wind-turbine-demo.nginx.conf.template \
  | sudo tee /etc/nginx/conf.d/wind-turbine-demo.conf >/dev/null
sudo nginx -t
sudo systemctl reload nginx
```

模板已为 `/socket.io/` 配置 WebSocket 反向代理；因此实时曲线和历史页使用同一
域名。应用只监听 `127.0.0.1:8081`，不要直接把该端口暴露到公网。

Nginx 直接提供静态资源时，需让 Nginx 用户能遍历发布目录并读取公开静态文件：

```bash
RELEASE=$(readlink -f /opt/wind-turbine-demo/current)
sudo chmod 711 /opt/wind-turbine-demo /opt/wind-turbine-demo/releases "$RELEASE" "$RELEASE/server"
sudo find "$RELEASE/server/static" -type d -exec chmod 755 {} \;
sudo find "$RELEASE/server/static" -type f -exec chmod 644 {} \;
```

DNS 生效后，先通过 `http://wind.example.com/login` 验证。需要 HTTPS 时，再为该
独立域名签发证书并添加对应的 `listen 443 ssl` 虚拟主机；不要复用不匹配该域名的
已有证书。

## 5. 更新与回滚

每次更新创建新的 `$RELEASE` 目录、安装依赖（若有变化）并切换 `current` 软链接，
然后重启服务：

```bash
sudo ln -sfn /opt/wind-turbine-demo/releases/<新时间戳> /opt/wind-turbine-demo/current
sudo systemctl restart wind-turbine-demo
```

回滚时将 `current` 指回上一个发布目录，再重启服务即可。数据库始终位于
`/var/lib/wind-turbine-demo/`，不随源码发布目录删除。
