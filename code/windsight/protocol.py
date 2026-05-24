from __future__ import annotations

import math
import re
from dataclasses import dataclass

MAX_TURBINE_COUNT = 200
RESERVED_KEYS = {"node_id", "sub"}
TURBINE_CODE_RE = re.compile(r"^\d{3}$")
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
