"""Client for the web app's internal API. The agent never touches the DB directly."""
import os

import httpx


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=os.environ["WEB_API_URL"],
        headers={"Authorization": f"Bearer {os.environ['AGENT_API_KEY']}"},
        timeout=10,
    )


async def get_tenant_menu(called_number: str) -> dict:
    """Resolve the dialed phone number to a tenant and return its menu."""
    async with _client() as c:
        r = await c.get("/api/agent/menu", params={"to": called_number})
        r.raise_for_status()
        return r.json()


async def start_call(called_number: str, call_id: str, caller: str | None) -> dict:
    """Announce an inbound call. Returns {"allowed": True} or {"allowed": False, "reason": ...}
    (blocked / rate_limited / busy). Raises HTTPStatusError for an unknown number (404) or suspended tenant (403)."""
    async with _client() as c:
        r = await c.post("/api/agent/calls", json={"to": called_number, "call_id": call_id, "caller": caller})
        r.raise_for_status()
        return r.json()


async def end_call(call_id: str) -> None:
    async with _client() as c:
        r = await c.post("/api/agent/calls/end", json={"call_id": call_id})
        r.raise_for_status()


async def submit_order(called_number: str, order: dict) -> dict:
    async with _client() as c:
        r = await c.post("/api/agent/orders", json={"to": called_number, **order})
        r.raise_for_status()
        return r.json()


async def request_order_text(called_number: str, order_number: int, number: str) -> dict:
    """Ask the server to text the customer a link to this (just placed) order. {"ok": True} or {"ok": False, "reason": ...}
    (sms_off / bad_number / no_order / too_old / order_limit / number_limit). The server queues the message."""
    async with _client() as c:
        r = await c.post("/api/agent/orders/sms", json={"to": called_number, "order_number": order_number, "number": number})
        r.raise_for_status()
        return r.json()


async def report_transfer(called_number: str, call_id: str, via: str, ok: bool, error: str | None) -> None:
    """Tell the web app a call was forwarded to the human line (or that forwarding failed): audit log entry."""
    async with _client() as c:
        r = await c.post("/api/agent/calls/transfer", json={"to": called_number, "call_id": call_id, "via": via, "ok": ok, "error": error})
        r.raise_for_status()


async def lookup_order(called_number: str, order_number: int, caller: str | None) -> dict:
    """May this caller cancel/change order N? {"allowed": True, "order": {...}} or {"allowed": False, "reason": ...}
    (no_caller / no_match / not_new)."""
    async with _client() as c:
        r = await c.post("/api/agent/orders/lookup", json={"to": called_number, "order_number": order_number, "caller": caller})
        r.raise_for_status()
        return r.json()


async def cancel_order(called_number: str, order_number: int, caller: str | None) -> dict:
    """{"cancelled": True} or {"cancelled": False, "reason": ...}. The server re-checks caller and status."""
    async with _client() as c:
        r = await c.post("/api/agent/orders/cancel", json={"to": called_number, "order_number": order_number, "caller": caller})
        r.raise_for_status()
        return r.json()


async def get_config() -> dict:
    """Platform-wide settings (currently the LLM provider/model chosen by the platform admin)."""
    async with _client() as c:
        r = await c.get("/api/agent/config")
        r.raise_for_status()
        return r.json()
