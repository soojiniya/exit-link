"""Analyze one v3 directory only; legacy cells may never enter these estimates."""
import argparse
from pathlib import Path

if __package__:
    from .analyze_main_study import analyze
else:
    from analyze_main_study import analyze


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    result = analyze(args.directory, expected_protocol="aligned_v3")
    print("v3 recorded cells:", result["recorded_cells"])
