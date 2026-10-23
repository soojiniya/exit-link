"""Store only observations actually supplied by a completed experiment."""
import json
from pathlib import Path


def write_observation(path, observation):
    Path(path).write_text(json.dumps(observation, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
