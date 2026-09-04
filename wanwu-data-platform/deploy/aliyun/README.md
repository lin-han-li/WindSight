# Alibaba Cloud Linux 3 deployment assets

These assets deploy the current application as an isolated `wanwu` service. They
never replace existing Nginx virtual hosts or reuse another project's Python
runtime, data directory, service name, port, or certificates.

## Server layout

```text
/opt/wanwu-shuju/current/server   application source
/opt/wanwu-shuju/venv           Python 3.11 virtual environment
/etc/wanwu-shuju/               production environment file
/var/lib/wanwu-shuju/           SQLite database
/var/log/wanwu-shuju/           application logs
```

## Prepare the host

```bash
sudo dnf install -y python3.11 python3.11-pip
sudo useradd --system --home-dir /opt/wanwu-shuju --shell /sbin/nologin wanwu
sudo install -d -o wanwu -g wanwu /opt/wanwu-shuju /var/lib/wanwu-shuju /var/log/wanwu-shuju
sudo install -d -m 750 /etc/wanwu-shuju
python3.11 -m venv /opt/wanwu-shuju/venv
/opt/wanwu-shuju/venv/bin/pip install --upgrade pip
```

Upload a release archive, extract it so `server/` resides at
`/opt/wanwu-shuju/current/server`, then install dependencies:

```bash
sudo -u wanwu /opt/wanwu-shuju/venv/bin/pip install -r /opt/wanwu-shuju/current/deploy/aliyun/requirements-production.txt
```

Copy `wanwu-shuju.env.example` to `/etc/wanwu-shuju/wanwu-shuju.env`, replace
all placeholders, and set mode `600` with ownership `root:wanwu`.

## Enable the application

```bash
sudo install -m 644 wanwu-shuju.service /etc/systemd/system/wanwu-shuju.service
sudo systemctl daemon-reload
sudo systemctl enable --now wanwu-shuju
sudo systemctl status wanwu-shuju --no-pager
curl -I http://127.0.0.1:8088/login
```

## Nginx

Choose a **new hostname** and create its DNS A record before installing the
vhost. Replace `DOMAIN` in `wanwu-shuju.nginx.conf.template`, ensure the
`map` is declared just once under Nginx's `http {}` block, then install it as
an independent configuration file:

```bash
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

Add the HTTPS virtual host and certificate after the DNS record resolves.
Keep the app itself on `127.0.0.1:8088`; only Nginx needs public 80/443.

## Single worker requirement

The application intentionally runs one Eventlet worker: SQLite, online source
state, and Socket.IO rooms are in process. Do not raise the Gunicorn worker
count unless shared storage and a Socket.IO message queue have been added.
