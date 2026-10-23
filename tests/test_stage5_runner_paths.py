"""Exercise nested atomic evidence writes with the full runner's path layout."""
import json
from pathlib import Path
import runpy
import sys

import pytest

from exit_link.experiments.safety import atomic_json


def test_full_runner_preserves_pytest_options_and_shortens_only_basetemp(tmp_path, monkeypatch):
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    runner = runpy.run_path(str(scripts / "verify_stage5.py"))
    command = runner["pytest_command"](tmp_path)
    assert command == [sys.executable, "-m", "pytest", "-v", "--tb=short", "--basetemp", str(tmp_path / "p")]


@pytest.mark.parametrize("relative", [
    Path("release-audits") / ("a" * 32 + ".json"),
    Path("runs") / ("b" * 32) / "approval.json",
])
def test_full_runner_nested_evidence_is_durably_written(tmp_path_factory, relative):
    # Match pytest's maximum generated fixture basename (30 characters + index).
    # Under verify_stage5 this uses its real --basetemp, not a shorter override.
    target = tmp_path_factory.mktemp("evidence_path_probe".ljust(30, "x")) / "continuation"
    path = target / relative
    path.parent.mkdir(parents=True)
    record = {"observation_origin": "unit_fixture", "adopted_or_reexecuted_cells": []}
    atomic_json(path, record)
    assert json.loads(path.read_text(encoding="utf-8")) == record
    assert not path.with_suffix(".json.tmp").exists()
