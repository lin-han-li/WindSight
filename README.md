# WindSight：风电演示与万物数驱

本仓库包含两个可独立启动的项目：

| 项目 | 目录 | 说明 |
| --- | --- | --- |
| WindSight 风力发电机演示版 | [`wind-turbine-demo/`](./wind-turbine-demo/) | 节点、风机、固定四指标监测与历史回放 |
| 万物数驱通用数据平台 | [`wanwu-data-platform/`](./wanwu-data-platform/) | 任意设备 JSON、动态字段、语义单位、实时与历史曲线 |

## 分支说明

当前页面属于 `codex/two-projects-release`，用于分别获取两个独立项目。原始 WindSight 工程和原有模拟器仍完整保留在 [`main`](https://github.com/lin-han-li/WindSight/tree/main)，其目录路径不变。详细切换和获取方法见 [`分支说明.md`](./分支说明.md)。
## 快速开始

克隆仓库后，进入对应项目目录并阅读 `使用说明.md`：

```bash
git clone https://github.com/lin-han-li/WindSight.git
cd WindSight
```

- 风电协议与模拟器：`wind-turbine-demo/使用说明.md`
- 任意传感器 JSON：`wanwu-data-platform/使用说明.md`
- 万物数驱页面操作与终端接入：[wanwu-data-platform/操作文档.md](./wanwu-data-platform/操作文档.md)
- 万物数驱字段参数与当前无认证上传：[数据上传协议.md](./wanwu-data-platform/数据上传协议.md)
- 服务器部署、节点认证和完整上报协议：[`部署与终端节点上传协议.md`](./部署与终端节点上传协议.md)
- 风电版 Alibaba Cloud Linux 3 部署模板：[`wind-turbine-demo/deploy/aliyun/`](./wind-turbine-demo/deploy/aliyun/)
- 万物数驱 Alibaba Cloud Linux 3 部署模板：[`wanwu-data-platform/deploy/aliyun/`](./wanwu-data-platform/deploy/aliyun/)

两个项目不共享数据库、端口、虚拟环境或环境变量。仓库不包含密码、云端访问凭据、SSH 配置、数据库、日志或虚拟环境。
