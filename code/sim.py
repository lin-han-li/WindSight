"""
WindSight 模拟器（sim.py）

用途：
- 按项目新协议，向服务器发送 32 通道数据（电压/电流/转速）
- 支持“动态节点管理”：运行中随时新增/移除节点（交互控制台）

协议：
POST /api/upload
{
  "node_id": "WIND_001",
  "voltages": [32个浮点数],
  "currents": [32个浮点数],
  "speeds":   [32个浮点数]
}

说明：
- WindSight 的“注册新节点”不需要 /api/register：只要开始向 /api/upload 上报，该 node_id 就会出现在系统里
- 本模拟器用于验证：HTTP 上报 -> SQLite 入库 -> Web 三窗口曲线回放
"""

from __future__ import annotations

import argparse
import math
import os
import random
import sys
import threading
import time
from dataclasses import dataclass

import requests


# Windows 控制台默认编码常为 GBK，遇到特殊字符时可能触发 UnicodeEncodeError。
# 这里统一把 stdout/stderr 设置为 UTF-8 并用 replace 兜底，避免 sim.py 直接崩溃。
if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _get_env_server_url() -> str:
    """从环境变量读取服务器地址（支持 WindSight/EdgeWind 旧名字）。"""
    keys = [
        "WINDSIGHT_SERVER_URL",
        "WINDSIGHT_SERVER",
        "EDGEWIND_SERVER_URL",
        "EDGEWIND_SERVER",
        "SERVER_URL",
    ]
    for k in keys:
        v = os.environ.get(k)
        if v and isinstance(v, str) and v.strip():
            return v.strip().rstrip("/")
    return "http://127.0.0.1:5000"


@dataclass
class NodeSimState:
    node_id: str
    seed: int
    rng: random.Random


def _gen_32ch_series(
    *,
    t: float,
    base: float,
    amp: float,
    noise: float,
    w_base: float,
    rng: random.Random,
) -> list[float]:
    """
    生成 32 通道数据（每通道一条“缓慢变化 + 可区分”的曲线）。
    - t：当前时间（秒）
    - base：基线
    - amp：幅值
    - noise：噪声标准差
    - w_base：基础角频率（决定变化快慢）
    """
    out: list[float] = []
    for ch in range(32):
        w = w_base * (1.0 + ch * 0.03)
        phase = ch * 0.25
        drift = 0.15 * math.sin(0.05 * t + ch * 0.1)  # 慢漂移
        val = base + drift + amp * math.sin(w * t + phase) + rng.gauss(0.0, noise)
        out.append(round(float(val), 4))
    return out


def build_payload(node: NodeSimState, t: float) -> dict:
    """构建单次上传 payload（严格 32 长度）。"""
    # 电压：风电场直流系统（690V 基准，范围约 650-750V），每通道略有差异
    # 690V 是常见的风电场直流电压等级
    voltages = _gen_32ch_series(
        t=t,
        base=690.0 + (hash(node.node_id) % 7) * 5.0,  # 690V ± 35V 基准差异
        amp=25.0,  # ±25V 波动幅度
        noise=1.5,  # 1.5V 噪声标准差
        w_base=0.8,
        rng=node.rng,
    )
    # 电流：风电场直流系统（100A 基准，范围约 80-120A）
    # 根据功率等级，风电场直流电流通常在几十到几百安培
    currents = _gen_32ch_series(
        t=t,
        base=100.0 + (hash(node.node_id) % 5) * 3.0,  # 100A ± 15A 基准差异
        amp=8.0,  # ±8A 波动幅度
        noise=0.5,  # 0.5A 噪声标准差
        w_base=1.1,
        rng=node.rng,
    )
    # 转速：风电机组转速（约 10-20 rpm，转换为更合理的范围）
    speeds = _gen_32ch_series(
        t=t,
        base=15.0 + (hash(node.node_id) % 9) * 0.5,  # 15 rpm ± 4.5 rpm 基准差异
        amp=2.0,  # ±2 rpm 波动幅度
        noise=0.1,  # 0.1 rpm 噪声标准差
        w_base=0.35,
        rng=node.rng,
    )

    return {"node_id": node.node_id, "voltages": voltages, "currents": currents, "speeds": speeds}


def upload_once(session: requests.Session, server_url: str, payload: dict, timeout: float = 3.0) -> tuple[bool, str]:
    """上传一次数据，返回 (ok, message)。"""
    url = f"{server_url.rstrip('/')}/api/upload"
    try:
        resp = session.post(url, json=payload, timeout=timeout)
        if resp.status_code == 200:
            try:
                data = resp.json()
                if data.get("status") == "success":
                    return True, "success"
                return True, f"ok_but_unexpected_response={data}"
            except Exception:
                return True, "ok_but_non_json"
        return False, f"status_code={resp.status_code}, body={resp.text[:200]}"
    except Exception as e:
        return False, f"request_error={type(e).__name__}: {e}"


class NodeWorker(threading.Thread):
    """单节点上报线程：持续向 /api/upload 推送 32 通道数据。"""

    def __init__(self, node: NodeSimState, server_url: str, interval_ms: int, timeout_s: float):
        super().__init__(daemon=True, name=f"NodeWorker-{node.node_id}")
        self.node = node
        self.server_url = server_url.rstrip("/")
        self.timeout_s = float(timeout_s)
        self._interval_s = max(0.05, float(interval_ms) / 1000.0)
        self._interval_lock = threading.Lock()
        self._stop_evt = threading.Event()
        self._session = requests.Session()

        # 统计信息：默认不打印“成功刷屏”，只做计数，供 stat 命令查看
        self._ok_count = 0
        self._err_count = 0
        self._last_error_msg: str | None = None
        self._last_error_at: float | None = None
        self._stats_lock = threading.Lock()

    def set_interval_ms(self, ms: int):
        v = max(50, int(ms))
        with self._interval_lock:
            self._interval_s = float(v) / 1000.0

    def stop(self):
        self._stop_evt.set()

    def run(self):
        while not self._stop_evt.is_set():
            now = time.time()
            payload = build_payload(self.node, now)
            ok, msg = upload_once(self._session, self.server_url, payload, timeout=self.timeout_s)
            if ok:
                with self._stats_lock:
                    self._ok_count += 1
            else:
                with self._stats_lock:
                    self._err_count += 1
                    self._last_error_msg = msg
                    self._last_error_at = now

            with self._interval_lock:
                sleep_s = self._interval_s
            # 分段 sleep，便于 stop 更快生效
            end_ts = time.time() + sleep_s
            while (not self._stop_evt.is_set()) and time.time() < end_ts:
                time.sleep(0.05)

    def snapshot(self) -> dict:
        """返回当前节点线程统计快照（用于 stat 命令）。"""
        with self._stats_lock:
            return {
                "node_id": self.node.node_id,
                "ok": int(self._ok_count),
                "err": int(self._err_count),
                "last_err": self._last_error_msg,
                "last_err_at": self._last_error_at,
            }


class NodeManager:
    """动态节点管理器：支持运行中 add/remove/list/interval。"""

    def __init__(self, server_url: str, interval_ms: int, timeout_s: float):
        self.server_url = server_url.rstrip("/")
        self.timeout_s = float(timeout_s)
        self._interval_ms = max(50, int(interval_ms))
        self._lock = threading.Lock()
        self._workers: dict[str, NodeWorker] = {}

    def _make_state(self, node_id: str) -> NodeSimState:
        nid = node_id.strip()
        seed = abs(hash(nid)) % (2**31)
        # 让不同节点噪声轨迹不同，但同一节点长期稳定
        rng = random.Random(seed ^ (int(time.time() * 1000) & 0x7FFFFFFF))
        return NodeSimState(node_id=nid, seed=seed, rng=rng)

    def list_nodes(self) -> list[str]:
        with self._lock:
            return sorted(self._workers.keys())

    def add_node(self, node_id: str) -> tuple[bool, str]:
        nid = (node_id or "").strip()
        if not nid:
            return False, "node_id 不能为空"
        with self._lock:
            if nid in self._workers:
                return False, f"节点已存在：{nid}"
            st = self._make_state(nid)
            w = NodeWorker(st, self.server_url, interval_ms=self._interval_ms, timeout_s=self.timeout_s)
            self._workers[nid] = w
            w.start()
        return True, f"节点已启动：{nid}"

    def remove_node(self, node_id: str) -> tuple[bool, str]:
        nid = (node_id or "").strip()
        if not nid:
            return False, "node_id 不能为空"
        with self._lock:
            w = self._workers.get(nid)
            if not w:
                return False, f"节点不存在：{nid}"
            w.stop()
            try:
                w.join(timeout=1.0)
            except Exception:
                pass
            self._workers.pop(nid, None)
        return True, f"节点已停止：{nid}"

    def set_interval_ms_all(self, ms: int) -> tuple[bool, str]:
        v = max(50, int(ms))
        with self._lock:
            self._interval_ms = v
            for w in self._workers.values():
                w.set_interval_ms(v)
        return True, f"已设置全局上报间隔：{v} ms"

    def stop_all(self):
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
        for w in workers:
            try:
                w.stop()
            except Exception:
                pass
        for w in workers:
            try:
                w.join(timeout=1.0)
            except Exception:
                pass

    def stats(self) -> list[dict]:
        """返回所有节点统计（按 node_id 排序）。"""
        with self._lock:
            workers = list(self._workers.values())
        out = [w.snapshot() for w in workers]
        out.sort(key=lambda x: x.get("node_id") or "")
        return out


def _parse_node_identifier(raw: str) -> str:
    """
    支持两种 add/remove 输入：
    - 纯数字：6 -> WIND_006
    - 直接 node_id：WIND_ABC
    """
    s = (raw or "").strip()
    if not s:
        return ""
    try:
        n = int(s)
        if n <= 0:
            return s
        return f"WIND_{n:03d}"
    except Exception:
        return s


def print_help():
    print("")
    print("可用命令：")
    print("  help                       显示帮助")
    print("  add <node_id|number>       动态新增节点并开始上报（例：add 1 或 add WIND_001）")
    print("  remove <node_id|number>    停止并移除节点（例：remove 1 或 remove WIND_001）")
    print("  list                       查看当前正在上报的节点列表")
    print("  stat                       查看各节点上报统计（成功/失败/最近错误）")
    print("  interval <ms>              设置全局上报间隔（毫秒，最小 50）")
    print("  quit / exit                退出模拟器（会停止所有节点线程）")
    print("")


def main():
    parser = argparse.ArgumentParser(description="WindSight 模拟器：32通道数据上报 + 动态节点管理")
    parser.add_argument("--server", type=str, default=None, help="服务器地址，例如 http://127.0.0.1:5000")
    parser.add_argument("--node-id", type=str, default="WIND_001", help="初始节点ID（nodes=1时使用）")
    parser.add_argument("--nodes", type=int, default=0, help="启动时预创建的节点数量（默认 0；建议后续用 add 动态添加）")
    parser.add_argument("--interval-ms", type=int, default=500, help="上报间隔（毫秒），默认 500ms")
    parser.add_argument("--once", action="store_true", help="仅上报一次后退出（不进入交互控制台）")
    parser.add_argument("--timeout", type=float, default=3.0, help="HTTP 超时时间（秒），默认 3")
    parser.add_argument("--no-console", action="store_true", help="禁用交互控制台（仅按 --nodes 启动，Ctrl+C 退出）")
    args = parser.parse_args()

    server_url = (args.server or _get_env_server_url()).rstrip("/")
    node_count = max(0, int(args.nodes))
    interval_ms = max(50, int(args.interval_ms))

    print("=" * 70)
    print("WindSight 模拟器已启动（动态节点管理器）")
    print(f"目标服务器: {server_url}")
    print(f"初始节点数量: {node_count}（0 表示不预创建，需手动 add 才开始上报）")
    print(f"上报间隔: {interval_ms} ms")
    print("提示：先启动服务器（双击 服务器开关.bat），再启动模拟器（双击 模拟器开关.bat）")
    print("=" * 70)

    # 一次性模式：仅上报一帧
    if args.once:
        session = requests.Session()
        ids: list[str]
        if node_count <= 0:
            # 即使 nodes=0，也允许用 --once 做一次单帧测试
            ids = [_parse_node_identifier(args.node_id) or "WIND_001"]
        elif node_count == 1:
            ids = [_parse_node_identifier(args.node_id) or "WIND_001"]
        else:
            ids = [f"WIND_{i:03d}" for i in range(1, node_count + 1)]
        ok_count = 0
        for nid in ids:
            seed = abs(hash(nid)) % (2**31)
            st = NodeSimState(node_id=nid, seed=seed, rng=random.Random(seed))
            payload = build_payload(st, time.time())
            ok, msg = upload_once(session, server_url, payload, timeout=float(args.timeout))
            if ok:
                ok_count += 1
            else:
                print(f"[{nid}] ❌ 上报失败：{msg}")
        print(f"[一次性] ✅ 完成：{ok_count}/{len(ids)}")
        return

    mgr = NodeManager(server_url, interval_ms=interval_ms, timeout_s=float(args.timeout))

    # 启动初始节点
    if node_count <= 0:
        print("当前未预创建节点。你可以直接输入：add 1  （将创建 WIND_001 并开始上报）")
    elif node_count == 1:
        nid = _parse_node_identifier(args.node_id) or "WIND_001"
        ok, msg = mgr.add_node(nid)
        print(("✅ " if ok else "⚠️  ") + msg)
    else:
        for i in range(1, node_count + 1):
            mgr.add_node(f"WIND_{i:03d}")
        print(f"✅ 已启动 {node_count} 个节点：WIND_001 ~ WIND_{node_count:03d}")

    try:
        if args.no_console:
            print("已禁用交互控制台（--no-console）。按 Ctrl+C 停止。")
            while True:
                time.sleep(1)

        print_help()
        while True:
            cmd = input("指令 > ").strip()
            if not cmd:
                continue
            parts = cmd.split()
            op = parts[0].lower()

            if op in ("help", "?"):
                print_help()
                continue
            if op in ("quit", "exit"):
                print("正在停止所有节点...")
                mgr.stop_all()
                print("已退出。")
                return
            if op == "list":
                ids = mgr.list_nodes()
                if not ids:
                    print("当前没有节点在上报。")
                else:
                    print("当前上报节点：")
                    for nid in ids:
                        print(f"  - {nid}")
                continue
            if op in ("stat", "stats"):
                rows = mgr.stats()
                if not rows:
                    print("当前没有节点在上报。")
                    continue
                print("节点统计：")
                for r in rows:
                    nid = r.get("node_id") or "-"
                    okc = r.get("ok") or 0
                    errc = r.get("err") or 0
                    last_err = r.get("last_err")
                    if last_err:
                        print(f"  - {nid}  ✅{okc}  ❌{errc}  最近错误: {last_err}")
                    else:
                        print(f"  - {nid}  ✅{okc}  ❌{errc}")
                continue
            if op == "add":
                if len(parts) < 2:
                    print("用法：add <node_id|number>   例：add 1 或 add WIND_001")
                    continue
                nid = _parse_node_identifier(parts[1])
                ok, msg = mgr.add_node(nid)
                print(("✅ " if ok else "⚠️  ") + msg)
                continue
            if op in ("remove", "rm", "del"):
                if len(parts) < 2:
                    print("用法：remove <node_id|number>   例：remove 1 或 remove WIND_001")
                    continue
                nid = _parse_node_identifier(parts[1])
                ok, msg = mgr.remove_node(nid)
                print(("✅ " if ok else "⚠️  ") + msg)
                continue
            if op == "interval":
                if len(parts) < 2:
                    print("用法：interval <ms>   例：interval 200")
                    continue
                try:
                    ms = int(parts[1])
                except Exception:
                    print("interval 参数必须是整数毫秒")
                    continue
                ok, msg = mgr.set_interval_ms_all(ms)
                print(("✅ " if ok else "⚠️  ") + msg)
                continue

            print("未知命令，输入 help 查看帮助。")
    except KeyboardInterrupt:
        print("\n收到 Ctrl+C，正在停止所有节点...")
        mgr.stop_all()
        print("已停止。")


if __name__ == "__main__":
    main()
