"""Cancelling / changing an earlier order from the agent's side (API stubbed; the server enforces the rules)."""
import asyncio

import httpx

from order_agent import api, main as m
from order_agent.call_guard import CallInfo

MENU = {"name": "T", "items": [
    {"id": "pz", "name": "Pizza", "description": None, "priceCents": 1000, "modifierGroups": [
        {"id": "g", "name": "Crust", "required": True, "maxSelect": 1, "options": [
            {"id": "thin", "name": "Thin", "priceDeltaCents": 100}]}]},
    {"id": "cola", "name": "Cola", "description": None, "priceCents": 300, "modifierGroups": []},
]}
ORDER = {"order_number": 7, "customer_name": "Pat", "total_cents": 2300, "can_change": True, "pickup": "18:30", "items": [
    {"item_id": "pz", "name": "Pizza", "quantity": 2, "notes": "", "option_ids": ["thin"], "options": ["Thin"], "line_cents": 2200},
    {"item_id": "cola", "name": "Cola", "quantity": 1, "notes": "", "option_ids": [], "options": [], "line_cents": 300}]}


def run(coro):
    return asyncio.run(coro)


def agent(caller="+15551234567", on_submit=None):
    return m.OrderAgent("+1", MENU, call=CallInfo("room", caller), on_order_submitted=on_submit)


def stub(monkeypatch, lookup=None, cancel=None, submit=None):
    async def default_lookup(called, n, caller):
        return {"allowed": True, "order": ORDER}

    async def default_cancel(called, n, caller):
        return {"cancelled": True}

    monkeypatch.setattr(api, "lookup_order", lookup or default_lookup)
    monkeypatch.setattr(api, "cancel_order", cancel or default_cancel)
    if submit:
        monkeypatch.setattr(api, "submit_order", submit)


def test_find_order_describes_it_and_cancel_needs_a_lookup_first(monkeypatch):
    stub(monkeypatch)
    a = agent()
    assert "find_order first" in run(a.cancel_found_order(None))
    out = run(a.find_order(None, 7))
    assert "2 x Pizza (Thin)" in out and "1 x Cola" in out and "$23.00" in out
    assert "cancelled" in run(a.cancel_found_order(None)) and a.found is None


def test_refusals_are_explained_and_never_leak_which_numbers_exist(monkeypatch):
    for reason, expect in [("no_caller", "hidden"), ("not_new", "already started"), ("no_match", "from this phone number")]:
        async def deny(called, n, caller, r=reason):
            return {"allowed": False, "reason": r}
        stub(monkeypatch, lookup=deny)
        a = agent()
        assert expect in run(a.find_order(None, 7)), reason
        assert a.found is None


def test_lookups_are_capped_after_three_misses(monkeypatch):
    async def deny(called, n, caller):
        return {"allowed": False, "reason": "no_match"}
    stub(monkeypatch, lookup=deny)
    a = agent()
    for n in (1, 2, 3):
        run(a.find_order(None, n))
    assert "Too many attempts" in run(a.find_order(None, 4))


def test_cancel_failure_is_not_reported_as_success(monkeypatch):
    async def late(called, n, caller):
        return {"cancelled": False, "reason": "not_new"}
    stub(monkeypatch, cancel=late)
    a = agent()
    run(a.find_order(None, 7))
    assert "could NOT be cancelled" in run(a.cancel_found_order(None))

    async def boom(called, n, caller):
        raise httpx.ConnectError("down")
    stub(monkeypatch, cancel=boom)
    b = agent()
    run(b.find_order(None, 7))
    assert "NOT cancelled" in run(b.cancel_found_order(None))


def test_change_loads_the_cart_then_submit_replaces_the_old_order(monkeypatch):
    sent = []

    async def ok(called, body):
        sent.append(body)
        return {"order_number": 9, "replaced": 7}
    stub(monkeypatch, submit=ok)
    done = []
    a = agent(on_submit=lambda: done.append(1))
    run(a.find_order(None, 7))
    assert "loaded" in run(a.change_found_order(None))
    assert [(i["item_id"], i["quantity"], i["option_ids"]) for i in a.items] == [("pz", 2, ["thin"]), ("cola", 1, [])]
    run(a.remove_item(None, "cola"))
    out = run(a.submit_order(None, "Pat"))
    assert sent[0]["replaces_order_number"] == 7 and [i["item_id"] for i in sent[0]["items"]] == ["pz"]
    assert sent[0]["pickup"] == {"type": "time", "time": "18:30"}  # the old order's pickup time carried over
    assert "old order 7 is cancelled" in out and "number is 9" in out
    assert a.replacing is None and done == [1]


def test_change_refused_when_old_order_started_keeps_the_old_one(monkeypatch):
    async def conflict(called, body):
        req = httpx.Request("POST", "http://x")
        raise httpx.HTTPStatusError("409", request=req, response=httpx.Response(409, request=req, text='{"error":"cannot_replace","reason":"not_new"}'))
    stub(monkeypatch, submit=conflict)
    a = agent()
    run(a.find_order(None, 7))
    run(a.change_found_order(None))
    out = run(a.submit_order(None, "Pat"))
    assert "NEW order has NOT been saved" in out and a.replacing is None


def test_change_is_declined_when_the_order_cannot_be_rebuilt(monkeypatch):
    old = {**ORDER, "can_change": False}

    async def lk(called, n, caller):
        return {"allowed": True, "order": old}
    stub(monkeypatch, lookup=lk)
    a = agent()
    run(a.find_order(None, 7))
    assert "cannot be edited" in run(a.change_found_order(None)) and a.items == []
