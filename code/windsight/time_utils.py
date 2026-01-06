"""
时间工具：统一使用北京时间（Asia/Shanghai）显示，数据库内部统一按 UTC 写入。

说明：
- SQLite/SQLAlchemy 默认不保存时区信息，项目中历史上混用了 datetime.now() 与 datetime.utcnow()
  以及手工 timedelta(hours=8) 的方式，容易造成“有的显示北京时间、有的差 7/8 小时”的混乱。
- 本模块约定：**所有存入数据库的时间都使用 UTC（datetime.utcnow）**；
  **所有返回给前端展示的时间都转换为北京时间（Asia/Shanghai，UTC+8）**。
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta

try:
    # Python 3.9+
    from zoneinfo import ZoneInfo  # type: ignore
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore


# 统一使用北京时间：优先使用 IANA 时区（Asia/Shanghai）；若系统缺少 tzdata，则回退到固定 UTC+8。
# 说明：Windows 某些精简环境可能没有系统时区库；而北京时间不使用夏令时，固定偏移即可满足项目需求。
BEIJING_TZ = timezone(timedelta(hours=8))
if ZoneInfo:
    try:
        BEIJING_TZ = ZoneInfo("Asia/Shanghai")
    except Exception:
        # 缺少 tzdata / 无法加载时区信息时回退到 UTC+8
        BEIJING_TZ = timezone(timedelta(hours=8))


def to_utc(dt: datetime | None) -> datetime | None:
    """将时间视为 UTC（若无 tzinfo 则按 UTC 解释），返回带 tzinfo=UTC 的 datetime。"""
    if not dt:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_beijing(dt: datetime | None) -> datetime | None:
    """将时间转换为北京时间（Asia/Shanghai）。"""
    utc_dt = to_utc(dt)
    if not utc_dt:
        return None
    return utc_dt.astimezone(BEIJING_TZ)


def fmt_beijing(dt: datetime | None, with_seconds: bool = True) -> str | None:
    """格式化为北京时间字符串：YYYY-MM-DD HH:MM(:SS)。"""
    bj = to_beijing(dt)
    if not bj:
        return None
    return bj.strftime("%Y-%m-%d %H:%M:%S" if with_seconds else "%Y-%m-%d %H:%M")


def iso_beijing(dt: datetime | None, with_seconds: bool = True, with_ms: bool = False) -> str | None:
    """
    格式化为带时区偏移的 ISO 字符串（北京时间）：
    - 默认：YYYY-MM-DDTHH:MM(:SS)+08:00
    - 带毫秒：YYYY-MM-DDTHH:MM:SS.sss+08:00
    用于前端 new Date(iso) 解析时不产生二次时区偏移。
    """
    bj = to_beijing(dt)
    if not bj:
        return None
    # %z 形如 +0800，转换为 +08:00
    z = bj.strftime("%z")
    z = z[:-2] + ":" + z[-2:]

    if not with_seconds:
        return bj.strftime("%Y-%m-%dT%H:%M") + z

    if with_ms:
        # JS Date 对毫秒解析最稳，统一输出 3 位毫秒（不输出 6 位微秒，避免兼容性差异）
        ms = int(bj.microsecond // 1000)
        return bj.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}" + z

    return bj.strftime("%Y-%m-%dT%H:%M:%S") + z


def parse_client_datetime_to_utc(raw: str | None) -> datetime | None:
    """
    将前端传入的时间字符串解析为“UTC naive datetime”（与数据库 NodeData.timestamp 的存储方式一致）。

    支持输入：
    - ISO（含时区）：2026-01-06T22:54:41.080+08:00 / 2026-01-06T14:54:41.080Z
    - datetime-local（不含时区）：2026-01-06T22:54 / 2026-01-06 22:54

    规则：
    - 若带时区：按其时区解析并转换到 UTC
    - 若不带时区：默认按北京时间（Asia/Shanghai / UTC+8）解释
    """
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None

    # 兼容：允许日期使用斜杠（例如 2026/01/06 23:05）
    # 说明：前端现在支持直接键盘输入，用户更习惯 “YYYY/MM/DD HH:MM”。
    s = s.replace("/", "-")

    # 兼容：把 "YYYY-MM-DD HH:MM(:SS)" 转成 ISO
    if " " in s and "T" not in s:
        s = s.replace(" ", "T")

    # 兼容：Z 结尾（fromisoformat 不支持 Z）
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"

    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None

    # 不带时区：按北京时间解释
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BEIJING_TZ)

    utc_dt = dt.astimezone(timezone.utc)
    # 数据库存的是 naive UTC
    return utc_dt.replace(tzinfo=None)

