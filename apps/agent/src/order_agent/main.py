import asyncio
import json
import logging
import os
import re
import ssl
import sys
import time
from typing import Callable

from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentSession, RunContext, function_tool
from livekit.plugins import deepgram, openai, silero, xai

import httpx

from . import api
from .call_guard import CallClock, CallInfo, Limits, cart_key, caller_said_goodbye, is_goodbye, mask_number, submit_with_retry
from .menu_search import MenuIndex, menu_categories
from .order_text import FINAL, parse_text_number, read_back
from .transfer import Transferer, spoken_number

load_dotenv("../../.env")

logger = logging.getLogger("order_agent")


def _quiet_ffi_handle_noise(unraisable) -> None:
    """After a hang-up (the room is deleted) LiveKit's native layer has already freed its handles, so the Python
    `FfiHandle.__del__` finds nothing to drop and its `assert dropped` fails. Python prints that as "Exception
    ignored in ...". It is harmless noise inside livekit-rtc; hide exactly that and show every other problem."""
    obj = repr(getattr(unraisable, "object", ""))
    if isinstance(unraisable.exc_value, AssertionError) and "FfiHandle.__del__" in obj:
        logger.debug("ignored livekit FfiHandle cleanup assertion (handle already freed)")
        return
    sys.__unraisablehook__(unraisable)


sys.unraisablehook = _quiet_ffi_handle_noise


def enable_file_logging() -> None:
    """Also write the agent's logs to AGENT_LOG_FILE (opt-in), so they can be read without the terminal.

    Idempotent and safe in every process: the worker and each call's job process import this module, and
    LiveKit may reconfigure logging, so it is called again at the start of each call.
    """
    path = os.environ.get("AGENT_LOG_FILE")
    if not path:
        return
    path = os.path.abspath(os.path.expanduser(path))
    for name in ("order_agent", "livekit.agents", "livekit.plugins"):
        lg = logging.getLogger(name)
        if any(getattr(h, "_agent_log_file", None) == path for h in lg.handlers):
            continue
        handler = logging.FileHandler(path, encoding="utf-8")
        handler._agent_log_file = path  # type: ignore[attr-defined]
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        lg.addHandler(handler)
        lg.setLevel(min(lg.level or logging.INFO, logging.INFO) if lg.level else logging.INFO)


enable_file_logging()


# Menus with more dishes than this are not pasted into the prompt in full: the model gets a list of dish
# names and must use the search_menu tool for details. Set MENU_SEARCH_THRESHOLD=0 to always search.
SEARCH_THRESHOLD = int(os.environ.get("MENU_SEARCH_THRESHOLD", "40"))


def uses_search(menu: dict) -> bool:
    return len(menu.get("items", [])) > SEARCH_THRESHOLD


def _dollars(cents: int) -> str:
    return f"${cents / 100:.2f}"


def option_codes(menu: dict) -> dict[str, dict]:
    """Short codes (o1, o2, ...) for modifier options, so the model never copies a long uuid.

    Returns {code: {"id", "name", "priceDeltaCents", "group_id", "group"}}. An option belongs to exactly
    one group, and a group can be attached to many items, so one code serves every item that has it.
    """
    codes: dict[str, dict] = {}
    seen: set[str] = set()
    for item in menu.get("items", []):
        for g in item.get("modifierGroups", []):
            for o in g["options"]:
                if o["id"] in seen:
                    continue
                seen.add(o["id"])
                codes[f"o{len(seen)}"] = {
                    "id": o["id"],
                    "name": o["name"],
                    "priceDeltaCents": o["priceDeltaCents"],
                    "group_id": g["id"],
                    "group": g["name"],
                }
    return codes


def _delta(cents: int) -> str:
    return f" ({'+' if cents > 0 else '-'}{_dollars(abs(cents))})" if cents else ""


def _menu_lines(menu: dict, code_of: dict[str, str] | None = None) -> str:
    """One readable line per item (prices in dollars), with a CHOICE line per modifier group.

    `code_of` maps option id -> code (o1, o2, ...). Search results pass the codes of the WHOLE menu so a
    code means the same thing everywhere; otherwise codes are derived from the given menu.
    """
    code_of = code_of or {c["id"]: code for code, c in option_codes(menu).items()}
    out = []
    for i in menu.get("items", []):
        line = f"- id={i['id']} | {i['name']} | {_dollars(i['priceCents'])}"
        if i.get("description"):
            line += f" | {i['description']}"
        if i.get("categories"):
            line += " | category: " + ", ".join(c["name"] for c in i["categories"])
        for g in i.get("modifierGroups", []):
            kind = "REQUIRED" if g["required"] else "optional"
            pick = "pick 1" if g["maxSelect"] == 1 else f"up to {g['maxSelect']}"
            opts = " ; ".join(
                f"{code_of[o['id']]}={o['name']}{_delta(o['priceDeltaCents'])}" for o in g["options"]
            )
            line += f"\n    CHOICE {g['name']} ({kind}, {pick}): {opts}"
        out.append(line)
    return "\n".join(out) or "(the menu is empty right now)"


def _overview(menu: dict) -> str:
    """Dish names for the big-menu prompt. With categories: one line per category (a dish appears under each of its
    categories), then the dishes in none; without any: a single list."""
    items = menu.get("items", [])
    cats = menu_categories(items)
    if not cats:
        return " | ".join(i["name"] for i in items)
    lines = []
    for c in cats:
        names = [i["name"] for i in items if any(x["name"] == c["name"] for x in i.get("categories") or [])]
        lines.append(f"{c['name']}: " + " | ".join(names))
    other = [i["name"] for i in items if not i.get("categories")]
    if other:
        lines.append("Other: " + " | ".join(other))
    return "\n".join(lines)


def _after_submit(text_orders: bool) -> tuple[str, str]:
    """(prompt lines for what happens after submit_order succeeds, note for the end_call rule).

    Without texting: say the order number and the closing line; the call then ends by itself. With texting (the platform
    has an SMS provider and the restaurant allows it): the order number is followed by ONE question, and the call only ends
    after the caller declines (end_call) or the text has been queued (text_order / confirm_text_number arm the hang-up)."""
    if not text_orders:
        return (
            '- After submit_order succeeds, say the order number and end with exactly "Have a good one!"',
            "(After submit_order succeeds the call ends by itself; do not call end_call then.)",
        )
    block = """- After submit_order succeeds, say the order number, then offer to TEXT the order details: ask the ONE question the
  tool result gives you ("Would you like us to text the order details to the number you're calling from, or
  to another number?"; if the caller's number is hidden: "Would you like us to text the order details to you? What number
  should we use?"). Do NOT say goodbye yet and do not hang up. Then:
  * The caller declines ("no", "no thanks", "that's okay"): say exactly "No problem. Thank you for calling, goodbye!" and
    call end_call in that same turn.
  * The caller accepts the number they are calling from ("yes", "this number", "that one is fine"): call text_order with
    NO number.
  * The caller gives another number: call text_order with the digits exactly as they said them. The SYSTEM then reads the
    number back and asks whether it is right: say NOTHING yourself. When they answer: yes -> call confirm_text_number;
    they correct it -> call text_order again with the corrected digits; no thanks -> say "No problem. Thank you for
    calling, goodbye!" and call end_call.
  * When a tool says the text is queued, say exactly the sentence it gives you and nothing else; the call then ends by itself.
  * NEVER say or repeat a phone number yourself; the system reads numbers aloud."""
    return block, "(After the text offer, end_call is what hangs up when the caller declines.)"


def build_instructions(menu: dict, search: bool | None = None) -> str:
    name = menu.get("name", "the restaurant")
    search = uses_search(menu) if search is None else search
    lines = _menu_lines(menu)
    if search:
        overview = _overview(menu)
        menu_block = f"""MENU OVERVIEW (dish names only, grouped by category; only these dishes exist. Use it to recognise what
the caller says and to answer "what do you have". You do NOT have prices, choices or ids yet.)
{overview}

SEARCHING THE MENU (the menu is big, so details live behind the search_menu tool)
- For EVERY dish the caller asks for, FIRST call search_menu with the dish name exactly as the caller said it
  (one dish per call). You may also search by ingredient ("something with shrimp") to help the caller choose.
- The result lists matching dishes best first, each with its id, price, description and CHOICE lines. Use
  ONLY ids and choice codes that search_menu returned; never guess or invent them.
- If one dish clearly matches, carry on with it. If several close dishes match, name the best two or three
  and ask which one the caller means. If nothing matches, say you could not find it and offer the closest
  names the tool gave you. If the caller asks what you have, answer from the overview, a few dishes at a time;
  the overview is grouped by category, so for "what drinks / appetizers do you have" name the dishes of that
  category (or call search_menu with the category name to get them with prices).
- The overview has NO ingredients, descriptions or prices. For ANY question about what a dish contains,
  ingredients, allergens, spiciness or price, and before you ever say "we don't have that" about a dish,
  ingredient or kind of food, you MUST call search_menu first. Never answer such questions from the overview
  alone: a dish whose name does not mention the ingredient may still contain it.
- Do not announce a search ("let me look that up"); just call search_menu and then speak.
- You may say a dish's price or description only after search_menu has returned it."""
    else:
        menu_block = f"""MENU (only these items exist; use the id in tool calls, never say ids aloud)
{lines}"""
    # The restaurant's phone number is never spoken by the model (it can drift or garble digits): the system reads
    # it as a fixed script right after the model's sentence (see OrderAgent._read_restaurant_number).
    address = (menu.get("address") or "").strip()
    address_line = (
        f"- THE RESTAURANT'S ADDRESS is: {address}. Say it only if the caller asks where the restaurant is or how to\n"
        "  find it; read it clearly and slowly. Never mention the address otherwise.\n"
        if address
        else "- You do not know the restaurant's address: if asked, say you do not have it and suggest they ask the\n"
        "  restaurant. Never make one up.\n"
    )
    restaurant_line = address_line + (
        "- PHONE NUMBERS: never say, guess or invent any phone number yourself. When a caller has to phone the\n"
        "  restaurant, just say they can call the restaurant directly; if the restaurant has a number on file, the\n"
        "  system reads it out to them right after you.\n"
    )
    after_submit, end_call_note = _after_submit(bool(menu.get("text_orders")))
    return f"""You answer the phone for {name} and take food orders. The caller hears you through a
text-to-speech voice, so write only plain spoken sentences.

HOW TO SPEAK
- Keep every reply to one or two short sentences. Never use lists, markdown, emoji or symbols.
- Say prices naturally ("fourteen dollars"), never "$14.00".
- Do not read out the menu unless asked. If asked what is available, name a few items and ask what they want.
- TAKING EACH ITEM (follow exactly). Every time the caller picks a dish, do these steps IN ORDER:
  A. Look at the CHOICE lines printed directly under the dish (in the menu below, or in the search_menu
     result). Those are the dish's
     ONLY choices. Never ask about a choice that is not printed under that dish: a "size" or "spice"
     question that belongs to a different dish must never be asked here, and a dish with no CHOICE
     lines has none.
     - Optional choices are NOT asked before adding (see step C). Only REQUIRED ones are asked first.
     - For each REQUIRED choice the caller has not already answered, ask ONE short, direct question that
       names the options ("Small or large?", "Not spicy, mild, medium or hot?") and wait. add_item is
       refused without a required choice. If an option costs extra, say so in the question ("Small or
       large? Large is two dollars more.").
     - A choice or option group that a dish does NOT have is never mentioned: do not ask about it, offer it,
       list it, or say the dish lacks it ("this one has no sizes", "no spice levels for this dish"). Say
       nothing about it, and move on, unless the caller themselves asks about it or asks for it (for example
       "large" when the dish has no size): then answer in a few words ("No large size for that one") and
       carry on with the choices they did give. Never hold the dish back for that, and never ask them to
       re-confirm what they already said.
     - If the caller orders several of a dish with one set of choices ("two margheritas, thin crust, extra
       cheese"), the choices apply to ALL of them. Do not ask whether they apply to both; if they want
       different choices for each, they will say so.
     - Match what the caller says to the closest listed option (for example "with cheese"
       means the Extra cheese option); do not ask again about something they already told you.
     - If the dish lists NO choices, do not invent any. Use judgment only where the dish clearly needs one
       (for example spice level or a sauce): ask one short question, and put the answer in `notes`.
  B. First say ONE short filler, then in that same turn CALL add_item. The filler, every time an item is
     confirmed: "Sure." or "OK." (vary them; never the same word twice in a row). Nothing else before the call. THE add_item CALL IS MANDATORY FOR EVERY SINGLE ITEM, NO EXCEPTIONS, even a plain item that
     needed no question, even if the caller picks several items in a row. Pass the chosen options as
     `options` using their codes (o1, o2, ...), never in `notes`; use `notes` only for requests that no
     listed choice covers (for example "no cilantro"). If the caller declines an optional choice ("no sauce"),
     record nothing for it: no option and no note. If you did not call add_item, the item is NOT in the
     order, the kitchen will never make it, and nothing is served. Saying "Sure" does not save anything.
  C. Only AFTER add_item has returned, continue WITHOUT saying Sure / OK again (you already said it in
     step B). If the tool result gives an extra charge for the caller's choices, say ONLY that extra amount,
     using the tool's numbers exactly: "Large adds two dollars." (for several of the dish: "Large adds four
     dollars for the two."); then ask "Anything else?". Do NOT say the total
     or running total; the caller hears the total once, at the final read-back. If there is no extra charge,
     do NOT mention any price. If the add_item result lists optional choices the caller has NOT been offered, then (before
     "Anything else?") offer the main one or two in ONE short yes/no question, such as "Would you like to add
     extra pork? It's two dollars more." Ask it this once only. If the caller says yes, call add_choice (it
     only adds), say only the extra amount as above (no total), then ask "Anything else?". If they
     say no or ignore it, do nothing and do not ask again. Then ask "Anything else?". Never say you are adding,
     putting in or recording an item ("let me add that", "adding it now"); the only thing you say before
     add_item is the short filler from step B. Do not repeat the whole order or the total until the final
     read-back.

{menu_block}

RULES
- If something is not on the menu, say so and suggest the closest item. Never invent items, sizes or prices.
- Put special requests that no listed choice covers (for example "no cilantro") in the item's notes. Never claim anything about how an item
  is made or served beyond its description above.
- ALLERGIES AND DIETS: only repeat what the description says. Never say a dish is free of any allergen
  (nuts, gluten, dairy, shellfish, etc.) unless the description explicitly says so. Otherwise say you
  cannot confirm it and suggest the caller ask the restaurant directly. For a serious allergy, say you
  cannot guarantee safety and suggest calling the restaurant before ordering.
- THE ORDER ONLY EXISTS IN THE TOOLS. You must call add_item for every item BEFORE you tell the caller it
  was added, and remove_item if they change their mind. Never say "got it" for an item unless the tool call
  succeeded. Your own memory of the conversation is not the order.
- PICKUP TIME (every order needs one): when the caller says they are done choosing items, BEFORE reading the
  order back, ask ONE question: "Would you like it as soon as possible, or a little later?" Then:
  * As soon as possible (ASAP, now, right away): say the filler (Sure. / OK.) and call
    set_pickup_time with "asap".
  * A specific time ("6:30", "half past six"): say the filler and call set_pickup_time with it as 24-hour
    HH:MM ("18:30"). If it is unclear whether it means morning or evening, ask once.
  * Only "a bit later" / "later" without a time: ask "What time would you like to pick it up?"
    and keep asking until you have a definite time; only then say the filler and call
    set_pickup_time. Pickup is always for today.
  * If the tool says the time has passed or the restaurant is closed then, tell the caller (and the opening
    hours it gives) and ask for another time.
  Do not ask again if the order already has a pickup time (for example when changing an earlier order) unless
  the caller wants to change it. Once the pickup time is saved, continue with the next step.
- When the caller is done and the pickup time is saved, call get_order, then read that result back ONCE (items,
  pickup time and total as returned), ask for their name if you do not have it, and wait for a clear yes before
  calling submit_order. submit_order is refused until a pickup time has been saved.
- The moment the caller confirms the order, FIRST say a very short "One moment please.", THEN call
  submit_order in that same turn, and only after it returns tell the caller the order number. Never go
  silent while saving, and never give an order number before submit_order has returned.
{after_submit}
- ENDING THE CALL: when the caller says goodbye, bye, "that's all", "no thanks", or otherwise makes clear they are
  done or do not want to order, say ONE short goodbye and call end_call in that same turn. That is what hangs up
  the phone: without it the line stays open. Never keep chatting after a goodbye, never ask another question, and
  never call end_call while the caller is still ordering or asking something. {end_call_note}
{restaurant_line}- TALKING TO A PERSON: if the caller asks for a human, a person, staff or the manager, call transfer_to_human
  right away; do not try to talk them out of it. (Pressing 0 on the keypad does the same without you.)
- CANCELLING OR CHANGING AN EARLIER ORDER: if the caller mentions an order they already placed ("my earlier
  order", "add something to my order", "change my order", "cancel my order", "order number 7"), do NOT
  call add_item and do not start a new order. Ask for the order number (if they have not said it) and call
  find_order FIRST. Never guess or invent an order number.
  Only orders that are still "new" (the kitchen has not started) can be cancelled or changed, and only when
  the caller phones from the same number they ordered with; the tool decides, so just relay what it says in
  plain words. If it refuses, do not try to work around it: suggest they call the restaurant directly.
  When find_order succeeds, say what the order contains and ask whether to cancel it or change it.
  To CANCEL: get a clear yes, then call cancel_found_order; say it is cancelled. To CHANGE: call
  change_found_order, then edit the order with add_item, remove_item and add_choice as usual, read the whole
  order back once, get a yes, and call submit_order; the old order is replaced automatically. Never say an
  order is cancelled or changed until the tool has confirmed it.
- You do not know the time or the caller's time zone. Never mention the time of day or day of week
  ("good morning", "have a good night", "enjoy your evening", "see you tomorrow", and so on).
- Only talk about ordering. If asked about something else, politely steer back to the order."""


class OrderAgent(Agent):
    def __init__(
        self,
        called_number: str,
        menu: dict,
        opening: str | None = None,
        on_order_submitted: Callable[[], None] | None = None,
        call: CallInfo | None = None,
    ) -> None:
        self.called_number = called_number
        self.on_order_submitted = on_order_submitted
        self.call = call or CallInfo(call_id="local", caller=None)
        self.menu_by_id = {i["id"]: i for i in menu.get("items", [])}
        self.index = MenuIndex(menu.get("items", []))
        self.codes = option_codes(menu)
        self._code_of = {c["id"]: code for code, c in self.codes.items()}
        self.opt_by_id = {c["id"]: c for c in self.codes.values()}
        self.items: list[dict] = []
        self.text_orders = bool(menu.get("text_orders"))  # offer to text the order link after the order is placed
        self.placed_number: int | None = None  # the order just placed on this call (what a text is about)
        self.pending_text: str | None = None  # a number the caller gave that has been read back and awaits "yes"
        self.found: dict | None = None  # an existing order the caller is cancelling/changing (see find_order)
        self.pickup: dict | None = None  # {'type': 'asap'} or {'type': 'time', 'time': 'HH:MM'}; required before submit
        self.replacing: int | None = None  # its number, once the caller chose to change it
        self.lookup_failures = 0
        self.human_line: str | None = menu.get("transfer_number")
        self._opening = opening
        self._greeting = greeting(menu.get("name", "our restaurant"))
        super().__init__(instructions=build_instructions(menu))

    async def on_enter(self) -> None:
        if self._opening:  # a speech-to-speech model cannot read a script aloud: instruct it instead
            await self.session.generate_reply(instructions=self._opening)
        else:
            await self.session.say(self._greeting)  # scripted, not generated: fast and always the exact wording

    def _line_unit_cents(self, line: dict) -> int:
        base = self.menu_by_id[line["item_id"]]["priceCents"]
        return base + sum(self.opt_by_id[o]["priceDeltaCents"] for o in line["option_ids"])

    def _summary(self, with_total: bool = True) -> str:
        if not self.items:
            return "The order is empty."
        # The total is computed here so the model never does the arithmetic.
        total = sum(self._line_unit_cents(i) * i["quantity"] for i in self.items)

        def describe(i: dict) -> str:
            extras = [self.opt_by_id[o]["name"] for o in i["option_ids"]]
            if i.get("notes"):
                extras.append(i["notes"])
            return f"{i['quantity']} x {self.menu_by_id[i['item_id']]['name']}" + (
                f" ({', '.join(extras)})" if extras else ""
            )

        lines = f"Current order: {', '.join(describe(i) for i in self.items)}. Pickup: {self._pickup_text()}."
        # Add/remove results leave the total out so the model is not tempted to repeat it mid-order;
        # only get_order (the final read-back) states it.
        return f"{lines} Total: {_dollars(total)}." if with_total else lines

    def _check_choices(self, item: dict, codes: list[str]) -> tuple[list[str], str | None]:
        """Validate the caller's picks against the item's modifier groups. Returns (option ids, error)."""
        groups = item.get("modifierGroups", [])
        by_code = {
            code: (g, o)
            for g in groups
            for o in g["options"]
            for code, c in self.codes.items()
            if c["id"] == o["id"]
        }
        picked: dict[str, list[str]] = {}
        for code in codes:
            if code not in by_code:
                valid = "; ".join(
                    f"{g['name']}: " + ", ".join(f"{c}={o['name']}" for c, (gg, o) in by_code.items() if gg is g)
                    for g in groups
                ) or "this item has no choices"
                return [], f'"{code}" is not a choice for {item["name"]}. Valid choices: {valid}.'
            picked.setdefault(by_code[code][0]["id"], []).append(by_code[code][1]["id"])
        for g in groups:
            chosen = picked.get(g["id"], [])
            names = ", ".join(
                f"{c}={o['name']}" for c, (gg, o) in by_code.items() if gg is g
            )
            if g["required"] and not chosen:
                return [], (
                    f'Cannot add {item["name"]} yet: the caller must choose "{g["name"]}" ({names}). '
                    "Ask them this one question, then call add_item again with their choice."
                )
            if len(chosen) > g["maxSelect"]:
                return [], f'"{g["name"]}" allows at most {g["maxSelect"]} choice(s).'
        return [o for ids in picked.values() for o in ids], None

    @function_tool
    async def search_menu(self, ctx: RunContext, query: str) -> str:
        """Find dishes on the menu by name or by ingredient.

        Pass the dish name exactly as the caller said it, a word like "shrimp" to
        browse, or a category name from the overview ("drinks") to list that category's dishes. One dish per call. Returns matching dishes best first, with id, price, description and
        CHOICE lines. Call this before add_item whenever the menu overview does not already show the dish's id.
        """
        hits = self.index.search(query, limit=5)
        # "drinks": the caller names a whole category (unless a dish is named exactly that): list its dishes.
        cat = self.index.match_category(query)
        if cat and not (hits and hits[0][0] >= 100):
            members = self.index.items_in(cat)
            shown = _menu_lines({"items": members[:12]}, self._code_of)
            more = f"\n(and {len(members) - 12} more: ask the caller what kind they want)" if len(members) > 12 else ""
            return (
                f'Category "{cat["name"]}" has {len(members)} dish(es):\n{shown}{more}\n'
                "Offer a few of them by name, a few at a time, and let the caller choose; use the ids above."
            )
        if not hits:
            near = self.index.search(query, limit=3, min_score=30)
            closest = f" Closest names: {', '.join(i['name'] for _, i in near)}." if near else ""
            return (
                f'No dish matches "{query}".{closest} Tell the caller you could not find that dish and '
                "offer the closest names, or ask them to say it another way."
            )
        lines = _menu_lines({"items": [i for _, i in hits]}, self._code_of)
        top, second = hits[0][0], hits[1][0] if len(hits) > 1 else 0
        if len(hits) == 1 or (top >= 70 and top - second >= 8):
            note = "The first dish is a clear match: use it unless the caller says otherwise."
        else:
            note = (
                "Several dishes are close: ask the caller which one they mean "
                "(name the best two or three), then use that dish's id."
            )
        return f'Matches for "{query}", best first:\n{lines}\n{note}'

    @function_tool
    async def add_item(
        self,
        ctx: RunContext,
        item_id: str,
        quantity: int,
        options: list[str] | None = None,
        notes: str = "",
    ) -> str:
        """Add a menu item to the current order.

        `options` = the codes (like o1, o2) of the CHOICES the caller picked for this dish.
        `notes` = only requests that no listed choice covers.
        """
        item = self.menu_by_id.get(item_id)
        if item is None:
            return "That item is not on the menu. Use an id from the menu."
        if quantity < 1:
            return "Quantity must be at least 1."
        # Some models pass the string "null"/"none" for an empty note.
        notes = (notes or "").strip()
        if notes.lower() in ("null", "none", "n/a"):
            notes = ""
        option_ids, error = self._check_choices(item, list(dict.fromkeys(options or [])))
        if error:
            return error
        # Same item with the same choices and notes is one line, however the model split the quantity.
        key = sorted(option_ids)
        for line in self.items:
            if line["item_id"] == item_id and line["notes"] == notes and sorted(line["option_ids"]) == key:
                line["quantity"] += quantity
                break
        else:
            self.items.append(
                {"item_id": item_id, "quantity": quantity, "notes": notes, "option_ids": option_ids}
            )
        return "Added. " + self._surcharge_text(option_ids, quantity) + self._summary(with_total=False) + self._unoffered(item, option_ids)

    def _surcharge_text(self, option_ids: list[str], quantity: int) -> str:
        """Spells out what the given choices add to the price, for the agent to say aloud."""
        surcharge = sum(self.opt_by_id[o]["priceDeltaCents"] for o in option_ids)
        if not surcharge:
            return ""
        names = ", ".join(
            f"{self.opt_by_id[o]['name']}{_delta(self.opt_by_id[o]['priceDeltaCents'])}"
            for o in option_ids
            if self.opt_by_id[o]["priceDeltaCents"]
        )
        more = "more" if surcharge > 0 else "less"
        each = f"{_dollars(abs(surcharge))} {more} per item"
        total_extra = f", {_dollars(abs(surcharge) * quantity)} {more} for {quantity}" if quantity > 1 else ""
        return f"The choices ({names}) cost {each}{total_extra}. Tell the caller only this extra amount; do NOT say the total. "

    def _unoffered(self, item: dict, option_ids: list[str]) -> str:
        """Hint listing the optional choices the caller did not mention, so the agent can offer them once."""
        chosen = set(option_ids)
        lines = []
        for g in item.get("modifierGroups", []):
            if g["required"] or any(o["id"] in chosen for o in g["options"]):
                continue
            code_of = self._code_of
            opts = " ; ".join(f"{code_of[o['id']]}={o['name']}{_delta(o['priceDeltaCents'])}" for o in g["options"])
            lines.append(f"{g['name']} (up to {g['maxSelect']}): {opts}")
        if not lines:
            return ""
        return (
            " | Optional choices the caller has NOT been offered yet: " + " // ".join(lines)
            + ". Right after your acknowledgement, offer the main one or two in ONE short question (mention any "
            "extra price). If they say yes, call add_choice; if they decline or ignore it, do nothing."
        )

    @function_tool
    async def add_choice(self, ctx: RunContext, item_id: str, options: list[str]) -> str:
        """Add more choices (codes like o4) to a dish that is ALREADY in the order, for example after the caller
        says yes to an optional extra. Only adds; it never removes. Applies to the most recent line of that dish."""
        line = next((l for l in reversed(self.items) if l["item_id"] == item_id), None)
        if line is None:
            return "That dish is not in the order yet. Use add_item."
        item = self.menu_by_id[item_id]
        wanted = list(dict.fromkeys(options or []))
        before = set(line["option_ids"])
        new_ids, error = self._check_choices(item, [c for c, o in self.codes.items() if o["id"] in before] + wanted)
        if error:
            return error
        added = [o for o in new_ids if o not in before]
        if not added:
            return "Those choices were already in the order. " + self._summary(with_total=False)
        line["option_ids"] = new_ids
        # fold into an identical line if one now exists
        key = sorted(new_ids)
        for other in self.items:
            if other is not line and other["item_id"] == item_id and other["notes"] == line["notes"] and sorted(other["option_ids"]) == key:
                other["quantity"] += line["quantity"]
                self.items.remove(line)
                break
        return "Added. " + self._surcharge_text(added, line["quantity"]) + self._summary(with_total=False)

    @function_tool
    async def get_order(self, ctx: RunContext) -> str:
        """Return the current order and total. Call this before reading the order back to the caller."""
        return self._summary()

    @function_tool
    async def remove_item(self, ctx: RunContext, item_id: str) -> str:
        """Remove every line of this menu item from the current order."""
        self.items = [i for i in self.items if i["item_id"] != item_id]
        return self._summary(with_total=False)

    @function_tool
    async def end_call(self, ctx: RunContext) -> str:
        """Hang up the phone. Call this when the conversation is over: the caller said goodbye / bye / that is all /
        no thanks, or clearly does not want to order. Say your short goodbye in the same turn."""
        transfer = self.call.transfer
        if transfer is not None and getattr(transfer, "active", False):
            return "The caller is being transferred to a person. Say nothing more."
        if self.on_order_submitted:
            self.on_order_submitted()  # arms the hang-up: the line drops once your goodbye has been spoken
        return "The call is ending. Say ONE very short goodbye sentence now (no question). Do not say anything else."

    @function_tool
    async def transfer_to_human(self, ctx: RunContext) -> str:
        """Forward the caller to a person. Use it when they ask for a human, a person, staff, the manager, an
        operator or a representative (in any language), or say they want to speak to someone."""
        transfer = self.call.transfer
        if transfer is None or not transfer.request("request"):
            if transfer is not None and transfer.active:
                return "A transfer is already under way. Say nothing more."
            return (
                "There is no human line to forward to. Tell the caller politely that nobody can take a transfer right "
                "now and offer to keep helping, or suggest phoning the restaurant directly."
            )
        # The call is dialled once you have finished speaking.
        return "Transferring. Say ONE short sentence that you are connecting them to a person now, then stop."

    # ---- cancelling / changing an earlier order -------------------------------------------------------

    def _read_restaurant_number(self) -> str:
        """Queue the restaurant's number as scripted speech (exact digits, said twice) and tell the model not to say
        any number itself. Not awaited: a tool cannot wait for speech that is queued behind its own turn."""
        number = spoken_number(self.human_line)
        if not number:
            return ""
        self.session.say(f"The restaurant's number is {number}. Again: {number}.")
        return " The restaurant's phone number is read to the caller by the system right after you: do NOT say any number yourself."

    def _pickup_text(self) -> str:
        if not self.pickup:
            return "not asked yet"
        if self.pickup["type"] == "asap":
            return "as soon as possible"
        h, m = (int(x) for x in self.pickup["time"].split(":"))
        return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}" if m else f"{h % 12 or 12} {'AM' if h < 12 else 'PM'}"

    @function_tool
    async def set_pickup_time(self, ctx: RunContext, when: str) -> str:
        """Save when the caller will pick the order up. `when` is "asap" or a time today as 24-hour HH:MM
        (for example "18:30" for 6:30 pm). Call it only once the caller has given a definite answer."""
        w = (when or "").strip().lower()
        if w in ("asap", "now", "as soon as possible"):
            self.pickup = {"type": "asap"}
        elif re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", w):
            self.pickup = {"type": "time", "time": w}
        else:
            return 'Invalid time. Pass "asap" or 24-hour HH:MM such as "18:30". If you are not sure what the caller means, ask them.'
        return f"Pickup time saved: {self._pickup_text()}. Now read the order back (get_order)."

    def _describe_found(self, order: dict) -> str:
        parts = []
        for line in order["items"]:
            item = self.menu_by_id.get(line["item_id"]) if line.get("item_id") else None
            name = item["name"] if item else line["name"]
            opts = ", ".join(line.get("options") or [])
            parts.append(f"{line['quantity']} x {name}" + (f" ({opts})" if opts else ""))
        return f"Order {order['order_number']}: {', '.join(parts)}. Total {_dollars(order['total_cents'])}."

    @function_tool
    async def find_order(self, ctx: RunContext, order_number: int) -> str:
        """Look up an earlier order by the number the caller gives, to cancel or change it."""
        if self.lookup_failures >= 3:
            return (
                "Too many attempts. Do not look up more orders; tell the caller to phone the restaurant directly."
                + self._read_restaurant_number()
            )
        try:
            res = await api.lookup_order(self.called_number, order_number, self.call.caller)
        except Exception:
            logger.exception("order lookup failed")
            return "The order system is not answering. Apologise and suggest the caller phones the restaurant directly."
        if not res.get("allowed"):
            self.found = None
            reason = res.get("reason")
            if reason == "no_caller":
                self.lookup_failures += 1
                return (
                    "The caller's phone number is hidden, so orders cannot be changed by phone. Say so politely "
                    "and suggest they phone the restaurant directly." + self._read_restaurant_number()
                )
            if reason == "not_new":
                return (
                    "The kitchen has already started that order, so it cannot be cancelled or changed by phone. "
                    "Say so and suggest they phone the restaurant directly." + self._read_restaurant_number()
                )
            self.lookup_failures += 1
            return (
                "No order with that number was placed from this phone number. Ask them to check the number once; "
                "say that orders can only be changed from the phone they ordered with. Do not reveal anything else."
            )
        self.found = res["order"]
        return self._describe_found(self.found) + " Tell the caller this and ask whether they want to cancel it or change it."

    @function_tool
    async def cancel_found_order(self, ctx: RunContext) -> str:
        """Cancel the order found with find_order. Only after the caller clearly said yes to cancelling."""
        if not self.found:
            return "No order has been looked up. Call find_order first."
        number = self.found["order_number"]
        try:
            res = await api.cancel_order(self.called_number, number, self.call.caller)
        except Exception:
            logger.exception("order cancel failed")
            return "The order system is not answering. Apologise; the order is NOT cancelled. Suggest phoning the restaurant."
        if not res.get("cancelled"):
            self.found = None
            return (
                "The order could NOT be cancelled (the kitchen may have just started it). Say so and suggest the "
                "caller phones the restaurant directly." + self._read_restaurant_number()
            )
        self.found = None
        logger.info("order %s cancelled by the caller", number)
        return f"Order {number} is cancelled and the restaurant has been told. Say so, then ask if they want to place a new order."

    @function_tool
    async def change_found_order(self, ctx: RunContext) -> str:
        """Start changing the order found with find_order: its items are loaded into the current order."""
        order = self.found
        if not order:
            return "No order has been looked up. Call find_order first."
        lines = []
        for line in order["items"]:
            ok = line.get("item_id") in self.menu_by_id and all(o in self.opt_by_id for o in line.get("option_ids", []))
            if not (order.get("can_change") and ok):
                return (
                    "This order cannot be edited by phone (a dish or choice is no longer on the menu). Offer to cancel it "
                    "and take a fresh order instead, or suggest phoning the restaurant."
                )
            lines.append(
                {"item_id": line["item_id"], "quantity": line["quantity"], "notes": line.get("notes") or "",
                 "option_ids": list(line.get("option_ids", []))}
            )
        self.items = lines
        self.replacing = order["order_number"]
        old_pickup = order.get("pickup")
        if old_pickup == "asap":
            self.pickup = {"type": "asap"}
        elif isinstance(old_pickup, str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", old_pickup):
            self.pickup = {"type": "time", "time": old_pickup}
        return (
            "The old order is loaded into the current order. " + self._summary(with_total=False)
            + " Ask what they want to change, edit with add_item / remove_item / add_choice, then read the whole order "
            "back, get a yes and call submit_order. The old order is only cancelled when the new one is saved."
        )

    @function_tool
    async def submit_order(self, ctx: RunContext, customer_name: str) -> str:
        """Submit the order after the customer has confirmed the read-back."""
        if not self.items:
            return "The order is empty; add items before submitting."
        if self.pickup is None:
            return "The pickup time has not been saved. Ask the caller (as soon as possible, or a little later?) and call set_pickup_time first."
        payload = [
            {"item_id": i["item_id"], "quantity": i["quantity"], "notes": i["notes"], "option_ids": i["option_ids"]}
            for i in self.items
        ]
        key = cart_key(self.call.call_id, payload, extra=json.dumps(self.pickup, sort_keys=True))
        body = {"customer_name": customer_name, "items": payload, "idempotency_key": key, "pickup": self.pickup}
        if self.replacing:
            body["replaces_order_number"] = self.replacing
        if self.call.caller:
            body["caller"] = self.call.caller
        result = await submit_with_retry(
            lambda: api.submit_order(self.called_number, body),
            describe=f"call={self.call.call_id} caller={self.call.caller} name={customer_name!r} cart={payload}",
            sleep=asyncio.sleep,
        )
        if result.status == "rejected" and self.replacing and "cannot_replace" in result.message:
            old, self.replacing, self.found = self.replacing, None, None
            logger.warning("order %s can no longer be replaced", old)
            return (
                f"The old order {old} could not be changed any more (the kitchen may have started it), so the NEW order "
                "has NOT been saved and the old one stands. Tell the caller. If they still want the new items, ask "
                "whether to place them as a separate new order, and only then call submit_order again."
            )
        if result.status == "rejected" and "pickup_in_past" in result.message:
            self.pickup = None
            return "That pickup time has already passed. Tell the caller and ask for a later time, then call set_pickup_time again."
        if result.status == "rejected" and "pickup_closed" in result.message:
            self.pickup = None
            hours = re.search(r'"hours":"([^"]*)"', result.message)
            return (
                "The restaurant is not open at that time"
                + (f" (opening hours: {hours.group(1)})" if hours else "")
                + ". Tell the caller and ask for another pickup time, then call set_pickup_time again."
            )
        if result.status == "rejected":
            logger.warning("order rejected by the server: %s", result.message)
            return (
                "The restaurant's system refused this order: "
                f"{result.message} Tell the caller what is wrong in plain words and fix the order with them."
            )
        if result.status == "failed":
            # D4: apologise, promise a callback on the number they are calling from, then end the call.
            if self.on_order_submitted:
                self.on_order_submitted()
            return (
                "The order could NOT be saved because of a technical problem. Do not give an order number. "
                "Apologise briefly, say the restaurant has been alerted and will call back on the number "
                "they are calling from, then say goodbye."
            )
        self.items = []  # a second order on the same call starts fresh
        replaced, self.replacing, self.found = self.replacing, None, None
        self.placed_number, self.pending_text = result.order_number, None
        done = (
            f"Order changed: the old order {replaced} is cancelled and the new order number is {result.order_number}"
            if replaced
            else f"Order submitted, number {result.order_number}"
        )
        if not self.text_orders:
            if self.on_order_submitted:
                self.on_order_submitted()  # the call ends once the agent has said goodbye
            return done
        # Texting is on: say the number, then ask whether to text the details. The call must NOT end yet.
        if self.call.caller:
            ask = ("Now ask the caller ONE question: would they like us to text the order details to the number they are "
                   "calling from, or to another number?")
        else:
            ask = ("The caller's number is hidden. Now ask the caller ONE question: would they like us to text the order "
                   "details to them, and what number should we use?")
        return f"{done}. Say the order number, then {ask} Do not say goodbye yet."

    # ---- texting the order link -----------------------------------------------------------------------

    def _arm(self) -> None:
        if self.on_order_submitted:
            self.on_order_submitted()  # the line drops once the agent has finished speaking

    async def _send_text(self, e164: str) -> str:
        """Ask the server to text the order link to this number; the server re-validates and applies its limits."""
        self.pending_text = None
        try:
            res = await api.request_order_text(self.called_number, self.placed_number or 0, e164)
        except Exception:
            logger.exception("order text request failed")
            self._arm()
            return (
                "The text could not be sent because of a technical problem, but the order IS placed. Say sorry briefly: "
                '"Sorry, we could not send the text, but your order is in. Thank you for calling, goodbye!" and nothing '
                "else."
            )
        if res.get("ok"):
            logger.info("order #%s: text queued for %s", self.placed_number, mask_number(e164))
            self._arm()
            return f'The text is queued. Say exactly: "{FINAL}" and nothing else.'
        reason = res.get("reason")
        if reason == "bad_number":
            return ("That is not a full phone number (it needs the area code, ten digits). Ask the caller to say the number "
                    "again, digit by digit.")
        self._arm()
        return (
            f"Texting is not possible now ({reason}), but the order IS placed. Say sorry briefly: "
            '"Sorry, we cannot send a text right now, but your order is in. Thank you for calling, goodbye!" and nothing '
            "else."
        )

    @function_tool
    async def text_order(self, ctx: RunContext, number: str = "") -> str:
        """Text the caller the link to the order they just placed. Call it only AFTER you offered to text the order and
        the caller said yes. Leave `number` EMPTY when they want the number they are calling from. If they gave another
        number, pass the digits exactly as they said them (for example "404 555 0123"); the system will read it back and
        you must wait for the caller's yes before calling confirm_text_number."""
        if self.placed_number is None or not self.text_orders:
            return "There is no order to text yet. Do not call this tool."
        number = (number or "").strip()
        if not number:
            if not self.call.caller:
                return "The caller's own number is hidden. Ask them which number we should text, then call this tool with it."
            e164 = parse_text_number(self.call.caller)
            if e164 is None:
                return "The caller's own number cannot be texted. Ask them which number we should text, then call this tool with it."
            return await self._send_text(e164)
        e164 = parse_text_number(number)
        if e164 is None:
            return ("That is not a full phone number (it needs the area code, ten digits). Ask the caller to say the number "
                    "again, digit by digit.")
        if self.call.caller and parse_text_number(self.call.caller) == e164:
            return await self._send_text(e164)  # they read out the number they are calling from: nothing to double-check
        self.pending_text = e164
        # The SYSTEM reads the number back (the model could garble a digit). Not awaited: it is spoken after this turn.
        try:
            self.session.say(read_back(e164))
        except Exception:  # no speech output (text-only runs, a broken TTS): the model must do it
            logger.warning("could not speak the read-back; asking the model to read the number back")
            return (
                "The system could not read the number back. Read it back to the caller yourself, digit by digit, and ask "
                "whether it is right. When they say yes call confirm_text_number; if they correct it, call text_order again."
            )
        return (
            "The system is now reading the number back to the caller and asking whether it is right. Say NOTHING and do not "
            "repeat the number. When the caller answers: yes -> call confirm_text_number; they correct it -> call text_order "
            "again with the corrected digits; they changed their mind -> say a short goodbye and call end_call."
        )

    @function_tool
    async def confirm_text_number(self, ctx: RunContext) -> str:
        """The caller confirmed the number the system read back ("yes", "that's right"). Sends the text."""
        if self.pending_text is None:
            return "There is no number waiting for confirmation. Ask which number to text, then call text_order."
        return await self._send_text(self.pending_text)


AI_DISCLOSURE = "This is an automated ordering assistant."


def greeting(name: str) -> str:
    """Scripted opening: names the restaurant, discloses that the caller is talking to an AI (D1), asks for the order."""
    return f"Thanks for calling {name}. {AI_DISCLOSURE} What would you like to order?"


async def build_llm():
    """Build the LLM the platform admin selected; fall back to OpenAI if config is unreachable."""
    try:
        cfg = (await api.get_config())["llm"]
    except Exception:
        cfg = {"provider": "openai", "model": "gpt-4o-mini"}
    if cfg["provider"] == "deepseek":
        return openai.LLM.with_deepseek(model=cfg["model"])  # needs DEEPSEEK_API_KEY
    return openai.LLM(model=cfg["model"])  # needs OPENAI_API_KEY


_hung_up: set[str] = set()  # rooms already being hung up (several timers may fire)


async def hang_up(ctx: agents.JobContext) -> None:
    """End the call: delete the LiveKit room, which disconnects the SIP caller (an agent that merely leaves
    keeps the phone line open). Uses certifi's CA bundle because some Python installs (python.org builds on
    macOS) cannot verify TLS certificates for the REST API; falls back to ending only the agent's job."""
    room = ctx.room.name
    if room in _hung_up:
        return
    _hung_up.add(room)
    logger.info("hanging up (room=%s)", room)
    # console mode runs a fake job in a fake room: there is nothing on the LiveKit server to delete
    is_fake = ctx.is_fake_job() if hasattr(ctx, "is_fake_job") else room in ("console", "console-room")
    if not is_fake and os.environ.get("LIVEKIT_API_KEY"):
        import aiohttp
        import certifi
        from livekit import api

        session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(ssl=ssl.create_default_context(cafile=certifi.where()))
        )
        lk = api.LiveKitAPI(
            url=os.environ["LIVEKIT_URL"].replace("wss://", "https://").replace("ws://", "http://"),
            api_key=os.environ["LIVEKIT_API_KEY"],
            api_secret=os.environ["LIVEKIT_API_SECRET"],
            session=session,
        )
        try:
            await lk.room.delete_room(api.DeleteRoomRequest(room=room))
            logger.info("hung up: deleted room %s", room)
        except Exception:
            logger.exception("could not delete room %s; ending the agent's job instead", room)
        finally:
            await lk.aclose()
            await session.close()
    ctx.shutdown(reason="order complete")
    logger.info("call ended")


def end_call_after_goodbye(ctx: agents.JobContext, session: AgentSession) -> Callable[[], None]:
    """Returns arm(). Once armed (after submit_order succeeds), hang up when the agent has finished speaking.

    The state sequence on submit is: speaking ("one moment please") -> thinking (tool) -> speaking (order number
    and goodbye) -> listening, so the first return to `listening` after arming is the end of the goodbye. A short
    grace period cancels the hang-up if the agent starts speaking again, and a long timeout is a safety net.
    """
    armed = False
    pending: asyncio.Task | None = None
    ended = False

    async def finish(delay: float) -> None:
        nonlocal ended
        await asyncio.sleep(delay)
        if ended:
            return
        ended = True
        await hang_up(ctx)

    def cancel_pending() -> None:
        nonlocal pending
        if pending and not pending.done():
            pending.cancel()
        pending = None

    @session.on("agent_state_changed")
    def on_state(ev) -> None:
        nonlocal pending
        logger.info("agent state: %s -> %s%s", ev.old_state, ev.new_state, " (armed)" if armed else "")
        if not armed:
            return
        cancel_pending()
        if ev.new_state == "listening":
            pending = asyncio.create_task(finish(1.0))  # a beat of silence after the goodbye
        elif ev.new_state == "speaking":
            # Backup if the end of playback is never reported (some realtime models, text-only runs): a goodbye
            # is a few seconds, so after 20s of continuous speaking just end the call.
            pending = asyncio.create_task(finish(20.0))

    def arm() -> None:
        nonlocal armed, pending
        if armed:
            return
        armed = True
        logger.info("call is finishing (order placed or caller said goodbye); will hang up after the goodbye")
        asyncio.create_task(finish(45.0))  # safety net if no goodbye ever arrives
        # Armed after the goodbye was already spoken (see on_item): no further state change will come, so schedule now.
        if getattr(session, "agent_state", None) == "listening":
            pending = asyncio.create_task(finish(1.0))

    @session.on("conversation_item_added")
    def on_item(ev) -> None:
        """Safety net: if the agent SAYS goodbye, hang up even when the model forgot to call end_call. (The model
        reliably says goodbye but often does not call the tool.)"""
        item = ev.item
        if getattr(item, "type", "") != "message":
            return
        text = getattr(item, "text_content", None)
        role = getattr(item, "role", "")
        if role == "assistant" and is_goodbye(text):
            logger.info("agent said goodbye (%r): hanging up", (text or "")[:60])
            arm()
        elif role == "user" and caller_said_goodbye(text):
            # Whatever else is going on, the caller saying bye ends the call. If the agent is already
            # replying (usually with its own goodbye), the hang-up waits until it has finished speaking.
            logger.info("caller said goodbye (%r): hanging up", (text or "")[:60])
            arm()

    return arm


async def watch_call(ctx: agents.JobContext, session: AgentSession, limits: Limits, call: CallInfo | None = None) -> None:
    """Enforce the call limits (LAUNCH_PLAN D2): a maximum duration and hang-up after prolonged silence.
    Runs for the life of the call; `hang_up` is idempotent so it can race with the post-order goodbye."""
    loop = asyncio.get_running_loop()
    clock = CallClock(limits, loop.time())
    agent_busy = False
    user_busy = False

    def refresh() -> None:
        (clock.busy if agent_busy or user_busy else clock.quiet)(loop.time())

    @session.on("agent_state_changed")
    def on_agent(ev) -> None:
        nonlocal agent_busy
        agent_busy = ev.new_state in ("speaking", "thinking")
        refresh()

    @session.on("user_state_changed")
    def on_user(ev) -> None:
        nonlocal user_busy
        user_busy = ev.new_state == "speaking"
        refresh()

    async def say(instructions: str) -> None:
        try:
            handle = session.generate_reply(instructions=instructions)
            await asyncio.wait_for(handle, timeout=15)
        except Exception:
            logger.exception("could not speak during call watchdog")

    while True:
        await asyncio.sleep(1.0)
        if call is not None and getattr(call.transfer, "active", False):
            continue  # being forwarded to a person: no time-limit or silence hang-up
        action = clock.check(loop.time())
        if action == "none":
            continue
        logger.info("call watchdog: %s", action)
        if action == "warn_time":
            await say("Tell the caller, in one short sentence, that the call can only last about one more minute.")
        elif action == "ask_still_there":
            await say("Ask the caller, in one short sentence, if they are still there.")
        else:
            why = "no answer for a while" if action == "hangup_idle" else "the maximum call length was reached"
            await say(
                f"Say a brief goodbye ({why}). If an order was not placed yet, "
                "say they are welcome to call again."
            )
            await hang_up(ctx)
            return


def build_transferer(
    ctx: agents.JobContext, session: AgentSession, participant, called: str, call: CallInfo, number: str | None
) -> Transferer:
    """Real collaborators for Transferer: LiveKit SIP transfer (REFER) to the restaurant's human line."""

    async def do_transfer(uri: str) -> bool:
        room = ctx.room.name
        is_fake = ctx.is_fake_job() if hasattr(ctx, "is_fake_job") else room in ("console", "console-room")
        if is_fake or not os.environ.get("LIVEKIT_API_KEY"):
            logger.warning("transfer to %s skipped: no real SIP call (console mode)", uri)
            return False
        import aiohttp
        import certifi
        from livekit import api as lkapi
        from livekit.protocol.sip import SIPTransferStatus

        http = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(ssl=ssl.create_default_context(cafile=certifi.where()))
        )
        lk = lkapi.LiveKitAPI(
            url=os.environ["LIVEKIT_URL"].replace("wss://", "https://").replace("ws://", "http://"),
            api_key=os.environ["LIVEKIT_API_KEY"],
            api_secret=os.environ["LIVEKIT_API_SECRET"],
            session=http,
        )
        try:
            res = await lk.sip.transfer_sip_participant(
                lkapi.TransferSIPParticipantRequest(room_name=room, participant_identity=participant.identity, transfer_to=uri)
            )
            logger.info("transfer result: status=%s", res.status)
            return res.status == SIPTransferStatus.STS_TRANSFER_SUCCESSFUL
        finally:
            await lk.aclose()
            await http.close()

    async def say(instructions: str) -> None:
        try:
            await asyncio.wait_for(session.generate_reply(instructions=instructions), timeout=15)
        except Exception:
            logger.exception("could not speak during transfer")

    async def say_exact(text: str) -> None:
        """Scripted sentence, spoken exactly (no model rewriting; used for phone numbers)."""
        try:
            await asyncio.wait_for(session.say(text), timeout=20)
        except Exception:
            logger.exception("could not speak the scripted sentence")

    async def wait_quiet() -> None:
        """Wait until the agent has said its sentence: it starts speaking, then returns to listening."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 15
        spoke = False
        quiet_since: float | None = None
        while loop.time() < deadline:
            state = session.agent_state
            if state == "speaking":
                spoke, quiet_since = True, None
            elif state == "listening" and (spoke or loop.time() > deadline - 13.5):
                quiet_since = quiet_since or loop.time()
                if loop.time() - quiet_since >= 0.8:
                    return
            else:
                quiet_since = None
            await asyncio.sleep(0.2)

    async def report(via: str, ok: bool, error: str | None) -> None:
        await api.report_transfer(called, call.call_id, via, ok, error)

    def done() -> None:
        ctx.shutdown(reason="transferred to a person")  # the caller now talks to the human line

    return Transferer(
        number, do_transfer=do_transfer, say=say, say_exact=say_exact, wait_quiet=wait_quiet, report=report, on_done=done
    )


def system_down_message(human_line: str | None = None) -> str:
    """What a caller hears when the model is down. With the restaurant's human line set, it is read out twice."""
    base = "Sorry, we cannot take your order right now because of a system problem. "
    number = spoken_number(human_line)
    if not number:
        return base + "Please call back a little later, or call the restaurant directly. Goodbye."
    return (
        base + f"Please call the restaurant directly at {number}. That number again: {number}. Goodbye."
    )


SYSTEM_DOWN_MESSAGE = system_down_message()  # without a number
_grok_check: tuple[float, bool, str] | None = None  # (when, usable, why): cached briefly so every call is not delayed


async def grok_available() -> tuple[bool, str]:
    """Is the xAI account usable right now? Uses xAI's key-info endpoint (no model call, no cost): a team that ran out
    of credit or hit its spending limit shows `team_blocked`. A slow or failing CHECK never blocks calls (returns
    usable); only a clear 'blocked'/'invalid key' answer does. Result is cached for 30 seconds."""
    global _grok_check
    now = time.monotonic()
    if _grok_check and now - _grok_check[0] < 30:
        return _grok_check[1], _grok_check[2]
    key = os.environ.get("XAI_API_KEY")
    usable, why = True, "ok"
    if not key:
        usable, why = False, "XAI_API_KEY is not set"
    else:
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                r = await c.get("https://api.x.ai/v1/api-key", headers={"Authorization": f"Bearer {key}"})
            if r.status_code in (401, 403):
                usable, why = False, f"HTTP {r.status_code} {r.text[:160]}"
            elif r.status_code == 200:
                info = r.json()
                if info.get("team_blocked") or info.get("api_key_blocked") or info.get("api_key_disabled"):
                    usable, why = False, "team or key blocked (out of credit or spending limit reached)"
        except Exception as e:  # network trouble on the check itself: try the call anyway
            logger.warning("xAI availability check failed (%r); assuming it is available", e)
    _grok_check = (now, usable, why)
    return usable, why


async def speak_and_hang_up(ctx: agents.JobContext, text: str) -> None:
    """Say one scripted sentence with Deepgram TTS only (cheap and independent of the model that may be broken),
    wait for it to finish, then hang up. Used for refusals, closed hours and system problems."""
    try:
        session = AgentSession(tts=deepgram.TTS())
        await session.start(room=ctx.room, agent=Agent(instructions="You cannot take orders."))
        await asyncio.wait_for(session.say(text), timeout=20)  # let the sentence finish before the line drops
    except Exception:
        logger.exception("could not speak the message %r", text)
    await hang_up(ctx)


async def entrypoint(ctx: agents.JobContext) -> None:
    enable_file_logging()
    logger.info("call started: room=%s", ctx.room.name)
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    # SIP attributes carry the dialed number; used to resolve the tenant.
    # Copy to a plain dict: console mode hands us a stand-in participant whose .get() returns a truthy
    # placeholder object, which would defeat the fallback below. Logged so the first real call shows
    # which attribute actually carries the dialed number.
    attrs = dict(participant.attributes)
    logger.info(
        "participant attributes: %s",
        {k: (mask_number(v) if k == "sip.phoneNumber" and isinstance(v, str) else v) for k, v in attrs.items()},
    )
    sip_number = attrs.get("sip.trunkPhoneNumber")
    # DEV_CALLED_NUMBER lets console mode (no SIP call) pretend a restaurant was dialed.
    called = (
        sip_number
        if isinstance(sip_number, str) and sip_number
        else os.environ.get("DEV_CALLED_NUMBER", "")
    )
    logger.info("dialed number: %r", called)
    caller = attrs.get("sip.phoneNumber")
    call = CallInfo(call_id=ctx.room.name, caller=caller if isinstance(caller, str) and caller else None)

    # Abuse / cost limits live on the server (per-caller rate, block list, per-restaurant concurrency).
    # If that check is unreachable we let the call through rather than lose orders; the failure is logged.
    refusal: str | None = None
    try:
        verdict = await api.start_call(called, call.call_id, call.caller)
        if not verdict.get("allowed", True):
            refusal = verdict.get("reason", "refused")
            logger.warning("call refused: %s (caller=%s)", refusal, mask_number(call.caller))
    except httpx.HTTPStatusError as e:
        logger.warning("call check returned HTTP %s; the menu lookup will handle it", e.response.status_code)
    except Exception:
        logger.exception("call check unreachable; allowing the call")
    else:
        async def report_end() -> None:
            # Shutdown callbacks must be async functions (LiveKit awaits their result) and must not raise.
            try:
                await api.end_call(call.call_id)
            except Exception:
                logger.exception("could not report the end of call %s", call.call_id)

        ctx.add_shutdown_callback(report_end)

    try:
        menu = None if refusal else await api.get_tenant_menu(called)
    except httpx.HTTPStatusError as e:
        # Unknown number (404) or suspended restaurant (403): apologize and hang up.
        logger.warning(
            "menu lookup for %r failed: HTTP %s %s", called, e.response.status_code, e.response.text[:200]
        )
        if e.response.status_code not in (403, 404):
            raise
        menu = None

    closed_message = None
    if menu and menu.get("closed"):  # outside opening hours: say when we open, then hang up
        closed_message = (
            f"Sorry, {menu.get('name', 'we')} is closed right now. Our hours are {menu.get('hours')}. Goodbye."
        )
        logger.info("closed: %s", menu.get("hours"))
        menu = None

    if menu is None:
        sorry = closed_message or {
            "busy": "Sorry, we are very busy right now. Please call back in a few minutes. Goodbye.",
            "rate_limited": "Sorry, this number has called several times recently. Please try again a little later. Goodbye.",
        }.get(refusal or "", "Sorry, we can't take orders by phone right now. Goodbye.")
        await speak_and_hang_up(ctx, sorry)
        return

    grok = os.environ.get("VOICE_MODE", "pipeline") == "grok"
    if grok:
        # xAI can be down, out of credit or blocked. Find out BEFORE the caller is left in silence.
        usable, why = await grok_available()
        if not usable:
            logger.error("ALERT: xAI/Grok unavailable (%s)", why)
            if os.environ.get("GROK_FALLBACK", "apology") == "pipeline":
                logger.warning("falling back to the Deepgram + LLM pipeline for this call")
                grok = False
            else:
                await speak_and_hang_up(ctx, system_down_message(menu.get("transfer_number")))
                return
    if grok:
        # Experimental: one speech-to-speech model hears and speaks (and is also the "brain"), so the
        # Deepgram/DeepSeek/OpenAI pipeline below is bypassed. Needs XAI_API_KEY.
        extra = {"speed": float(os.environ["GROK_SPEED"])} if os.environ.get("GROK_SPEED") else {}
        session = AgentSession(
            llm=xai.realtime.RealtimeModel(
                voice=os.environ.get("GROK_VOICE", "ara"),
                model=os.environ.get("GROK_MODEL", "grok-voice-latest"),
                **extra,
            )
        )

        @session.on("close")
        def on_model_closed(ev) -> None:
            # The model connection died mid-call (credit ran out, network, provider outage): say so, then hang up.
            if getattr(ev, "error", None) is not None:
                logger.error("ALERT: Grok session closed with an error: %s", ev.error)
                asyncio.ensure_future(speak_and_hang_up(ctx, system_down_message(menu.get("transfer_number"))))
    else:
        session = AgentSession(
            stt=deepgram.STT(),
            llm=await build_llm(),
            tts=deepgram.TTS(),
            vad=silero.VAD.load(),
        )
    # Keypad 0 or "human agent" forwards the caller to the number the platform admin set for this restaurant.
    call.transfer = build_transferer(ctx, session, participant, called, call, menu.get("transfer_number"))
    logger.info("human line: %s", "set" if call.transfer.available else "none")

    @ctx.room.on("sip_dtmf_received")
    def on_dtmf(ev) -> None:
        if ev.digit == "0":
            logger.info("caller pressed 0")
            call.transfer.request("keypad")

    watchdog = asyncio.create_task(watch_call(ctx, session, Limits.from_env(), call))

    async def stop_watchdog() -> None:
        watchdog.cancel()

    ctx.add_shutdown_callback(stop_watchdog)
    if grok:
        name = menu.get("name", "our restaurant")
        await session.start(
            room=ctx.room,
            agent=OrderAgent(
                called,
                menu,
                on_order_submitted=end_call_after_goodbye(ctx, session),
                call=call,
                opening=f'Say exactly: "{greeting(name)}" and then wait for the caller\'s answer.',
            ),
        )
        return
    await session.start(
        room=ctx.room,
        agent=OrderAgent(called, menu, on_order_submitted=end_call_after_goodbye(ctx, session), call=call),
    )


def _env_number(name: str, cast, minimum: float = 0.0):
    """Optional numeric environment setting; unset or invalid -> None (invalid values are logged, never fatal)."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        value = cast(raw)
    except ValueError:
        logger.warning("ignoring %s=%r: not a valid number", name, raw)
        return None
    if value < minimum:
        logger.warning("ignoring %s=%r: must be at least %s", name, raw, minimum)
        return None
    return value


def make_load_fnc(max_calls: int, cpu_load: Callable[[object], float]):
    """Load number LiveKit uses to pick a worker and to stop sending it calls (the worker is unavailable above
    `load_threshold`, 0.7 in production). CPU alone is a poor signal here: in speech-to-speech mode the worker only
    relays audio, so it can hold far more calls than its memory or network comfortably carry. So the load is also
    driven by the NUMBER of calls: it grows gently with the call count (spreading calls evenly over the workers) and
    jumps to 1.0 at `max_calls`, a hard cap per worker."""

    def load(worker) -> float:
        calls = len(worker.active_jobs)
        if calls >= max_calls:
            return 1.0
        return max(cpu_load(worker), 0.6 * calls / max_calls)

    return load


def worker_options() -> agents.WorkerOptions:
    """LiveKit worker settings, tunable per deployment from the environment (see DEPLOY.md "Scaling the voice agent").
      AGENT_NAME                  name in the SIP dispatch rule
      AGENT_MAX_CALLS             hard cap of simultaneous calls per worker process group (default: CPU load only)
      AGENT_LOAD_THRESHOLD        load above which the worker takes no new calls (LiveKit default 0.7 in production)
      AGENT_IDLE_PROCESSES        warm job processes kept ready, so a new call starts without a cold start
      AGENT_JOB_MEMORY_WARN_MB    log a warning when one call's process uses more than this (default 1000)
      AGENT_JOB_MEMORY_LIMIT_MB   kill a call's process above this (default 0 = no limit)
      AGENT_DRAIN_SECONDS         on shutdown/deploy, wait this long for running calls to finish (default 900;
                                  keep the container's stop_grace_period above it)
      AGENT_PROMETHEUS_PORT       expose Prometheus metrics on this port (default off)
    """
    kwargs: dict = {"entrypoint_fnc": entrypoint, "agent_name": os.environ.get("AGENT_NAME", "")}
    if (v := _env_number("AGENT_LOAD_THRESHOLD", float, 0.05)) is not None:
        kwargs["load_threshold"] = v
    if (v := _env_number("AGENT_IDLE_PROCESSES", int, 0)) is not None:
        kwargs["num_idle_processes"] = int(v)
    if (v := _env_number("AGENT_JOB_MEMORY_WARN_MB", float, 1)) is not None:
        kwargs["job_memory_warn_mb"] = v
    if (v := _env_number("AGENT_JOB_MEMORY_LIMIT_MB", float, 0)) is not None:
        kwargs["job_memory_limit_mb"] = v
    kwargs["drain_timeout"] = int(_env_number("AGENT_DRAIN_SECONDS", int, 1) or 900)
    if (v := _env_number("AGENT_PROMETHEUS_PORT", int, 1)) is not None:
        kwargs["prometheus_port"] = int(v)
    max_calls = _env_number("AGENT_MAX_CALLS", int, 1)
    if max_calls is not None:
        from livekit.agents.worker import _DefaultLoadCalc

        kwargs["load_fnc"] = make_load_fnc(int(max_calls), _DefaultLoadCalc.get_load)
        # The call-count load is what should stop new calls, so make sure the threshold sits below its 1.0 jump
        # (the default 0.7 is fine; a threshold above 1.0 would never trigger).
        if kwargs.get("load_threshold", 0.7) >= 1.0:
            logger.warning("AGENT_LOAD_THRESHOLD >= 1.0 disables AGENT_MAX_CALLS; lower it")
    return agents.WorkerOptions(**kwargs)


if __name__ == "__main__":
    # AGENT_NAME must match the agent name in your LiveKit SIP dispatch rule (explicit dispatch). Unset =
    # an unnamed worker that is dispatched to every new room automatically.
    agents.cli.run_app(worker_options())
