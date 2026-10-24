"""Order logic that must hold no matter what the language model does (no network, no LLM)."""
import asyncio

from order_agent import main as m

MENU = {"name": "T", "items": [
    {"id": "pz", "name": "Pizza", "description": "Cheese pizza", "priceCents": 1400, "modifierGroups": [
        {"id": "g-crust", "name": "Crust", "required": True, "maxSelect": 1, "options": [
            {"id": "c1", "name": "Thin", "priceDeltaCents": 0},
            {"id": "c2", "name": "Thick", "priceDeltaCents": 0}]},
        {"id": "g-top", "name": "Toppings", "required": False, "maxSelect": 2, "options": [
            {"id": "t1", "name": "Cheese", "priceDeltaCents": 150},
            {"id": "t2", "name": "Mushroom", "priceDeltaCents": 100},
            {"id": "t3", "name": "Olives", "priceDeltaCents": 100}]}]},
    {"id": "cola", "name": "Cola", "description": None, "priceCents": 300, "modifierGroups": []},
]}


def run(coro):
    return asyncio.run(coro)


def agent():
    return m.OrderAgent("+1", MENU)


def test_required_choice_is_enforced_in_code():
    a = agent()
    assert "must choose" in run(a.add_item(None, "pz", 1))
    assert a.items == []


def test_dish_is_added_immediately_and_optional_choices_are_hinted_once():
    a = agent()
    out = run(a.add_item(None, "pz", 1, ["o1"]))          # Thin
    assert a.items and a.items[0]["option_ids"] == ["c1"]  # in the order right away
    assert "NOT been offered" in out and "o3=Cheese (+$1.50)" in out
    assert "NOT been offered" not in run(a.get_order(None))  # the hint is only on add_item


def test_no_hint_when_the_caller_already_chose_from_the_optional_group():
    a = agent()
    out = run(a.add_item(None, "pz", 1, ["o1", "o3"]))     # Thin + Cheese
    assert "NOT been offered" not in out
    assert "$1.50 more per item" in out
    assert "Total" not in out and "do NOT say the total" in out   # only the extra cost is announced mid-order
    assert "Total: $15.50" in run(a.get_order(None))              # the total comes once, at the read-back


def test_add_choice_adds_prices_and_never_removes():
    a = agent()
    run(a.add_item(None, "pz", 2, ["o1"]))
    out = run(a.add_choice(None, "pz", ["o3"]))
    assert "$3.00 more for 2" in out and "Total" not in out
    assert "Total: $31.00" in run(a.get_order(None))
    assert set(a.items[0]["option_ids"]) == {"c1", "t1"}


def test_add_choice_merges_into_an_identical_line():
    a = agent()
    run(a.add_item(None, "pz", 1, ["o1", "o3"]))
    run(a.add_item(None, "pz", 1, ["o1"]))
    run(a.add_choice(None, "pz", ["o3"]))                  # second line becomes identical to the first
    assert len(a.items) == 1 and a.items[0]["quantity"] == 2


def test_add_choice_rejects_bad_requests():
    a = agent()
    assert "not in the order" in run(a.add_choice(None, "pz", ["o3"]))
    run(a.add_item(None, "pz", 1, ["o1"]))
    assert "not a choice" in run(a.add_choice(None, "pz", ["o99"]))
    assert "at most" in run(a.add_choice(None, "pz", ["o3", "o4", "o5"]))   # 3 toppings, max 2
    assert "at most 1" in run(a.add_choice(None, "pz", ["o2"]))             # second crust
    assert a.items[0]["option_ids"] == ["c1"]                               # nothing changed


def test_search_menu_uses_the_same_option_codes_as_the_full_menu():
    a = agent()
    out = run(a.search_menu(None, "pizza"))
    assert "id=pz" in out and "o3=Cheese (+$1.50)" in out and "CHOICE Crust (REQUIRED" in out
    assert "No dish matches" in run(a.search_menu(None, "hamburger"))


def test_search_mode_switches_on_menu_size(monkeypatch):
    monkeypatch.setattr(m, "SEARCH_THRESHOLD", 1)
    assert m.uses_search(MENU)
    assert "MENU OVERVIEW" in m.build_instructions(MENU) and "id=pz" not in m.build_instructions(MENU)
    monkeypatch.setattr(m, "SEARCH_THRESHOLD", 40)
    assert not m.uses_search(MENU) and "id=pz" in m.build_instructions(MENU)


# ---- categories -------------------------------------------------------------------------------------------------
DRINKS = {"name": "Drinks", "position": 0}
CAT_MENU = {"name": "T", "items": [
    {"id": "pz", "name": "Pizza", "description": "Cheese pizza", "priceCents": 1400, "categories": [], "modifierGroups": []},
    {"id": "cola", "name": "Cola", "description": None, "priceCents": 300, "categories": [DRINKS], "modifierGroups": []},
    {"id": "tea", "name": "Green Tea", "description": None, "priceCents": 400, "categories": [DRINKS], "modifierGroups": []},
]}


def test_big_menu_overview_is_grouped_by_category_with_the_rest_under_other():
    p = m.build_instructions(CAT_MENU, search=True)
    assert "Drinks: Cola | Green Tea" in p and "Other: Pizza" in p


def test_menu_without_categories_keeps_the_flat_overview():
    p = m.build_instructions(MENU, search=True)
    assert "Pizza | Cola" in p and "Other:" not in p


def test_full_menu_lines_show_each_dishs_categories():
    p = m.build_instructions(CAT_MENU, search=False)
    assert "| category: Drinks" in p


def test_search_menu_lists_a_category_when_the_caller_names_one():
    a = m.OrderAgent("+1", CAT_MENU)
    out = run(a.search_menu(None, "drinks"))
    assert 'Category "Drinks" has 2 dish(es)' in out and "id=cola" in out and "id=tea" in out and "id=pz" not in out
    # a dish name still searches dishes
    assert "Matches for" in run(a.search_menu(None, "pizza"))
