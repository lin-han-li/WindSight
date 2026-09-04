from __future__ import annotations

import math
import re
from dataclasses import dataclass
from numbers import Real

MAX_TURBINE_COUNT = 200
RESERVED_KEYS = {"node_id", "sub"}
TURBINE_CODE_RE = re.compile(r"^\d{3}$")
TELEMETRY_SOURCE_FIELDS = ("node_id", "device_id", "source_id")
SENSOR_MIN_VOLTAGE = 0.0
SENSOR_MAX_VOLTAGE = 5.0
FULL_SCALE_BY_METRIC = {
    "voltage": 250.0,
    "current": 5.0,
    "speed": 2500.0,
    "temperature": 100.0,
}


class ProtocolValidationError(ValueError):
    pass


@dataclass(frozen=True)
class TurbineSample:
    voltage: float
    current: float
    speed: float
    temperature: float

    def to_dict(self):
        return {
            "voltage": self.voltage,
            "current": self.current,
            "speed": self.speed,
            "temperature": self.temperature,
        }


@dataclass(frozen=True)
class ParsedUpload:
    node_id: str
    turbine_count: int
    turbines: dict[str, TurbineSample]

    def turbine_codes(self):
        return list(self.turbines.keys())


@dataclass(frozen=True)
class ParsedTelemetry:
    """A generic JSON telemetry packet associated with one registered node.

    ``node_id`` deliberately holds the selected source identifier instead of
    requiring the JSON property to be named ``node_id``.  This keeps the
    existing upload authentication flow compatible with packets that identify
    themselves using ``device_id`` or ``source_id``.
    """

    node_id: str
    source_field: str
    payload: dict
    metrics: dict[str, float]


def _path_key_component(value) -> str:
    """Build a stable dotted telemetry path while preserving unusual keys."""

    # Escape the separators used by the public path notation so a key such as
    # ``a.b`` does not collide with the nested object ``{"a": {"b": ...}}``.
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace(".", "\\.")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace(",", "\\,")
    )


def extract_numeric_paths(payload) -> dict[str, float]:
    """Flatten finite JSON numbers in an object into deterministic paths.

    Object properties are joined with ``.`` and array elements use ``[index]``;
    for example ``{"environment": {"temperature": 24.5}}`` becomes
    ``{"environment.temperature": 24.5}``.  Booleans are deliberately not
    treated as numbers even though Python makes ``bool`` a subclass of ``int``.
    Non-finite values are omitted because they are not portable JSON telemetry
    values and cannot be safely aggregated by the database.
    """

    if not isinstance(payload, dict):
        raise ProtocolValidationError("JSON object required")

    metrics: dict[str, float] = {}
    # Iterative traversal avoids Python recursion failures for deeply nested
    # device payloads while retaining JSON's insertion order for reproducible
    # output.
    pending = [(payload, "")]
    while pending:
        value, path = pending.pop()
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, Real):
            numeric_value = float(value)
            if math.isfinite(numeric_value):
                metrics[path or "$"] = numeric_value
            continue
        if isinstance(value, dict):
            items = list(value.items())
            for key, child in reversed(items):
                component = _path_key_component(key)
                child_path = f"{path}.{component}" if path else component
                pending.append((child, child_path))
            continue
        if isinstance(value, list):
            for index in range(len(value) - 1, -1, -1):
                child_path = f"{path}[{index}]" if path else f"[{index}]"
                pending.append((value[index], child_path))
    return metrics


def _source_identifier(payload: dict) -> tuple[str, str]:
    """Choose a non-empty packet source in documented precedence order."""

    for field_name in TELEMETRY_SOURCE_FIELDS:
        value = payload.get(field_name)
        if value is None or isinstance(value, (bool, dict, list)):
            continue
        if isinstance(value, Real) and not math.isfinite(float(value)):
            continue
        source_id = str(value).strip()
        if source_id:
            return field_name, source_id
    raise ProtocolValidationError("one of node_id, device_id or source_id is required")


def parse_telemetry_upload(payload) -> ParsedTelemetry:
    """Validate a generic telemetry JSON object and extract numeric fields."""

    if not isinstance(payload, dict):
        raise ProtocolValidationError("JSON object required")
    source_field, source_id = _source_identifier(payload)
    return ParsedTelemetry(
        node_id=source_id,
        source_field=source_field,
        payload=payload,
        metrics=extract_numeric_paths(payload),
    )


def is_turbine_upload_candidate(payload) -> bool:
    """Recognize the established wind-turbine frame without blocking generic JSON.

    Generic telemetry is allowed to use a field named ``sub``.  A frame is
    considered legacy only when it has both ``sub`` and at least one three-digit
    turbine key, which preserves strict validation for legacy packets while
    keeping ordinary arbitrary objects on the generic path.
    """

    if not isinstance(payload, dict) or "sub" not in payload:
        return False
    data_keys = [str(key) for key in payload if str(key) not in RESERVED_KEYS]
    return bool(data_keys) and all(TURBINE_CODE_RE.fullmatch(key) for key in data_keys)


def build_turbine_codes(count: int):
    return [f"{i:03d}" for i in range(1, count + 1)]


def _sort_turbine_codes(codes):
    return sorted(codes, key=lambda code: int(code))


def _parse_int(value, field_name: str):
    try:
        return int(str(value).strip())
    except Exception as exc:
        raise ProtocolValidationError(f"{field_name} must be an integer") from exc


def _map_sensor_voltage(code: str, metric: str, raw_voltage: float) -> float:
    if not math.isfinite(raw_voltage):
        raise ProtocolValidationError(f"{code}.{metric} raw sensor voltage must be finite")
    if raw_voltage < SENSOR_MIN_VOLTAGE or raw_voltage > SENSOR_MAX_VOLTAGE:
        raise ProtocolValidationError(f"{code}.{metric} raw sensor voltage must be between 0 and 5V")
    return raw_voltage / SENSOR_MAX_VOLTAGE * FULL_SCALE_BY_METRIC[metric]


def _parse_turbine_sample(code: str, value):
    if not isinstance(value, list) or len(value) != 4:
        raise ProtocolValidationError(f"{code} must be a 4-item array")

    try:
        raw_voltage, raw_current, raw_speed, raw_temperature = (float(item) for item in value)
    except Exception as exc:
        raise ProtocolValidationError(f"{code} must contain numeric values") from exc

    return TurbineSample(
        voltage=_map_sensor_voltage(code, "voltage", raw_voltage),
        current=_map_sensor_voltage(code, "current", raw_current),
        speed=_map_sensor_voltage(code, "speed", raw_speed),
        temperature=_map_sensor_voltage(code, "temperature", raw_temperature),
    )


def parse_turbine_upload(payload) -> ParsedUpload:
    if not isinstance(payload, dict):
        raise ProtocolValidationError("JSON body required")

    node_id = str(payload.get("node_id") or "").strip()
    if not node_id:
        raise ProtocolValidationError("node_id is required")

    if "sub" not in payload:
        raise ProtocolValidationError("sub is required")

    turbine_count = _parse_int(payload.get("sub"), "sub")
    if turbine_count < 1 or turbine_count > MAX_TURBINE_COUNT:
        raise ProtocolValidationError(f"sub must be between 1 and {MAX_TURBINE_COUNT}")

    raw_codes = [str(key) for key in payload.keys() if key not in RESERVED_KEYS]
    invalid_codes = [code for code in raw_codes if not TURBINE_CODE_RE.fullmatch(code)]
    if invalid_codes:
        raise ProtocolValidationError(f"unexpected turbine keys: {', '.join(sorted(invalid_codes))}")

    out_of_range_codes = [
        code for code in raw_codes if int(code) < 1 or int(code) > MAX_TURBINE_COUNT
    ]
    if out_of_range_codes:
        raise ProtocolValidationError(
            f"turbine keys must be between 001 and {MAX_TURBINE_COUNT:03d}: "
            f"{', '.join(_sort_turbine_codes(out_of_range_codes))}"
        )

    turbine_codes = _sort_turbine_codes(raw_codes)
    if len(turbine_codes) != turbine_count:
        raise ProtocolValidationError(
            f"sub must match turbine key count: sub={turbine_count}, keys={len(turbine_codes)}"
        )

    turbines = {}
    for code in turbine_codes:
        turbines[code] = _parse_turbine_sample(code, payload.get(code))

    return ParsedUpload(
        node_id=node_id,
        turbine_count=turbine_count,
        turbines=turbines,
    )
