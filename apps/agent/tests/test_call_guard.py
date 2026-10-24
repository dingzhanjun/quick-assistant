"""Call limits, idempotency key and the retry-then-give-up path (no network, no LLM)."""
import asyncio

import httpx

from order_agent import api, main as m
from order_agent.call_guard import CallClock, CallInfo, Limits, cart_key, submit_with_retry

LIM = Limits(max_seconds=480, warn_seconds=60, idle_prompt_seconds=20, idle_hangup_seconds=30)


def run(coro):
    return asyncio.run(coro)


def test_idle_caller_is_asked_then_hung_up():
    c = CallClock(LIM, 0)
    assert c.check(19) == "none"
    assert c.check(20) == "ask_still_there"
    assert c.check(21) == "none"  # asked only once
    assert c.check(29) == "none"
    assert c.check(30) == "hangup_idle"


def test_speech_resets_the_silence_timer():
    c = CallClock(LIM, 0)
    assert c.check(20) == "ask_still_there"
    c.busy(25)
    assert c.check(100 - 50) == "none"  # while someone is speaking nothing fires
    c.quiet(60)
    assert c.check(79) == "none"
    assert c.check(80) == "ask_still_there"  # asked again after new speech


def test_long_call_is_warned_then_ended():
    c = CallClock(LIM, 0)
    c.busy(0)  # keep the idle timer out of the way
    assert c.check(419) == "none"
    assert c.check(420) == "warn_time"
    assert c.check(421) == "none"
    assert c.check(480) == "hangup_max"


def test_cart_key_is_stable_and_order_independent():
    a = {"item_id": "x", "quantity": 1, "notes": "", "option_ids": ["b", "a"]}
    b = {"item_id": "y", "quantity": 2, "notes": None, "option_ids": []}
    assert cart_key("room", [a, b]) == cart_key("room", [b, {**a, "option_ids": ["a", "b"]}])
    assert cart_key("room", [a]) != cart_key("room", [{**a, "quantity": 2}])
    assert cart_key("room", [a]) != cart_key("other", [a])


def _status_error(code):
    req = httpx.Request("POST", "http://x")
    return httpx.HTTPStatusError("e", request=req, response=httpx.Response(code, request=req, text="nope"))


async def _nosleep(_):
    pass


def test_retry_once_then_succeed_uses_same_call():
    calls = []

    async def submit():
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("down")
        return {"order_number": 7}

    r = run(submit_with_retry(submit, describe="t", sleep=_nosleep))
    assert (r.status, r.order_number, len(calls)) == ("ok", 7, 2)


def test_api_down_gives_failed_and_logs_alert(caplog):
    async def submit():
        raise _status_error(503)

    with caplog.at_level("ERROR", logger="order_agent"):
        r = run(submit_with_retry(submit, describe="cart", sleep=_nosleep))
    assert r.status == "failed"
    assert "ALERT" in caplog.text


def test_client_error_is_not_retried():
    calls = []

    async def submit():
        calls.append(1)
        raise _status_error(422)

    r = run(submit_with_retry(submit, describe="t", sleep=_nosleep))
    assert (r.status, len(calls)) == ("rejected", 1)


MENU = {"name": "T", "items": [{"id": "cola", "name": "Cola", "description": None, "priceCents": 300, "modifierGroups": []}]}


def test_submit_order_tool_sends_key_and_caller_and_handles_outage(monkeypatch):
    sent = []

    async def ok(called, body):
        sent.append(body)
        return {"order_number": 12}

    monkeypatch.setattr(api, "submit_order", ok)
    done = []
    a = m.OrderAgent("+1", MENU, call=CallInfo("room-1", "+15551234567"), on_order_submitted=lambda: done.append(1))
    run(a.add_item(None, "cola", 1))
    run(a.set_pickup_time(None, "asap"))
    assert "number 12" in run(a.submit_order(None, "Sam"))
    assert sent[0]["idempotency_key"].startswith("room-1:") and sent[0]["caller"] == "+15551234567"
    assert done == [1]

    async def down(called, body):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(api, "submit_order", down)
    monkeypatch.setattr(asyncio, "sleep", _nosleep)
    b = m.OrderAgent("+1", MENU, call=CallInfo("room-2", None), on_order_submitted=lambda: done.append(2))
    run(b.add_item(None, "cola", 1))
    run(b.set_pickup_time(None, "asap"))
    out = run(b.submit_order(None, "Sam"))
    assert "could NOT be saved" in out and "Do not give an order number" in out
    assert done == [1, 2] and b.items  # call winds down, cart kept


def test_routine_logs_mask_caller_numbers():
    from order_agent.call_guard import mask_number

    assert mask_number("+15551234567") == "***4567"
    assert mask_number(None) == "-" and mask_number("12") == "***"
