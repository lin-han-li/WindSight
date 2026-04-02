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

MAX_TURBINE_COUNT = 64
DEFAULT_TURBINE_COUNT = 32


if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _get_env_server_url() -> str:
    keys = [
        "WINDSIGHT_SERVER_URL",
        "WINDSIGHT_SERVER",
        "EDGEWIND_SERVER_URL",
        "EDGEWIND_SERVER",
        "SERVER_URL",
    ]
    for key in keys:
        value = os.environ.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().rstrip("/")
    return "http://127.0.0.1:8080"


def _clamp_turbine_count(value: int) -> int:
    return max(1, min(MAX_TURBINE_COUNT, int(value)))


@dataclass
class NodeSimState:
    node_id: str
    turbine_count: int
    seed: int
    rng: random.Random


def _gen_series(
    *,
    count: int,
    t: float,
    base: float,
    amp: float,
    noise: float,
    w_base: float,
    rng: random.Random,
) -> list[float]:
    out: list[float] = []
    for idx in range(count):
        weight = w_base * (1.0 + idx * 0.03)
        phase = idx * 0.25
        drift = 0.15 * math.sin(0.05 * t + idx * 0.1)
        value = base + drift + amp * math.sin(weight * t + phase) + rng.gauss(0.0, noise)
        out.append(round(float(value), 4))
    return out


def build_payload(node: NodeSimState, t: float) -> dict:
    count = _clamp_turbine_count(node.turbine_count)
    node_hash = abs(hash(node.node_id))

    voltages = _gen_series(
        count=count,
        t=t,
        base=690.0 + (node_hash % 7) * 5.0,
        amp=25.0,
        noise=1.5,
        w_base=0.8,
        rng=node.rng,
    )
    currents = _gen_series(
        count=count,
        t=t,
        base=100.0 + (node_hash % 5) * 3.0,
        amp=8.0,
        noise=0.5,
        w_base=1.1,
        rng=node.rng,
    )
    speeds = _gen_series(
        count=count,
        t=t,
        base=15.0 + (node_hash % 9) * 0.5,
        amp=2.0,
        noise=0.1,
        w_base=0.35,
        rng=node.rng,
    )
    temperatures = _gen_series(
        count=count,
        t=t,
        base=48.0 + (node_hash % 6) * 1.2,
        amp=4.0,
        noise=0.3,
        w_base=0.22,
        rng=node.rng,
    )

    payload = {"node_id": node.node_id, "sub": str(count)}
    for idx in range(count):
        payload[f"{idx + 1:03d}"] = [
            voltages[idx],
            currents[idx],
            speeds[idx],
            temperatures[idx],
        ]
    return payload


def upload_once(session: requests.Session, server_url: str, payload: dict, timeout: float = 3.0) -> tuple[bool, str]:
    url = f"{server_url.rstrip('/')}/api/upload"
    try:
        response = session.post(url, json=payload, timeout=timeout)
        if response.status_code == 200:
            try:
                data = response.json()
            except Exception:
                return True, "ok_but_non_json"
            if data.get("status") == "success":
                return True, f"success upload_id={data.get('upload_id')}"
            return True, f"ok_but_unexpected_response={data}"
        return False, f"status_code={response.status_code}, body={response.text[:200]}"
    except Exception as exc:
        return False, f"request_error={type(exc).__name__}: {exc}"


class NodeWorker(threading.Thread):
    def __init__(self, node: NodeSimState, server_url: str, interval_ms: int, timeout_s: float):
        super().__init__(daemon=True, name=f"NodeWorker-{node.node_id}")
        self.node = node
        self.server_url = server_url.rstrip("/")
        self.timeout_s = float(timeout_s)
        self._interval_s = max(0.05, float(interval_ms) / 1000.0)
        self._interval_lock = threading.Lock()
        self._stop_evt = threading.Event()
        self._session = requests.Session()
        self._ok_count = 0
        self._err_count = 0
        self._last_error_msg: str | None = None
        self._last_error_at: float | None = None
        self._stats_lock = threading.Lock()

    def set_interval_ms(self, ms: int):
        with self._interval_lock:
            self._interval_s = max(0.05, float(ms) / 1000.0)

    def stop(self):
        self._stop_evt.set()

    def run(self):
        while not self._stop_evt.is_set():
            payload = build_payload(self.node, time.time())
            ok, msg = upload_once(self._session, self.server_url, payload, timeout=self.timeout_s)
            with self._stats_lock:
                if ok:
                    self._ok_count += 1
                else:
                    self._err_count += 1
                    self._last_error_msg = msg
                    self._last_error_at = time.time()

            with self._interval_lock:
                sleep_s = self._interval_s
            end_ts = time.time() + sleep_s
            while not self._stop_evt.is_set() and time.time() < end_ts:
                time.sleep(0.05)

    def snapshot(self) -> dict:
        with self._stats_lock:
            return {
                "node_id": self.node.node_id,
                "sub": self.node.turbine_count,
                "ok": int(self._ok_count),
                "err": int(self._err_count),
                "last_err": self._last_error_msg,
                "last_err_at": self._last_error_at,
            }


class NodeManager:
    def __init__(self, server_url: str, interval_ms: int, timeout_s: float, turbine_count: int):
        self.server_url = server_url.rstrip("/")
        self.timeout_s = float(timeout_s)
        self._interval_ms = max(50, int(interval_ms))
        self._turbine_count = _clamp_turbine_count(turbine_count)
        self._lock = threading.Lock()
        self._workers: dict[str, NodeWorker] = {}

    def _make_state(self, node_id: str) -> NodeSimState:
        seed = abs(hash(node_id)) % (2**31)
        rng = random.Random(seed ^ (int(time.time() * 1000) & 0x7FFFFFFF))
        return NodeSimState(
            node_id=node_id,
            turbine_count=self._turbine_count,
            seed=seed,
            rng=rng,
        )

    def list_nodes(self) -> list[str]:
        with self._lock:
            return sorted(self._workers.keys())

    def add_node(self, node_id: str) -> tuple[bool, str]:
        nid = (node_id or "").strip()
        if not nid:
            return False, "node_id cannot be empty"
        with self._lock:
            if nid in self._workers:
                return False, f"node already exists: {nid}"
            worker = NodeWorker(self._make_state(nid), self.server_url, self._interval_ms, self.timeout_s)
            self._workers[nid] = worker
            worker.start()
        return True, f"node started: {nid}"

    def remove_node(self, node_id: str) -> tuple[bool, str]:
        nid = (node_id or "").strip()
        if not nid:
            return False, "node_id cannot be empty"
        with self._lock:
            worker = self._workers.get(nid)
            if not worker:
                return False, f"node not found: {nid}"
            worker.stop()
            try:
                worker.join(timeout=1.0)
            except Exception:
                pass
            self._workers.pop(nid, None)
        return True, f"node stopped: {nid}"

    def set_interval_ms_all(self, ms: int) -> tuple[bool, str]:
        value = max(50, int(ms))
        with self._lock:
            self._interval_ms = value
            for worker in self._workers.values():
                worker.set_interval_ms(value)
        return True, f"interval set to {value} ms"

    def stop_all(self):
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
        for worker in workers:
            worker.stop()
        for worker in workers:
            try:
                worker.join(timeout=1.0)
            except Exception:
                pass

    def stats(self) -> list[dict]:
        with self._lock:
            workers = list(self._workers.values())
        rows = [worker.snapshot() for worker in workers]
        rows.sort(key=lambda row: row.get("node_id") or "")
        return rows


def _parse_node_identifier(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    try:
        number = int(value)
    except Exception:
        return value
    if number <= 0:
        return value
    return f"WIN_{number:03d}"


def print_help():
    print("")
    print("Commands:")
    print("  help                    show help")
    print("  add <node_id|number>    start a node")
    print("  remove <node_id|number> stop a node")
    print("  list                    list running nodes")
    print("  stat                    show upload stats")
    print("  interval <ms>           update upload interval for all nodes")
    print("  quit / exit             stop all nodes and exit")
    print("")


def _build_initial_ids(node_count: int, node_id: str) -> list[str]:
    if node_count <= 0:
        return [_parse_node_identifier(node_id) or "WIN_001"]
    if node_count == 1:
        return [_parse_node_identifier(node_id) or "WIN_001"]
    return [f"WIN_{i:03d}" for i in range(1, node_count + 1)]


def main():
    parser = argparse.ArgumentParser(description="WindSight simulator for the turbine payload protocol")
    parser.add_argument("--server", type=str, default=None, help="target server, e.g. http://127.0.0.1:8080")
    parser.add_argument("--node-id", type=str, default="WIN_001", help="initial node id when --nodes=1")
    parser.add_argument("--nodes", type=int, default=0, help="number of nodes to start immediately")
    parser.add_argument("--sub", type=int, default=DEFAULT_TURBINE_COUNT, help="turbine count per upload frame")
    parser.add_argument("--interval-ms", type=int, default=500, help="upload interval in ms")
    parser.add_argument("--once", action="store_true", help="send one frame and exit")
    parser.add_argument("--timeout", type=float, default=3.0, help="HTTP timeout in seconds")
    parser.add_argument("--no-console", action="store_true", help="disable interactive console")
    args = parser.parse_args()

    server_url = (args.server or _get_env_server_url()).rstrip("/")
    node_count = max(0, int(args.nodes))
    interval_ms = max(50, int(args.interval_ms))
    turbine_count = _clamp_turbine_count(args.sub)

    print("=" * 72)
    print("WindSight simulator")
    print(f"server: {server_url}")
    print(f"nodes: {node_count}")
    print(f"sub: {turbine_count}")
    print(f"interval: {interval_ms} ms")
    print("=" * 72)

    if args.once:
        session = requests.Session()
        ok_count = 0
        ids = _build_initial_ids(node_count, args.node_id)
        for node_id in ids:
            seed = abs(hash(node_id)) % (2**31)
            payload = build_payload(
                NodeSimState(
                    node_id=node_id,
                    turbine_count=turbine_count,
                    seed=seed,
                    rng=random.Random(seed),
                ),
                time.time(),
            )
            ok, msg = upload_once(session, server_url, payload, timeout=float(args.timeout))
            if ok:
                ok_count += 1
            else:
                print(f"[{node_id}] upload failed: {msg}")
        print(f"once complete: {ok_count}/{len(ids)}")
        return

    manager = NodeManager(
        server_url=server_url,
        interval_ms=interval_ms,
        timeout_s=float(args.timeout),
        turbine_count=turbine_count,
    )

    if node_count <= 0:
        print("No nodes started yet. Example: add 1")
    else:
        for node_id in _build_initial_ids(node_count, args.node_id):
            ok, msg = manager.add_node(node_id)
            print(("OK " if ok else "ERR ") + msg)

    try:
        if args.no_console:
            print("Interactive console disabled. Press Ctrl+C to stop.")
            while True:
                time.sleep(1)

        print_help()
        while True:
            command = input("command > ").strip()
            if not command:
                continue
            parts = command.split()
            op = parts[0].lower()

            if op in ("help", "?"):
                print_help()
                continue
            if op in ("quit", "exit"):
                manager.stop_all()
                print("All nodes stopped.")
                return
            if op == "list":
                rows = manager.list_nodes()
                if not rows:
                    print("No active nodes.")
                else:
                    for node_id in rows:
                        print(node_id)
                continue
            if op in ("stat", "stats"):
                rows = manager.stats()
                if not rows:
                    print("No active nodes.")
                    continue
                for row in rows:
                    line = f"{row['node_id']} sub={row['sub']} ok={row['ok']} err={row['err']}"
                    if row.get("last_err"):
                        line += f" last_err={row['last_err']}"
                    print(line)
                continue
            if op == "add":
                if len(parts) < 2:
                    print("usage: add <node_id|number>")
                    continue
                ok, msg = manager.add_node(_parse_node_identifier(parts[1]))
                print(("OK " if ok else "ERR ") + msg)
                continue
            if op in ("remove", "rm", "del"):
                if len(parts) < 2:
                    print("usage: remove <node_id|number>")
                    continue
                ok, msg = manager.remove_node(_parse_node_identifier(parts[1]))
                print(("OK " if ok else "ERR ") + msg)
                continue
            if op == "interval":
                if len(parts) < 2:
                    print("usage: interval <ms>")
                    continue
                try:
                    ms = int(parts[1])
                except Exception:
                    print("interval must be an integer")
                    continue
                ok, msg = manager.set_interval_ms_all(ms)
                print(("OK " if ok else "ERR ") + msg)
                continue

            print("Unknown command. Type help.")
    except KeyboardInterrupt:
        print("\nStopping...")
        manager.stop_all()
        print("Stopped.")


if __name__ == "__main__":
    main()
