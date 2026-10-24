"""Ordering scenarios for the AI evaluation suite (LAUNCH_PLAN P4.2).

Each scenario describes a simulated caller (a goal in plain words) and the order that
must reach the restaurant. Expected orders are written with readable names and resolved to ids by `expected_lines`.
Scoring is on what was SUBMITTED to the order API (what the kitchen would see), not on what the model said.
"""
from dataclasses import dataclass, field

MENU = {"name": "Demo Pizza", "items": [
    {"id": "pz", "name": "Margherita Pizza", "description": "Tomato, mozzarella, basil", "priceCents": 1400, "modifierGroups": [
        {"id": "g-crust", "name": "Crust", "required": True, "maxSelect": 1, "options": [
            {"id": "thin", "name": "Thin", "priceDeltaCents": 0},
            {"id": "thick", "name": "Thick", "priceDeltaCents": 0}]},
        {"id": "g-top", "name": "Extra toppings", "required": False, "maxSelect": 2, "options": [
            {"id": "cheese", "name": "Extra cheese", "priceDeltaCents": 150},
            {"id": "mush", "name": "Mushrooms", "priceDeltaCents": 100}]}]},
    {"id": "pep", "name": "Pepperoni Pizza", "description": "Pepperoni, mozzarella", "priceCents": 1600, "modifierGroups": [
        {"id": "g-crust", "name": "Crust", "required": True, "maxSelect": 1, "options": [
            {"id": "thin", "name": "Thin", "priceDeltaCents": 0},
            {"id": "thick", "name": "Thick", "priceDeltaCents": 0}]}]},
    {"id": "wings", "name": "Chicken Wings", "description": "Six wings", "priceCents": 900, "modifierGroups": [
        {"id": "g-sauce", "name": "Sauce", "required": True, "maxSelect": 1, "options": [
            {"id": "bbq", "name": "BBQ", "priceDeltaCents": 0},
            {"id": "hot", "name": "Hot", "priceDeltaCents": 0}]}]},
    {"id": "cola", "name": "Cola", "description": None, "priceCents": 300, "modifierGroups": []},
    {"id": "water", "name": "Bottled Water", "description": None, "priceCents": 200, "modifierGroups": []},
]}

# Expected line: (item_id, quantity, option ids). Notes are not scored (free text).
Line = tuple[str, int, tuple[str, ...]]


@dataclass(frozen=True)
class Scenario:
    id: str
    goal: str  # what the simulated caller wants, in plain words
    expected: list[Line] = field(default_factory=list)  # [] = nothing should be ordered
    name: str = "Sam"
    # Cancel/change scenarios: an earlier order (always number 7) exists, and `outcome` is what must happen to it:
    # "cancelled" (cancelled, nothing new ordered), "replaced" (cancelled + `expected` ordered instead) or
    # "untouched" (refused: wrong phone number, or the kitchen already started it).
    existing: list[Line] | None = None
    existing_status: str = "new"
    same_phone: bool = True
    outcome: str | None = None
    # The call must end with the agent hanging up (it called end_call after the goodbye).
    hangup: bool = False
    # Expected pickup time sent with the order: "asap" or 24-hour "HH:MM". None = not checked (the simulated caller
    # simply answers "as soon as possible" when asked).
    pickup: str | None = None
    # The restaurant allows texting the order link. `expect_text`: "caller" (the caller's own number), "none" (declined) or an
    # E.164 number the caller gives. Scored on who the (stubbed) text API was asked to text.
    text_offer: bool = False
    expect_text: str | None = None


SCENARIOS = [
    Scenario("simple-drink",
             "You want exactly one Cola and nothing else.",
             [("cola", 1, ())]),
    Scenario("two-items-quantity",
             "You want two Colas and one Bottled Water. Nothing else.",
             [("cola", 2, ()), ("water", 1, ())]),
    Scenario("required-choice",
             "You want one pepperoni pizza with a thick crust. Nothing else.",
             [("pep", 1, ("thick",))]),
    Scenario("optional-surcharge",
             "You want one margherita pizza, thin crust, with extra cheese. Say yes to extra cheese, no to mushrooms. Nothing else.",
             [("pz", 1, ("thin", "cheese"))]),
    Scenario("decline-optional",
             "You want one margherita pizza, thick crust, and no extra toppings of any kind. Nothing else.",
             [("pz", 1, ("thick",))]),
    Scenario("change-mind",
             "First ask for chicken wings with BBQ sauce, then change your mind and say you do not want the wings after all, and order one Cola instead. Final order: only one Cola.",
             [("cola", 1, ())]),
    Scenario("multi-dish",
             "You want one pepperoni pizza with thin crust, an order of wings with hot sauce, and one Cola.",
             [("pep", 1, ("thin",)), ("wings", 1, ("hot",)), ("cola", 1, ())]),
    Scenario("not-on-menu",
             "You want a cheeseburger. If they say they do not have it, order nothing and end the call politely without placing any order.",
             [], hangup=True),






    Scenario("pickup-asap",
             "You want exactly one Cola and nothing else. When they ask about pickup, say as soon as possible.",
             [("cola", 1, ())], pickup="asap"),
    Scenario("pickup-specific-time",
             "You want exactly one Cola and nothing else. You want to pick it up at 6:30 in the evening today; when asked about pickup, say 6:30 pm.",
             [("cola", 1, ())], pickup="18:30"),
    Scenario("pickup-later-then-time",
             "You want exactly one Cola and nothing else. When asked about pickup, only say you would like it a bit later, WITHOUT a time. Only if they then ask what time, say quarter past seven in the evening.",
             [("cola", 1, ())], pickup="19:15"),



    Scenario("goodbye-no-order",
             "You phoned but changed your mind and do not want to order anything. Say so, then say goodbye.",
             [], hangup=True),
    Scenario("goodbye-after-asking",
             "You only wanted to know whether they sell Cola. After the answer, say thanks, you will not order now, and goodbye.",
             [], hangup=True),

    Scenario("cancel-order",
             "Earlier you placed order number 7 (a pizza). You want to cancel it. Say the order number when asked, confirm the cancellation, and do not order anything new.",
             [], existing=[("pep", 1, ("thin",))], outcome="cancelled"),
    Scenario("change-add-item",
             "Earlier you placed order number 7 (one cola). You want to change it by adding one Bottled Water, so the order becomes one Cola and one Bottled Water. Confirm the changed order when read back.",
             [("cola", 1, ()), ("water", 1, ())], existing=[("cola", 1, ())], outcome="replaced"),
    Scenario("change-remove-item",
             "Earlier you placed order number 7 (two Colas and one Bottled Water). Change it by removing the Bottled Water, keeping the two Colas. Confirm the changed order when read back.",
             [("cola", 2, ())], existing=[("cola", 2, ()), ("water", 1, ())], outcome="replaced"),
    Scenario("cancel-from-other-phone",
             "Earlier you placed order number 7. You want to cancel it. If they say they cannot do it from this phone, accept that politely and end the call.",
             [], existing=[("cola", 1, ())], same_phone=False, outcome="untouched"),
    Scenario("cancel-already-started",
             "Earlier you placed order number 7. You want to cancel it. If they say the kitchen already started it, accept that politely and end the call.",
             [], existing=[("cola", 1, ())], existing_status="preparing", outcome="untouched"),


    Scenario("text-this-number",
             "You want exactly one Cola. After the order is placed you are asked whether to text the order details: say yes, to the number you are calling from.",
             [("cola", 1, ())], text_offer=True, expect_text="caller"),
    Scenario("text-other-number",
             "You want exactly one Cola. After the order is placed you are asked whether to text the order details: say you want it texted to a different number, 678 555 0199, and say it digit by digit. When the number is read back to you, say yes.",
             [("cola", 1, ())], text_offer=True, expect_text="+16785550199"),
    Scenario("text-declined",
             "You want exactly one Cola. After the order is placed you are asked whether to text the order details: say no thanks.",
             [("cola", 1, ())], text_offer=True, expect_text="none"),


]
