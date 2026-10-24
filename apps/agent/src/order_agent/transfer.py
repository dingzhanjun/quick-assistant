"""Forwarding a call to a human line (keypad 0, or the caller asks for a person).

The number is set per restaurant by the platform admin and arrives with the menu (`transfer_number`). The logic
is here with its collaborators injected, so it is tested without LiveKit; main.py supplies the real ones.
"""
import asyncio
import logging
import re
from typing import Awaitable, Callable, Literal

logger = logging.getLogger("order_agent")
Via = Literal["keypad", "request"]


_DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def spoken_number(e164: str | None) -> str | None:
    """+14155550199 -> "four one five, five five five, zero one nine nine": digit by digit, in the grouping people
    use, so a text-to-speech voice reads a phone number slowly and clearly instead of as one big number."""
    digits = [c for c in (e164 or "") if c.isdigit()]
    if len(digits) < 7:
        return None
    if len(digits) == 11 and digits[0] == "1":  # North America: drop the country code
        digits = digits[1:]
    if len(digits) == 10:
        groups = [digits[:3], digits[3:6], digits[6:]]
    else:
        head = digits[:-4]  # everything before the last four digits, in groups of three
        groups = [head[i : i + 3] for i in range(0, len(head), 3)] + [digits[-4:]]
    return ", ".join(" ".join(_DIGITS[int(d)] for d in g) for g in groups)


def tel_uri(number: str) -> str | None:
    """E.164 number -> the `tel:` URI LiveKit's SIP transfer wants, or None if it is not a plausible number."""
    n = number.strip().replace(" ", "")
    return f"tel:{n}" if re.fullmatch(r"\+[1-9]\d{7,14}", n) else None


class Transferer:
    def __init__(
        self,
        number: str | None,
        *,
        do_transfer: Callable[[str], Awaitable[bool]],  # tel: URI -> did the transfer complete
        say: Callable[[str], Awaitable[None]],  # have the agent speak a short instruction, wait until done
        say_exact: Callable[[str], Awaitable[None]] | None = None,  # speak this exact sentence (a scripted phone number)
        wait_quiet: Callable[[], Awaitable[None]],  # wait until the agent finished speaking
        report: Callable[[Via, bool, str | None], Awaitable[None]],  # tell the server (audit log)
        on_start: Callable[[], None] = lambda: None,  # e.g. stop the silence/time-limit watchdog
        on_done: Callable[[], None] = lambda: None,  # after a successful transfer: end our side of the call
        on_failed: Callable[[], None] = lambda: None,
    ) -> None:
        self.uri = tel_uri(number) if number else None
        self._number = number
        self._say_exact = say_exact
        self._do, self._say, self._wait, self._report = do_transfer, say, wait_quiet, report
        self._on_start, self._on_done, self._on_failed = on_start, on_done, on_failed
        self.active = False  # a transfer is in progress or done: the call must not be hung up by timers
        self._noted_missing = False
        self._task: asyncio.Task | None = None

    @property
    def available(self) -> bool:
        return self.uri is not None

    def request(self, via: Via) -> bool:
        """Start forwarding in the background. False if there is no human line (or one is already under way)."""
        if not self.available:
            if via == "keypad" and not self._noted_missing:
                self._noted_missing = True
                asyncio.ensure_future(self._say("Tell the caller, in their language and one short sentence, that nobody is available to take a transfer right now, then carry on helping."))
            return False
        if self.active:
            return False
        self.active = True
        self._on_start()
        self._task = asyncio.ensure_future(self._run(via))
        return True

    async def _run(self, via: Via) -> None:
        try:
            if via == "keypad":
                # the caller pressed 0 mid-conversation: announce it ourselves
                await self._say("Tell the caller, in their language and one short sentence, that you are connecting them to a person now.")
            else:
                await self._wait()  # the model announces it in its own turn, then we dial
            ok, error = await self._do(self.uri), None  # type: ignore[arg-type]
            if not ok:
                error = "transfer did not complete"
        except Exception as e:  # LiveKit/SIP errors: the caller stays on the line with the agent
            logger.exception("transfer failed")
            ok, error = False, repr(e)[:200]
        try:
            await self._report(via, ok, error)
        except Exception:
            logger.exception("could not report the transfer")
        if ok:
            logger.info("call forwarded to %s", self.uri)
            self._on_done()
            return
        self.active = False
        self._on_failed()
        await self._say("Apologise briefly in the caller's language: you could not connect them to a person; offer to keep helping with the order.")
        # The model never says a phone number: read the human line as a fixed script so the caller can ring it directly.
        spoken = spoken_number(self._number)
        if self._say_exact and spoken:
            await self._say_exact(f"You can also call the restaurant directly at {spoken}. Again: {spoken}.")
