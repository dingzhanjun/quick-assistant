"""Worker tuning from the environment, and the per-worker call cap that stops new calls (no LiveKit server needed)."""
import types

import pytest

from order_agent import main as m

KEYS = ["AGENT_NAME", "AGENT_MAX_CALLS", "AGENT_LOAD_THRESHOLD", "AGENT_IDLE_PROCESSES", "AGENT_JOB_MEMORY_WARN_MB",
        "AGENT_JOB_MEMORY_LIMIT_MB", "AGENT_DRAIN_SECONDS", "AGENT_PROMETHEUS_PORT"]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)


def test_defaults_keep_livekits_own_behaviour_except_a_shorter_drain():
    o = m.worker_options()
    assert o.agent_name == "" and o.drain_timeout == 900  # calls last 8 minutes at most: do not wait an hour on deploy
    assert o.job_memory_limit_mb == 0  # unchanged: no limit
    assert o.load_fnc.__name__ == "get_load"  # still LiveKit's CPU-based load


def test_every_setting_can_be_tuned_from_the_environment(monkeypatch):
    for k, v in {"AGENT_NAME": "order-agent", "AGENT_LOAD_THRESHOLD": "0.5", "AGENT_IDLE_PROCESSES": "3",
                 "AGENT_JOB_MEMORY_WARN_MB": "600", "AGENT_JOB_MEMORY_LIMIT_MB": "1200",
                 "AGENT_DRAIN_SECONDS": "300", "AGENT_PROMETHEUS_PORT": "9464", "AGENT_MAX_CALLS": "40"}.items():
        monkeypatch.setenv(k, v)
    o = m.worker_options()
    assert (o.agent_name, o.load_threshold, o.num_idle_processes) == ("order-agent", 0.5, 3)
    assert (o.job_memory_warn_mb, o.job_memory_limit_mb, o.drain_timeout, o.prometheus_port) == (600, 1200, 300, 9464)
    assert o.load_fnc.__name__ == "load"  # the call-count load replaces the CPU-only one


def test_bad_values_are_ignored_not_fatal(monkeypatch, caplog):
    for k in ("AGENT_LOAD_THRESHOLD", "AGENT_IDLE_PROCESSES", "AGENT_MAX_CALLS", "AGENT_DRAIN_SECONDS"):
        monkeypatch.setenv(k, "lots")
    monkeypatch.setenv("AGENT_JOB_MEMORY_WARN_MB", "-5")
    with caplog.at_level("WARNING", logger="order_agent"):
        o = m.worker_options()
    assert o.drain_timeout == 900 and o.load_fnc.__name__ == "get_load"
    assert caplog.text.count("ignoring") >= 5


def worker(calls):
    return types.SimpleNamespace(active_jobs=[object()] * calls)


def test_the_call_cap_spreads_calls_and_then_stops_them():
    load = m.make_load_fnc(10, lambda w: 0.05)  # almost idle CPU, as in speech-to-speech mode
    assert load(worker(0)) == 0.05
    assert load(worker(5)) == pytest.approx(0.3)          # grows with the call count: fewer-call workers are preferred
    assert load(worker(9)) == pytest.approx(0.54) and load(worker(9)) < 0.7  # still under LiveKit's 0.7 threshold
    assert load(worker(10)) == 1.0 and load(worker(25)) == 1.0  # at the cap: above the threshold, no new calls


def test_a_busy_cpu_still_counts():
    load = m.make_load_fnc(100, lambda w: 0.9)
    assert load(worker(1)) == 0.9
