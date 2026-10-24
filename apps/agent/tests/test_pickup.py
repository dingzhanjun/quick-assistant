"""Pickup time: the agent must have one before it can submit; the server's refusals send it back to the caller."""
import asyncio

import httpx

from order_agent import api, main as m
from order_agent.call_guard import CallInfo, cart_key
from evals.scenarios import MENU


def run(coro):
    return asyncio.run(coro)


def agent():
    a = m.OrderAgent("+1", MENU, call=CallInfo("room", "+15551234567"), on_order_submitted=lambda: None)
    run(a.add_item(None, "cola", 1))
    return a


def test_set_pickup_time_accepts_asap_and_24_hour_times_only():
    a = agent()
    assert a.pickup is None
    assert "saved" in run(a.set_pickup_time(None, "asap")) and a.pickup == {"type": "asap"}
    assert "saved" in run(a.set_pickup_time(None, "18:30")) and a.pickup == {"type": "time", "time": "18:30"}
    for bad in ["6:30", "25:00", "later", "", "6:30pm"]:
        assert "Invalid time" in run(a.set_pickup_time(None, bad)), bad
    assert a.pickup == {"type": "time", "time": "18:30"}  # a bad value never overwrites a good one


def test_pickup_is_part_of_the_read_back_in_plain_words():
    a = agent()
    assert "not asked yet" in a._summary()
    run(a.set_pickup_time(None, "asap"))
    assert "Pickup: as soon as possible" in run(a.get_order(None))
    run(a.set_pickup_time(None, "18:30"))
    assert "Pickup: 6:30 PM" in run(a.get_order(None))
    run(a.set_pickup_time(None, "14:00"))
    assert "Pickup: 2 PM" in a._summary()


def test_submit_is_refused_until_a_pickup_time_is_saved(monkeypatch):
    sent = []

    async def ok(called, body):
        sent.append(body)
        return {"order_number": 5}
    monkeypatch.setattr(api, "submit_order", ok)
    a = agent()
    out = run(a.submit_order(None, "Sam"))
    assert "pickup time has not been saved" in out and sent == []
    run(a.set_pickup_time(None, "19:15"))
    assert "number 5" in run(a.submit_order(None, "Sam"))
    assert sent[0]["pickup"] == {"type": "time", "time": "19:15"}


def test_the_pickup_time_is_part_of_the_idempotency_key():
    items = [{"item_id": "x", "quantity": 1, "notes": "", "option_ids": []}]
    assert cart_key("r", items, "a") != cart_key("r", items, "b")
    assert cart_key("r", items, "a") == cart_key("r", items, "a")


def test_server_refusals_send_the_agent_back_to_ask_again(monkeypatch):
    def refusing(body):
        async def refuse(called, payload):
            req = httpx.Request("POST", "http://x")
            raise httpx.HTTPStatusError("422", request=req, response=httpx.Response(422, request=req, text=body))
        return refuse

    a = agent()
    run(a.set_pickup_time(None, "11:00"))
    monkeypatch.setattr(api, "submit_order", refusing('{"error":"pickup_in_past","hours":null}'))
    out = run(a.submit_order(None, "Sam"))
    assert "already passed" in out and a.pickup is None and a.items  # cart kept, time must be asked again

    run(a.set_pickup_time(None, "23:30"))
    monkeypatch.setattr(api, "submit_order", refusing('{"error":"pickup_closed","hours":"Monday 11 AM to 10 PM"}'))
    out = run(a.submit_order(None, "Sam"))
    assert "not open at that time" in out and "Monday 11 AM to 10 PM" in out and a.pickup is None


def test_prompt_asks_for_the_pickup_time_before_the_read_back():
    en = m.build_instructions(MENU)
    assert "PICKUP TIME" in en and "as soon as possible, or a little later" in en and "set_pickup_time" in en
