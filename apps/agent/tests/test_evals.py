"""The evaluation suite's own logic (no model, no network): scenarios are consistent and scoring is strict."""
from evals.scenarios import MENU, SCENARIOS
from evals.scoring import markdown, score_run, summarize

ITEMS = {i["id"]: i for i in MENU["items"]}


def test_every_expected_order_is_a_valid_order_for_the_menu():
    for s in SCENARIOS:
        for item_id, _, opts in s.existing or []:
            assert item_id in ITEMS and all(any(o["id"] == x for g in ITEMS[item_id]["modifierGroups"] for o in g["options"]) for x in opts)
        assert (s.existing is None) == (s.outcome is None)
        assert s.outcome in (None, "cancelled", "replaced", "untouched")
        assert (s.outcome == "replaced") == bool(s.expected and s.existing is not None), s.id
        for item_id, qty, opts in s.expected:
            item = ITEMS[item_id]
            assert qty >= 1
            allowed = {o["id"]: g for g in item["modifierGroups"] for o in g["options"]}
            assert set(opts) <= set(allowed), (s.id, opts)
            for g in item["modifierGroups"]:
                picked = [o for o in opts if allowed[o] is g]
                assert len(picked) <= g["maxSelect"], (s.id, g["name"])
                assert picked or not g["required"], f"{s.id}: required group {g['name']} unanswered"


def test_scenario_ids_are_unique():
    assert len({s.id for s in SCENARIOS}) == len(SCENARIOS)


def line(item, qty=1, opts=()):
    return {"item_id": item, "quantity": qty, "option_ids": list(opts)}


def test_scoring_is_strict():
    want = [("pz", 1, ("thin", "cheese"))]
    assert score_run("x", want, [[line("pz", 1, ["cheese", "thin"])]]).passed  # option order ignored
    assert score_run("x", want, [[line("pz", 1, ["thin"]), ]]).passed is False  # missing surcharge option
    assert score_run("x", want, [[line("pz", 2, ["thin", "cheese"])]]).passed is False
    assert score_run("x", want, []).passed is False
    dup = [[line("pz", 1, ["thin", "cheese"])]] * 2
    assert "duplicate" in score_run("x", want, dup).reason
    assert score_run("x", want, [[line("pz", 1, ["thin", "cheese"]), line("cola")]]).passed is False
    # identical lines in one order are merged before comparing
    assert score_run("x", [("cola", 2, ())], [[line("cola"), line("cola")]]).passed
    assert score_run("x", want, [], error="boom").passed is False


def test_nothing_wanted_means_no_order():
    assert score_run("n", [], []).passed
    assert score_run("n", [], [[line("cola")]]).passed is False


def test_threshold_applies_to_the_overall_pass_rate():
    ok = [score_run("a", [], []) for _ in range(9)] + [score_run("a", [], [[line("cola")]])]
    bad = [score_run("b", [], [[line("cola")]]) for _ in range(5)]
    assert summarize(ok, 0.9)["passed"]
    s = summarize(ok + bad, 0.9)  # overall 9/15 = 60%
    assert not s["passed"]
    assert not summarize([], 0.9)["passed"]
    assert "FAIL" in markdown(s)


def test_change_and_cancel_scoring_checks_the_earlier_order_too():
    want = [("cola", 1, ())]
    new = [[line("cola")]]
    assert score_run("c", want, new, outcome="replaced", actual_outcome="replaced").passed
    assert not score_run("c", want, new, outcome="replaced", actual_outcome="untouched").passed  # old order left alive
    assert score_run("c", [], [], outcome="cancelled", actual_outcome="cancelled").passed
    assert not score_run("c", [], new, outcome="cancelled", actual_outcome="cancelled").passed  # cancelled AND reordered
    assert not score_run("c", [], [], outcome="cancelled", actual_outcome="untouched").passed
    assert score_run("c", [], [], outcome="untouched", actual_outcome="untouched").passed
    assert not score_run("c", [], [], outcome="untouched", actual_outcome="cancelled").passed  # refusal bypassed


def test_evals_never_default_to_xai(monkeypatch):
    """xAI is too costly for automated runs: even with VOICE_MODE=grok and an xAI key present."""
    import pytest

    from evals import run_evals as r

    for k in ("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "EVAL_AGENT_PROVIDER", "EVAL_CALLER_PROVIDER"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("VOICE_MODE", "grok")
    monkeypatch.setenv("XAI_API_KEY", "x")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    assert (r.agent_provider(), r.caller_provider()) == ("deepseek", "deepseek")
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    assert (r.agent_provider(), r.caller_provider()) == ("openai", "openai")
    monkeypatch.setenv("EVAL_AGENT_PROVIDER", "grok")  # only on purpose
    assert r.agent_provider() == "grok"
    for k in ("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "EVAL_AGENT_PROVIDER"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(SystemExit):  # only an xAI key: refuse rather than silently spend on it
        r.caller_provider()


def test_a_goodbye_scenario_fails_when_the_agent_never_hangs_up():
    ok = score_run("g", [], [], expect_hangup=True, hung_up=True)
    bad = score_run("g", [], [], expect_hangup=True, hung_up=False)
    assert ok.passed and not bad.passed and "never hung up" in bad.reason
    assert score_run("g", [], [], expect_hangup=False, hung_up=False).passed  # no requirement, no penalty


def test_pickup_is_scored_when_a_scenario_expects_one():
    want = [("cola", 1, ())]
    sent = [[line("cola")]]
    ok = score_run("p", want, sent, expect_pickup="18:30", pickup={"type": "time", "time": "18:30"})
    assert ok.passed
    wrong = score_run("p", want, sent, expect_pickup="18:30", pickup={"type": "asap"})
    assert not wrong.passed and "wanted '18:30'" in wrong.reason
    assert score_run("p", want, sent, expect_pickup="asap", pickup={"type": "asap"}).passed
    assert score_run("p", want, sent, pickup={"type": "asap"}).passed  # not checked when the scenario has none


def test_text_step_is_scored_on_who_was_texted_and_the_hang_up():
    from evals.scoring import score_run

    order = [[{"item_id": "cola", "quantity": 1, "option_ids": []}]]
    base = dict(scenario_id="s", expected=[("cola", 1, ())], orders=order, hung_up=True, caller="+14045550100")
    assert score_run(**base, expect_text="caller", texted=["+14045550100"]).passed
    assert score_run(**base, expect_text="+16785550199", texted=["+16785550199"]).passed
    assert score_run(**base, expect_text="none", texted=[]).passed
    assert not score_run(**base, expect_text="none", texted=["+14045550100"]).passed  # texted a caller who declined
    assert not score_run(**base, expect_text="caller", texted=[]).passed  # never texted
    assert not score_run(**base, expect_text="caller", texted=["+19999999999"]).passed  # wrong number
    assert not score_run(**{**base, "hung_up": False}, expect_text="caller", texted=["+14045550100"]).passed
