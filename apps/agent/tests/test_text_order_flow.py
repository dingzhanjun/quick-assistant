"""After the order: offer to text the order link; hang up only after a decline or once the text is queued."""
import asyncio

import pytest

from order_agent import api
from order_agent import main as m
from order_agent.call_guard import CallInfo
from order_agent.order_text import DECLINED, FINAL, read_back

MENU = {"name": "T", "text_orders": True,
        "items": [{"id": "cola", "name": "Cola", "description": None, "priceCents": 300, "modifierGroups": []}]}


def run(coro):
    return asyncio.run(coro)


class FakeSession:
    def __init__(self):
        self.said = []

    def say(self, text):
        self.said.append(text)


@pytest.fixture
def world(monkeypatch):
    w = type("W", (), {})()
    w.texts, w.armed, w.reply = [], [], {"ok": True}

    async def submit(called, body):
        return {"order_number": 7}

    async def text(called, order_number, number):
        w.texts.append((called, order_number, number))
        if isinstance(w.reply, Exception):
            raise w.reply
        return w.reply

    monkeypatch.setattr(api, "submit_order", submit)
    monkeypatch.setattr(api, "request_order_text", text)

    def make(caller="+14045550100", menu=MENU):
        a = m.OrderAgent("+1", menu, call=CallInfo("room", caller), on_order_submitted=lambda: w.armed.append(1))
        w.session = FakeSession()
        monkeypatch.setattr(type(a), "session", property(lambda self: w.session), raising=False)
        run(a.add_item(None, "cola", 1))
        run(a.set_pickup_time(None, "asap"))
        return a

    w.make = make
    return w


def placed(w, **kw):
    a = w.make(**kw)
    out = run(a.submit_order(None, "Sam"))
    return a, out


def test_after_the_order_the_agent_asks_and_does_not_hang_up(world):
    a, out = placed(world)
    assert "number 7" in out and "ONE question" in out and "calling from" in out and "Do not say goodbye" in out
    assert world.armed == [] and world.texts == []


def test_hidden_caller_number_is_asked_for(world):
    a, out = placed(world, caller=None)
    assert "hidden" in out and "what number should we use" in out
    assert "hidden" in run(a.text_order(None, ""))  # no number given and none known: ask which number
    assert world.texts == [] and world.armed == []


def test_yes_to_the_calling_number_sends_and_hangs_up_after_the_thanks(world):
    a, _ = placed(world)
    out = run(a.text_order(None, ""))
    assert world.texts == [("+1", 7, "+14045550100")]
    assert FINAL in out and world.armed == [1]
    assert world.session.said == []  # no number is read aloud when it is the calling number


def test_another_number_is_read_back_by_the_system_and_needs_a_yes(world):
    a, _ = placed(world)
    out = run(a.text_order(None, "(678) 555-0199"))
    assert world.texts == [] and world.armed == []
    assert world.session.said == [read_back("+16785550199")]
    assert "Say NOTHING" in out
    out = run(a.confirm_text_number(None))
    assert world.texts == [("+1", 7, "+16785550199")] and world.armed == [1] and FINAL in out


def test_a_corrected_number_replaces_the_pending_one(world):
    a, _ = placed(world)
    run(a.text_order(None, "678 555 0199"))
    run(a.text_order(None, "678 555 0198"))
    run(a.confirm_text_number(None))
    assert world.texts[-1][2] == "+16785550198" and len(world.texts) == 1
    assert "no number waiting" in run(a.confirm_text_number(None)).lower()  # consumed by the send


def test_saying_the_calling_number_out_loud_needs_no_read_back(world):
    a, _ = placed(world)
    out = run(a.text_order(None, "404-555-0100"))
    assert world.texts == [("+1", 7, "+14045550100")] and world.session.said == [] and FINAL in out


def test_half_a_number_is_asked_again(world):
    a, _ = placed(world)
    out = run(a.text_order(None, "555 0199"))
    assert "area code" in out and world.texts == [] and world.armed == [] and world.session.said == []


def test_confirm_without_a_pending_number_is_refused(world):
    a, _ = placed(world)
    assert "no number waiting" in run(a.confirm_text_number(None)).lower()
    assert world.texts == []


def test_text_tools_do_nothing_before_an_order_exists(world):
    a = world.make()
    assert "no order to text" in run(a.text_order(None, "")).lower()


def test_decline_uses_end_call_which_arms_the_hang_up(world):
    a, _ = placed(world)
    out = run(a.end_call(None))
    assert world.armed == [1] and "goodbye" in out.lower() and world.texts == []


@pytest.mark.parametrize("reply, reason", [({"ok": False, "reason": "number_limit"}, "number_limit"), ({"ok": False, "reason": "sms_off"}, "sms_off")])
def test_server_refusals_apologise_keep_the_order_and_end_the_call(world, reply, reason):
    world.reply = reply
    a, _ = placed(world)
    out = run(a.text_order(None, ""))
    assert reason in out and "order IS placed" in out and world.armed == [1]


def test_server_says_bad_number_asks_again_without_ending(world):
    world.reply = {"ok": False, "reason": "bad_number"}
    a, _ = placed(world)
    out = run(a.text_order(None, ""))
    assert "area code" in out and world.armed == []


def test_an_outage_apologises_and_ends_but_the_order_stands(world):
    world.reply = RuntimeError("down")
    a, _ = placed(world)
    out = run(a.text_order(None, ""))
    assert "technical problem" in out and "order IS placed" in out and world.armed == [1]


def test_without_texting_the_old_flow_is_unchanged(world):
    menu = {**MENU, "text_orders": False}
    a, out = placed(world, menu=menu)
    assert out == "Order submitted, number 7" and world.armed == [1]
    assert "no order to text" in run(a.text_order(None, "")).lower()


def test_prompt_follows_the_setting():
    on_en = m.build_instructions(MENU)
    assert "text_order" in on_en and "confirm_text_number" in on_en and "Have a good one!" not in on_en
    assert DECLINED in on_en and "NEVER say or repeat a phone number yourself" in on_en
    off = m.build_instructions({**MENU, "text_orders": False})
    assert 'Have a good one!' in off and "text_order" not in off
