"""Pure scoring + reporting for the evaluation suite (unit-tested without any model)."""
from collections import defaultdict
from dataclasses import dataclass


def normalize(submitted: list[dict]) -> list[tuple[str, int, tuple[str, ...]]]:
    """Order payload (as sent to the API) -> comparable lines. Identical lines are merged, option order ignored."""
    merged: dict[tuple[str, tuple[str, ...]], int] = defaultdict(int)
    for line in submitted:
        merged[(line["item_id"], tuple(sorted(line.get("option_ids") or [])))] += line["quantity"]
    return sorted((item, qty, opts) for (item, opts), qty in merged.items())


def expected_lines(expected: list) -> list[tuple[str, int, tuple[str, ...]]]:
    return sorted((item, qty, tuple(sorted(opts))) for item, qty, opts in expected)


@dataclass
class RunScore:
    scenario: str
    passed: bool
    submitted: int  # how many orders were submitted on this call
    reason: str = ""


def score_run(
    scenario_id: str, expected: list, orders: list[list[dict]], error: str | None = None,
    outcome: str | None = None, actual_outcome: str | None = None,
    expect_hangup: bool = False, hung_up: bool = False,
    expect_pickup: str | None = None, pickup: dict | None = None,
    expect_text: str | None = None, texted: list[str] | None = None, caller: str = "",
) -> RunScore:
    """One simulated call. Pass = exactly one correct order, or (when nothing was wanted) no order at all.
    Cancel/change scenarios (`outcome` set) also require the earlier order to end up cancelled / replaced / untouched."""
    n = len(orders)
    if error:
        return RunScore(scenario_id, False, n, f"error: {error}")
    if expect_pickup is not None and orders:
        got = None if pickup is None else ("asap" if pickup.get("type") == "asap" else pickup.get("time"))
        if got != expect_pickup:
            return RunScore(scenario_id, False, n, f"pickup time {got!r}, wanted {expect_pickup!r}")
    if expect_text is not None and orders:
        # "none" = the caller declined the text; "caller" = their own number; anything else = that E.164 number
        want = [] if expect_text == "none" else [caller if expect_text == "caller" else expect_text]
        if (texted or []) != want:
            return RunScore(scenario_id, False, n, f"texted {texted or []}, wanted {want}")
        if not hung_up:
            return RunScore(scenario_id, False, n, "the agent never hung up after the text step")
    if expect_hangup and not hung_up:
        return RunScore(scenario_id, False, n, "the agent never hung up after the goodbye (end_call not called)")
    if outcome is not None and actual_outcome != outcome:
        return RunScore(scenario_id, False, n, f"earlier order ended {actual_outcome}, wanted {outcome}")
    if outcome in ("cancelled", "untouched"):
        return RunScore(scenario_id, n == 0, n, "" if n == 0 else f"unwanted new order {normalize(orders[0])}")
    if not expected:
        return RunScore(scenario_id, n == 0, n, "" if n == 0 else f"unwanted order {normalize(orders[0])}")
    if n == 0:
        return RunScore(scenario_id, False, n, "no order submitted")
    if n > 1:
        return RunScore(scenario_id, False, n, f"{n} orders submitted (duplicate)")
    got, want = normalize(orders[0]), expected_lines(expected)
    if got != want:
        return RunScore(scenario_id, False, n, f"wrong order: got {got}, want {want}")
    return RunScore(scenario_id, True, n)


def summarize(scores: list[RunScore], threshold: float) -> dict:
    def rate(rows):
        return sum(r.passed for r in rows) / len(rows) if rows else 0.0

    by_scn = defaultdict(list)
    for s in scores:
        by_scn[s.scenario].append(s)
    overall = rate(scores)
    return {
        "overall": overall,
        "scenarios": {k: rate(v) for k, v in sorted(by_scn.items())},
        "runs": len(scores),
        "threshold": threshold,
        "passed": bool(scores) and overall >= threshold,
        "failures": [f"{s.scenario}: {s.reason}" for s in scores if not s.passed],
    }


def markdown(summary: dict) -> str:
    lines = [
        f"## Ordering evals: {'PASS' if summary['passed'] else 'FAIL'}",
        f"Overall {summary['overall']:.0%} over {summary['runs']} runs (threshold {summary['threshold']:.0%}).",
        "",
        "| Scenario | Pass rate |", "|---|---|",
        *[f"| {k} | {v:.0%} |" for k, v in summary["scenarios"].items()],
    ]
    if summary["failures"]:
        lines += ["", "<details><summary>Failures</summary>", "", *[f"- {f}" for f in summary["failures"][:40]], "", "</details>"]
    return "\n".join(lines)
