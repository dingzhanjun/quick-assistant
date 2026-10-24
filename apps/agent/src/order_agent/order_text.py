"""Texting the customer a link to their order (after the order is placed).

Pure helpers, no network: the same number rules as the web server (`parseTextNumber` in apps/web/src/lib/order-link.ts;
the server re-checks everything) and the wording the system speaks when it reads a number back.
"""
import re

_EN = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def parse_text_number(raw: str | None) -> str | None:
    """What the caller said ("404 555 0123", "(404) 555-0123", "+44 7700 900123") -> E.164, or None if it is not a
    full number. North American numbers: 10 digits (or 11 starting with 1) with a valid area code; a leading + is
    taken as international."""
    s = (raw or "").strip()
    digits = re.sub(r"\D", "", s)
    if s.startswith("+"):
        return f"+{digits}" if re.fullmatch(r"[1-9]\d{7,14}", digits) else None
    if len(digits) == 10 and digits[0] in "23456789":
        return f"+1{digits}"
    if len(digits) == 11 and digits[0] == "1" and digits[1] in "23456789":
        return f"+{digits}"
    return None


def read_back(e164: str) -> str:
    """The sentence the SYSTEM speaks to check a number the caller gave (digit by digit, grouped like a phone number).
    The model never says the digits itself: it could drop or invent one."""
    digits = [c for c in e164 if c.isdigit()]
    if len(digits) == 11 and digits[0] == "1":  # North America: drop the country code
        digits = digits[1:]
    groups = [digits[:3], digits[3:6], digits[6:]] if len(digits) == 10 else [digits]
    spoken = ", ".join(" ".join(_EN[int(d)] for d in g) for g in groups)
    return f"I have {spoken}. Is that right?"


FINAL = "We will text you the order info shortly. Thank you for calling, goodbye!"
DECLINED = "No problem. Thank you for calling, goodbye!"
