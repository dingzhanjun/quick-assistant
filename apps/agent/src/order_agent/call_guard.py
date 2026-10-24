"""Call safety: limits on duration/silence, order idempotency and the retry-then-give-up path.

Pure logic (clock and API injected) so it is tested without audio, LiveKit or a network.
Defaults follow LAUNCH_PLAN D2/D4; override with the CALL_* environment variables.
"""
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Literal

import httpx

logger = logging.getLogger("order_agent")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def mask_number(n: str | None) -> str:
    """Phone number for routine logs: keep the last 4 digits only (logs outlive the 14-day log retention if forgotten)."""
    if not n:
        return "-"
    digits = [c for c in n if c.isdigit()]
    return "***" + "".join(digits[-4:]) if len(digits) > 4 else "***"


@dataclass
class CallInfo:
    call_id: str  # LiveKit room name; unique per call
    caller: str | None = None  # caller's number from SIP, if present
    transfer: object | None = None  # a transfer.Transferer once the restaurant's menu (and human line) is known


@dataclass(frozen=True)
class Limits:
    max_seconds: float = 8 * 60
    warn_seconds: float = 60  # how long before max_seconds the caller is told time is nearly up
    idle_prompt_seconds: float = 20
    idle_hangup_seconds: float = 30

    @classmethod
    def from_env(cls) -> "Limits":
        d = cls()
        return cls(
            max_seconds=_env_float("CALL_MAX_SECONDS", d.max_seconds),
            warn_seconds=_env_float("CALL_WARN_SECONDS", d.warn_seconds),
            idle_prompt_seconds=_env_float("CALL_IDLE_PROMPT_SECONDS", d.idle_prompt_seconds),
            idle_hangup_seconds=_env_float("CALL_IDLE_HANGUP_SECONDS", d.idle_hangup_seconds),
        )


Action = Literal["none", "warn_time", "ask_still_there", "hangup_idle", "hangup_max"]


class CallClock:
    """Decides what to do at time `now` (seconds, any monotonic clock). Call `check` about once a second."""

    def __init__(self, limits: Limits, now: float) -> None:
        self.limits = limits
        self.started = now
        self.idle_since: float | None = now  # None while someone is speaking or the agent is working
        self._warned = False
        self._asked = False

    def busy(self, now: float) -> None:
        """Someone is speaking (caller or agent) or a reply is being prepared."""
        self.idle_since = None
        self._asked = False

    def quiet(self, now: float) -> None:
        """Nobody is speaking: the silence timer starts."""
        if self.idle_since is None:
            self.idle_since = now

    def check(self, now: float) -> Action:
        lim = self.limits
        elapsed = now - self.started
        if elapsed >= lim.max_seconds:
            return "hangup_max"
        if self.idle_since is not None:
            idle = now - self.idle_since
            if idle >= lim.idle_hangup_seconds:
                return "hangup_idle"
            if idle >= lim.idle_prompt_seconds and not self._asked:
                self._asked = True
                return "ask_still_there"
        if not self._warned and elapsed >= lim.max_seconds - lim.warn_seconds:
            self._warned = True
            return "warn_time"
        return "none"


def cart_key(call_id: str, payload: list[dict], extra: str = "") -> str:
    """Idempotency key: the same call with the same cart always yields the same key, so a retried
    submit (or a second 'yes' from the caller) cannot create a second order."""
    canon = json.dumps(
        sorted(
            (
                {
                    "i": p["item_id"],
                    "q": p["quantity"],
                    "n": p.get("notes") or "",
                    "o": sorted(p.get("option_ids") or []),
                }
                for p in payload
            ),
            key=lambda d: json.dumps(d, sort_keys=True),
        ),
        sort_keys=True,
    )
    # `extra` (the pickup time) is part of the key: the same cart for a different pickup time is a different order.
    return f"{call_id}:{hashlib.sha256((canon + '|' + extra).encode()).hexdigest()[:16]}"


@dataclass
class SubmitResult:
    status: Literal["ok", "rejected", "failed"]
    order_number: int | None = None
    message: str = ""


async def submit_with_retry(
    submit: Callable[[], Awaitable[dict]],
    *,
    describe: str,
    sleep: Callable[[float], Awaitable[None]],
    retry_delay: float = 1.0,
) -> SubmitResult:
    """Try to save the order, retrying ONCE (the same idempotency key makes that safe).

    ok       -> saved
    rejected -> the server refused it (4xx, e.g. an unavailable dish): the caller can fix it
    failed   -> the order system is unreachable/erroring: apologise, the restaurant calls back
    """
    last: Exception | None = None
    for attempt in (1, 2):
        try:
            res = await submit()
            return SubmitResult("ok", order_number=res.get("order_number"))
        except httpx.HTTPStatusError as e:
            if 400 <= e.response.status_code < 500:
                return SubmitResult("rejected", message=e.response.text[:300])
            last = e
        except (httpx.HTTPError, OSError) as e:
            last = e
        logger.warning("order submit attempt %d failed: %r", attempt, last)
        if attempt == 1:
            await sleep(retry_delay)
    # The alert: grep logs for ALERT. The cart is included so staff can still act on it.
    logger.error("ALERT: order NOT saved after retry (%s): %r", describe, last)
    return SubmitResult("failed", message=repr(last))


# ---- the agent saying goodbye (safety net for hanging up) -----------------------------------------------------------
_GOODBYE = re.compile(
    r"\b(good-?bye|bye(-bye)?|take care|have a (good|great|nice|wonderful|lovely) (one|day|night|evening|afternoon|weekend))\b",
    re.IGNORECASE,
)


def is_goodbye(text: str | None) -> bool:
    """Did the agent just say goodbye? A message that still asks the caller something is not a goodbye."""
    if not text or "?" in text:
        return False
    return bool(_GOODBYE.search(text))


_CALLER_GOODBYE = re.compile(r"\b(good-?bye|bye(-bye)?)\b", re.IGNORECASE)


def caller_said_goodbye(text: str | None) -> bool:
    """The CALLER said bye / goodbye: the call ends whatever else is going on (the agent gets to say its
    own goodbye first if it is already replying). Word boundaries keep "by the way" or "hello" from matching."""
    return bool(text and _CALLER_GOODBYE.search(text))
