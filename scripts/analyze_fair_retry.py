"""Analyze one fair_retry_v1 run (read-only). Writes a NEW output folder with SHA-256 sums.

Unit of analysis = block (condition, fault_timing, repetition) holding one cell per
method. A block enters paired estimates only when both cells are checkpointed and
comparable; otherwise both sides are excluded and listed. Failed messages stay in
every denominator. Legacy (v2/v3) runs are refused.
"""
import argparse
import csv
import hashlib
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

from exit_link.experiments.inference import paired_interval, wilson

PROTOCOL = "fair_retry_v1"
METHODS = ("fixed_retry", "exit_link")
METRICS = {"delivered": "delivered_observed", "ack_6s": "ack_received"}


def sign_test(better, worse):
    """Exact two-sided binomial sign test over non-tied blocks."""
    n = better + worse
    if n == 0:
        return 1.0
    k = min(better, worse)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def holm(pvalues):
    order = sorted(range(len(pvalues)), key=lambda i: pvalues[i])
    adjusted, running = [None] * len(pvalues), 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (len(pvalues) - rank) * pvalues[i]))
        adjusted[i] = running
    return adjusted


def load(run):
    plan = json.loads((run / "plan.json").read_text(encoding="utf-8"))
    if plan.get("protocol_version") != PROTOCOL:
        raise ValueError("Not a fair_retry_v1 run; legacy data is never analyzed here")
    cells = []
    for index, spec in enumerate(plan["schedule"]):
        checkpoint = plan["completed"].get(str(index))
        path = run / f"t{index:03}" / "trial.json"
        record = None
        if checkpoint and path.exists():
            if hashlib.sha256(path.read_bytes()).hexdigest() != checkpoint["sha256"]:
                raise RuntimeError(f"t{index:03} trial.json does not match its checkpoint")
            record = json.loads(path.read_text(encoding="utf-8"))
        cells.append(dict(index=index, spec=spec, checkpoint=checkpoint, record=record))
    return plan, cells


def message_view(row):
    response = row.get("raw_response") or {}
    attempts = response.get("attempts") if isinstance(response, dict) else None
    return dict(delivered_observed=bool(row.get("delivered_observed")), ack_received=bool(row.get("ack_received")),
                attempts=len(attempts) if attempts else None, client_elapsed_ms=row.get("client_elapsed_ms"),
                position=row.get("position"))


def analyze(run, out):
    run, out = Path(run).resolve(), Path(out).resolve()
    if out.exists():
        raise FileExistsError(f"{out} exists; analysis never overwrites")
    if "data" in out.parts and "measured" in out.parts:
        raise ValueError("Write analysis outside data/measured")
    plan, cells = load(run)
    blocks = defaultdict(dict)
    for cell in cells:
        s = cell["spec"]
        blocks[s["condition"], s["fault_timing"], s["repetition"]][s["method"]] = cell
    exclusions, valid = [], {}
    for key, pair in sorted(blocks.items()):
        reasons = []
        for method in METHODS:
            cell = pair.get(method)
            if cell is None or cell["record"] is None:
                reasons.append(f"{method}:not_checkpointed")
            elif not cell["record"].get("comparable"):
                reasons.append(f"{method}:{(cell['record'].get('error') or {}).get('type', 'not_comparable')}")
        if reasons:
            exclusions.append(dict(condition=key[0], fault_timing=key[1], repetition=key[2], reason=";".join(reasons)))
        else:
            valid[key] = {m: [message_view(r) for r in sorted(pair[m]["record"]["messages"], key=lambda r: r["position"])]
                          for m in METHODS}
    strata = sorted({(k[0], k[1]) for k in blocks})
    rows = []
    def summarize(scope, keys):
        for metric, field in METRICS.items():
            row = dict(scope=scope, metric=metric, blocks=len(keys))
            per_block = {m: [sum(x[field] for x in valid[k][m]) for k in keys] for m in METHODS}
            for m in METHODS:
                n, s = 3 * len(keys), sum(per_block[m])
                row.update({f"{m}_success": s, f"{m}_n": n, f"{m}_rate": s / n if n else None})
                ci = paired_interval([(0, v / 3) for v in per_block[m]]) if keys else None
                row.update({f"{m}_ci_low": ci and ci["lower"], f"{m}_ci_high": ci and ci["upper"]})
            diff = paired_interval([(a / 3, b / 3) for a, b in zip(per_block["fixed_retry"], per_block["exit_link"])])
            better = sum(b > a for a, b in zip(per_block["fixed_retry"], per_block["exit_link"]))
            worse = sum(b < a for a, b in zip(per_block["fixed_retry"], per_block["exit_link"]))
            row.update(diff_exit_minus_fixed_retry=diff and diff["estimate"], diff_ci_low=diff and diff["lower"],
                       diff_ci_high=diff and diff["upper"], blocks_exit_better=better, blocks_fixed_retry_better=worse,
                       blocks_tied=len(keys) - better - worse, sign_test_p=sign_test(better, worse), sign_test_p_holm=None)
            rows.append(row)
    summarize("overall", sorted(valid))
    for stratum in strata:
        summarize(f"{stratum[0]}/{stratum[1]}", sorted(k for k in valid if (k[0], k[1]) == stratum))
    for metric in METRICS:
        idx = [i for i, r in enumerate(rows) if r["metric"] == metric and r["scope"] != "overall"]
        for i, p in zip(idx, holm([rows[i]["sign_test_p"] for i in idx])):
            rows[i]["sign_test_p_holm"] = p
    attempts, latency, overhead = {}, {}, {}
    for m in METHODS:
        views = [x for k in valid for x in valid[k][m]]
        counts = defaultdict(int)
        for x in views:
            counts[str(x["attempts"])] += 1
        attempts[m] = dict(sorted(counts.items()))
        acked = sorted(x["client_elapsed_ms"] for x in views if x["ack_received"] and x["client_elapsed_ms"] is not None)
        latency[m] = dict(ack_n=len(acked), total_n=len(views),
                          median_ms=statistics.median(acked) if acked else None,
                          p95_ms=acked[math.ceil(.95 * len(acked)) - 1] if acked else None,
                          note="conditional on ACK; failures excluded, not imputed")
        rates = [pair[m]["record"].get("overhead", {}).get("framed_bytes_per_second") for k, pair in blocks.items()
                 if k in valid]
        rates = [r for r in rates if r is not None]
        overhead[m] = dict(cells=len(rates), mean_control_bytes_per_second=statistics.mean(rates) if rates else None)
    out.mkdir(parents=True)
    with (out / "stats.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    with (out / "exclusions.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=["condition", "fault_timing", "repetition", "reason"])
        writer.writeheader()
        writer.writerows(exclusions)
    summary = dict(protocol=PROTOCOL, run=str(run), plan_design_sha256=plan["design_sha256"],
                   planned_blocks=len(blocks), valid_blocks=len(valid), excluded_blocks=len(exclusions),
                   cells_checkpointed=sum(c["record"] is not None for c in cells), cells_planned=len(cells),
                   attempts_per_message=attempts, ack_latency=latency, control_overhead=overhead,
                   wilson_overall={m: wilson(next(r for r in rows if r["scope"] == "overall" and r["metric"] == "delivered")[f"{m}_success"],
                                             3 * len(valid)) for m in METHODS} if valid else None)
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    sums = "".join(f"{hashlib.sha256((out / n).read_bytes()).hexdigest()}  {n}\n" for n in ("stats.csv", "exclusions.csv", "summary.json"))
    (out / "OUTPUT_SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    return summary, rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    summary, _ = analyze(args.run, args.out)
    print(json.dumps({k: summary[k] for k in ("valid_blocks", "excluded_blocks", "cells_checkpointed", "cells_planned")}))
    sys.exit(0)
