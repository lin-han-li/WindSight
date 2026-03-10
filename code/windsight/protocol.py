from __future__ import annotations

from dataclasses import dataclass

MAX_TURBINE_COUNT = 64
RESERVED_KEYS = {"node_id", "sub"}


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


def _parse_int(value, field_name: str):
    try:
        return int(str(value).strip())
    except Exception as exc:
        raise ProtocolValidationError(f"{field_name} must be an integer") from exc


def _parse_turbine_sample(code: str, value):
    if not isinstance(value, list) or len(value) != 4:
        raise ProtocolValidationError(f"{code} must be a 4-item array")

    try:
        voltage, current, speed, temperature = (float(item) for item in value)
    except Exception as exc:
        raise ProtocolValidationError(f"{code} must contain numeric values") from exc

    return TurbineSample(
        voltage=voltage,
        current=current,
        speed=speed,
        temperature=temperature,
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

    expected_codes = build_turbine_codes(turbine_count)
    actual_codes = sorted(str(key) for key in payload.keys() if key not in RESERVED_KEYS)

    missing_codes = [code for code in expected_codes if code not in payload]
    if missing_codes:
        raise ProtocolValidationError(f"missing turbine keys: {', '.join(missing_codes)}")

    extra_codes = [code for code in actual_codes if code not in expected_codes]
    if extra_codes:
        raise ProtocolValidationError(f"unexpected turbine keys: {', '.join(extra_codes)}")

    turbines = {}
    for code in expected_codes:
        turbines[code] = _parse_turbine_sample(code, payload.get(code))

    return ParsedUpload(
        node_id=node_id,
        turbine_count=turbine_count,
        turbines=turbines,
    )
