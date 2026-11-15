"""Analyze ONE fair_retry_v1 run (read-only). Writes a NEW output folder with SHA-256 sums.

Pre-registered in docs/fair-retry-main-study-design.md:
* unit = block (condition, fault_timing, repetition) holding one cell per method;
  a block enters the paired analysis only if BOTH cells are checkpointed, comparable
  and not excluded by the audit log; otherwise both cells are excluded and listed;
* primary metric = delivered (N4 receipt inside the 9 s window), failures in denominators;
* primary contrast = EXIT-LINK - Fixed + Retry over all valid blocks, with a
  stratified block bootstrap CI (resampling within each of the 8 strata) and one
  unadjusted exact sign test; the 8 per-stratum contrasts are a secondary family
  with Holm-adjusted sign tests;
* attempts per message are counted from N1's own delivery_result log record, which
  is written even after the 6 s client deadline; incomplete logs stay "unconfirmed".
Message-level Wilson intervals are not reported (messages within a cell are not
independent). Runs are never pooled: pilot and main are analyzed separately.
"""
import argparse
import csv
import hashlib
import json
import math
import random
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

PROTOCOL = "fair_retry_v1"
METHODS = ("fixed_retry", "exit_link")
METRICS = {"delivered": "delivered_observed", "ack_6s": "ack_received"}
PRIMARY = dict(metric="delivered", contrast="exit_link - fixed_retry", scope="overall")
ATTEMPT_EVENTS = ("route_selected", "route_reused", "route_changed")  # one per transmission attempt, logged before it
BOOTSTRAP_SEED, BOOTSTRAP_DRAWS = 20261117, 10000
AUDIT_FILE = Path("audit") / "exclusions.jsonl"


# ---------------------------------------------------------------- attempts from N1 logs
def read_node_log(paths):
    """Parse JSON lines without modifying files; count lines that cannot be parsed."""
    events, malformed = [], 0
    for path in paths:
        for line in Path(path).read_bytes().splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except ValueError:
                malformed += 1
                continue
            if isinstance(value, dict):
                events.append(value)
            else:
                malformed += 1
    return events, malformed


def n1_attempts(cell_dir, rows):
    """Attempts per message from N1's delivery_result record, cross-checked against
    the per-attempt route_* events and any client-side DeliveryResult.

    Returns {message_id: dict(attempts=int|None, status, reason)}; never estimates."""
    paths = sorted(Path(cell_dir, "p").glob("N1-*.jsonl"))
    events, malformed = read_node_log(paths) if paths else ([], 0)
    results, route_events = defaultdict(list), defaultdict(list)
    for event in events:
        mid = event.get("message_id")
        if event.get("node") not in (None, "N1") or mid is None:
            continue
        if event.get("event") == "delivery_result":
            results[mid].append(event)
        elif event.get("event") in ATTEMPT_EVENTS:
            route_events[mid].append(event)
    out = {}
    for row in rows:
        mid = row["message_id"]
        def unconfirmed(reason):
            note = f"{reason}; malformed_lines={malformed}" if malformed else reason
            return dict(attempts=None, status="unconfirmed", reason=note)
        if not paths:
            out[mid] = unconfirmed("n1_log_missing")
            continue
        found = results.get(mid, [])
        if not found:
            out[mid] = unconfirmed("no_delivery_result")
            continue
        if len({json.dumps(r, sort_keys=True) for r in found}) > 1:
            out[mid] = unconfirmed("conflicting_delivery_results")
            continue
        attempts = found[0].get("attempts")
        if not isinstance(attempts, list):
            out[mid] = unconfirmed("delivery_result_without_attempts")
            continue
        count = len(attempts)
        if [a.get("number") for a in attempts] != list(range(1, count + 1)):
            out[mid] = unconfirmed("attempt_numbers_not_consecutive")
            continue
        # The same log line printed twice is one attempt; two different lines for one number are a conflict.
        by_number = defaultdict(set)
        for e in route_events.get(mid, []):
            by_number[e.get("attempt")].add(json.dumps(e, sort_keys=True))
        if any(len(lines) > 1 for lines in by_number.values()):
            out[mid] = unconfirmed("conflicting_attempt_events")
            continue
        if set(by_number) != set(range(1, count + 1)):
            out[mid] = unconfirmed("attempt_events_do_not_match_result")
            continue
        client = row.get("raw_response")
        if isinstance(client, dict) and isinstance(client.get("attempts"), list) and len(client["attempts"]) != count:
            out[mid] = unconfirmed("client_result_conflicts_with_n1_log")
            continue
        out[mid] = dict(attempts=count, status="confirmed", reason="n1_delivery_result")
    return out


# ---------------------------------------------------------------- statistics
def stratified_bootstrap(strata_values, seed=BOOTSTRAP_SEED, draws=BOOTSTRAP_DRAWS):
    """Percentile CI for the pooled mean of block values, resampling blocks WITHIN each stratum.

    strata_values: {stratum: [value per valid block]}. Deterministic for a given seed."""
    groups = [(key, list(values)) for key, values in sorted(strata_values.items()) if values]
    n = sum(len(values) for _, values in groups)
    if n == 0:
        return None
    estimate = sum(sum(values) for _, values in groups) / n
    rng = random.Random(seed)
    samples = sorted(sum(sum(rng.choices(values, k=len(values))) for _, values in groups) / n for _ in range(draws))
    return dict(estimate=estimate, lower=samples[math.ceil(.025 * draws) - 1], upper=samples[math.ceil(.975 * draws) - 1],
                confidence=.95, draws=draws, seed=seed, n_blocks=n, strata={str(k): len(v) for k, v in groups},
                method="stratified_block_percentile_bootstrap",
                zero_width_note="width 0 = no variation among sampled blocks, not certainty" if samples[0] == samples[-1] else None)


def sign_test(better, worse):
    """Exact two-sided binomial sign test over non-tied blocks."""
    n = better + worse
    if n == 0:
        return 1.0
    k = min(better, worse)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def holm(pvalues):
    order = sorted(range(len(pvalues)), key=lambda i: pvalues[i])
    adjusted, running = [None] * len(pvalues), 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (len(pvalues) - rank) * pvalues[i]))
        adjusted[i] = running
    return adjusted


# ---------------------------------------------------------------- loading
def read_audit_records(run):
    path = Path(run) / AUDIT_FILE
    if not path.exists():
        return []
    from exit_link.experiments.fair_retry import read_audit  # verifies the hash chain
    return read_audit(run)


def load(run):
    plan = json.loads((run / "plan.json").read_text(encoding="utf-8"))
    if plan.get("protocol_version") != PROTOCOL:
        raise ValueError("Not a fair_retry_v1 run; legacy data is never analyzed here")
    audit = {r["index"]: r for r in read_audit_records(run) if r["kind"] in ("excluded_interrupted", "excluded_partner")}
    cells = []
    for index, spec in enumerate(plan["schedule"]):
        checkpoint = plan["completed"].get(str(index))
        path = run / f"t{index:03}" / "trial.json"
        record = None
        if checkpoint and path.exists():
            if hashlib.sha256(path.read_bytes()).hexdigest() != checkpoint["sha256"]:
                raise RuntimeError(f"t{index:03} trial.json does not match its checkpoint")
            record = json.loads(path.read_text(encoding="utf-8"))
        cells.append(dict(index=index, spec=spec, checkpoint=checkpoint, record=record, audit=audit.get(index)))
    return plan, cells


def analyze(run, out):
    run, out = Path(run).resolve(), Path(out).resolve()
    if out.exists():
        raise FileExistsError(f"{out} exists; analysis never overwrites")
    if "data" in out.parts and "measured" in out.parts:
        raise ValueError("Write analysis outside data/measured")
    plan, cells = load(run)
    stage = plan.get("stage", "pilot")  # plans prepared before stages existed were pilots
    blocks = defaultdict(dict)
    for cell in cells:
        s = cell["spec"]
        blocks[s["condition"], s["fault_timing"], s["repetition"]][s["method"]] = cell
    exclusions, valid, attempts = [], {}, {}
    for key, pair in sorted(blocks.items()):
        reasons = []
        for method in METHODS:
            cell = pair.get(method)
            if cell is None:
                reasons.append(f"{method}:missing")
            elif cell["audit"]:
                reasons.append(f"{method}:audited_{cell['audit']['kind']}")
            elif cell["record"] is None:
                reasons.append(f"{method}:not_checkpointed")
            elif not cell["record"].get("comparable"):
                reasons.append(f"{method}:{(cell['record'].get('error') or {}).get('type', 'not_comparable')}")
        if reasons:
            exclusions.append(dict(condition=key[0], fault_timing=key[1], repetition=key[2], reason=";".join(reasons)))
            continue
        valid[key] = {}
        for m in METHODS:
            rows = sorted(pair[m]["record"]["messages"], key=lambda r: r["position"])
            counted = n1_attempts(run / f"t{pair[m]['index']:03}", rows)
            valid[key][m] = [dict(delivered_observed=bool(r.get("delivered_observed")), ack_received=bool(r.get("ack_received")),
                                  client_elapsed_ms=r.get("client_elapsed_ms"), **counted[r["message_id"]]) for r in rows]
    strata = sorted({(k[0], k[1]) for k in blocks})
    rows = []

    def contrast(scope, keys, family):
        for metric, field in METRICS.items():
            by_stratum = defaultdict(lambda: defaultdict(list))
            for k in keys:
                for m in METHODS:
                    by_stratum[(k[0], k[1])][m].append(sum(x[field] for x in valid[k][m]) / 3)
            row = dict(scope=scope, metric=metric, role=("primary" if (scope, metric) == ("overall", PRIMARY["metric"])
                       else "secondary_overall" if scope == "overall" else "secondary_stratum"), blocks=len(keys))
            for m in METHODS:
                successes = sum(sum(x[field] for x in valid[k][m]) for k in keys)
                ci = stratified_bootstrap({s: v[m] for s, v in by_stratum.items()})
                row.update({f"{m}_success": successes, f"{m}_n": 3 * len(keys), f"{m}_rate": ci and ci["estimate"],
                            f"{m}_ci_low": ci and ci["lower"], f"{m}_ci_high": ci and ci["upper"]})
            diffs = {s: [b - a for a, b in zip(v["fixed_retry"], v["exit_link"])] for s, v in by_stratum.items()}
            ci = stratified_bootstrap(diffs)
            flat = [d for values in diffs.values() for d in values]
            better, worse = sum(d > 0 for d in flat), sum(d < 0 for d in flat)
            row.update(diff_exit_minus_fixed_retry=ci and ci["estimate"], diff_ci_low=ci and ci["lower"],
                       diff_ci_high=ci and ci["upper"], ci_method=ci and ci["method"],
                       ci_note=ci and ci["zero_width_note"], bootstrap_seed=BOOTSTRAP_SEED,
                       bootstrap_draws=BOOTSTRAP_DRAWS, blocks_exit_better=better, blocks_fixed_retry_better=worse,
                       blocks_tied=len(flat) - better - worse, sign_test_p=sign_test(better, worse),
                       multiplicity=family, sign_test_p_holm="not_applicable_primary" if family == "single_primary_test" else None)
            rows.append(row)
    contrast("overall", sorted(valid), "single_primary_test")
    for stratum in strata:
        contrast(f"{stratum[0]}/{stratum[1]}", sorted(k for k in valid if (k[0], k[1]) == stratum), "holm_over_8_strata")
    for metric in METRICS:
        idx = [i for i, r in enumerate(rows) if r["metric"] == metric and r["multiplicity"] == "holm_over_8_strata"]
        for i, p in zip(idx, holm([rows[i]["sign_test_p"] for i in idx])):
            rows[i]["sign_test_p_holm"] = p
    attempt_summary, latency = {}, {}
    for m in METHODS:
        views = [x for k in valid for x in valid[k][m]]
        confirmed = Counter(str(x["attempts"]) for x in views if x["status"] == "confirmed")
        attempt_summary[m] = dict(source="N1 delivery_result log record (cross-checked)", messages=len(views),
                                  confirmed=sum(confirmed.values()), unconfirmed=sum(x["status"] != "confirmed" for x in views),
                                  distribution=dict(sorted(confirmed.items())),
                                  unconfirmed_reasons=dict(Counter(x["reason"] for x in views if x["status"] != "confirmed")),
                                  client_deadline_missed=sum(not x["ack_received"] and (x["client_elapsed_ms"] or 0) >= 6000 for x in views))
        acked = sorted(x["client_elapsed_ms"] for x in views if x["ack_received"] and x["client_elapsed_ms"] is not None)
        latency[m] = dict(ack_n=len(acked), total_n=len(views), median_ms=statistics.median(acked) if acked else None,
                          p95_ms=acked[math.ceil(.95 * len(acked)) - 1] if acked else None,
                          note="conditional on ACK; failures excluded, not imputed")
    overhead = {}
    for m in METHODS:
        per = defaultdict(list)
        for k in valid:
            value = blocks[k][m]["record"].get("overhead", {}).get("framed_bytes_per_second")
            if value is not None:
                per[f"{k[0]}/{k[1]}"].append(value)
        overhead[m] = dict(definition="sum of Heartbeat+HeartbeatReply application frame bytes (4-byte length + JSON) "
                           "sent by all nodes inside the window / 9 s; excludes TCP/IP headers, handshakes, data frames, telemetry",
                           by_stratum_mean={s: statistics.mean(v) for s, v in sorted(per.items())})
    primary = next(r for r in rows if r["role"] == "primary")
    out.mkdir(parents=True)
    with (out / "stats.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    with (out / "exclusions.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=["condition", "fault_timing", "repetition", "reason"])
        writer.writeheader()
        writer.writerows(exclusions)
    summary = dict(protocol=PROTOCOL, stage=stage, run=str(run), run_id=plan.get("run_id"), seed=plan.get("seed"),
                   plan_design_sha256=plan["design_sha256"],
                   use=("PILOT: procedure check only; not evidence for final claims; never pooled with the main study"
                        if stage != "main" else "MAIN: pre-registered analysis"),
                   primary=dict(PRIMARY, estimate=primary["diff_exit_minus_fixed_retry"], ci_low=primary["diff_ci_low"],
                                ci_high=primary["diff_ci_high"], ci_method=primary["ci_method"], ci_note=primary["ci_note"],
                                sign_test_p=primary["sign_test_p"],
                                multiplicity="single primary test; no adjustment"),
                   planned_blocks=len(blocks), valid_blocks=len(valid), excluded_blocks=len(exclusions),
                   cells_checkpointed=sum(c["record"] is not None for c in cells), cells_planned=len(cells),
                   audited_exclusions=sum(c["audit"] is not None for c in cells),
                   attempts_per_message=attempt_summary, ack_latency=latency, control_overhead=overhead,
                   not_reported=["message-level Wilson intervals (messages within a cell are not independent)"])
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    sums = "".join(f"{hashlib.sha256((out / n).read_bytes()).hexdigest()}  {n}\n" for n in ("stats.csv", "exclusions.csv", "summary.json"))
    (out / "OUTPUT_SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    return summary, rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="exactly one run folder; runs are never pooled")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    summary, _ = analyze(args.run, args.out)
    print(json.dumps({k: summary[k] for k in ("stage", "valid_blocks", "excluded_blocks", "cells_checkpointed", "cells_planned")}))
    sys.exit(0)
