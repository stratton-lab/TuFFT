from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from pathlib import Path
import threading
from typing import Any, TextIO


EVENT_SCHEMA_VERSION = 1


class EventEmitter:
    """Emit one strict JSON object per stdout line."""

    def __init__(self, stream: TextIO, job_id: str):
        self._stream = stream
        self._job_id = job_id
        self._lock = threading.Lock()

    def emit(self, event: str, **data: Any) -> None:
        payload = {
            "schema_version": EVENT_SCHEMA_VERSION,
            "event": event,
            "job_id": self._job_id,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            **data,
        }
        line = json.dumps(_json_safe(payload), ensure_ascii=True, allow_nan=False, separators=(",", ":"))
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "item"):
        try:
            return _json_safe(value.item())
        except (TypeError, ValueError):
            pass
    return str(value)
