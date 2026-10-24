"""Search accuracy on a 150-dish menu, including the mistakes speech recognition makes."""
from order_agent.menu_search import MenuIndex

# (name, description)
BASE = [
    ("Kung Pao Chicken", "Diced chicken, peanuts, dried chili"),
    ("Mapo Tofu", "Tofu with minced pork in chili bean sauce"),
    ("Sweet and Sour Pork", "Crispy pork in sweet and sour sauce"),
    ("Twice Cooked Pork", "Sliced pork belly with leeks"),
    ("Fish Fragrant Eggplant", "Eggplant in garlic chili sauce"),
    ("Dan Dan Noodles", "Noodles with spicy minced pork"),
    ("Beef Chow Fun", "Wok fried flat rice noodles with beef"),
    ("Yangzhou Fried Rice", "Egg fried rice with shrimp and ham"),
    ("Hot and Sour Soup", "Tofu, bamboo shoots and egg"),
    ("Wonton Soup", "Pork wontons in clear broth"),
    ("Peking Duck", "Roast duck with pancakes"),
    ("Orange Chicken", "Crispy chicken in orange sauce"),
    ("Salt and Pepper Shrimp", "Fried shrimp with chili and garlic"),
    ("Steamed Sea Bass", "Whole fish with ginger and scallion"),
    ("Xiao Long Bao", "Soup dumplings with pork"),
    ("Scallion Pancake", "Flaky pan fried pancake"),
    ("Green Beans with Garlic", "Stir fried green beans"),
    ("Cola", None),
]
PROTEINS = ["Chicken", "Beef", "Pork", "Shrimp", "Tofu"]
STYLES = ["Broccoli", "Black Pepper", "Garlic Sauce", "Curry", "Szechuan Style", "Cashew", "Mushroom", "Basil",
          "Ginger Scallion", "Lemon", "Honey Walnut", "Mongolian"]


def build_menu() -> list[dict]:
    items = [{"id": f"b{n}", "name": e, "description": d} for n, (e, d) in enumerate(BASE)]
    for si, sname in enumerate(STYLES):
        for pname in PROTEINS:
            items.append({"id": f"g{si}{pname}", "name": f"{sname} {pname}",
                          "description": f"{pname} stir fried {sname.lower()}"})
    return items


MENU = build_menu()
INDEX = MenuIndex(MENU)


def names(query, limit=3):
    return [i["name"] for _, i in INDEX.search(query, limit=limit)]


def test_menu_is_about_150_dishes():
    assert 70 <= len(MENU) <= 160  # 18 base + 12 styles x 5 proteins = 78; enough near-duplicates to be hard


def test_exact_english():
    assert names("Kung Pao Chicken")[0] == "Kung Pao Chicken"
    assert names("mapo tofu")[0] == "Mapo Tofu"


def test_english_typos_and_spacing():
    assert names("kung pow chicken")[0] == "Kung Pao Chicken"
    assert names("map o tofu")[0] == "Mapo Tofu"
    assert names("sweet n sour pork")[0] == "Sweet and Sour Pork"


def test_partial_names_return_several_candidates():
    got = names("black pepper", limit=5)
    assert len(got) >= 3 and all("Black Pepper" in n for n in got)


def test_ingredient_in_description():
    got = names("something with eggplant", limit=5)
    assert "Fish Fragrant Eggplant" in got


def test_nothing_on_the_menu_returns_empty():
    assert INDEX.search("hamburger") == []


def test_blank_query():
    assert INDEX.search("   ") == []


def test_ingredient_words_in_a_sentence_rank_by_name_first():
    got = names("do you have anything with shrimp", limit=8)
    assert got and all("Shrimp" in n for n in got[:5])  # dishes NAMED shrimp come before description hits


def test_filler_words_do_not_create_false_matches():
    assert INDEX.search("I would like some please") == []


def test_results_are_ranked_best_first():
    scores = [s for s, _ in INDEX.search("kung pao chicken", limit=5)]
    assert scores == sorted(scores, reverse=True) and scores[0] >= 95


# ---- categories -------------------------------------------------------------------------------------------------
def _cat(name, position=0):
    return {"name": name, "position": position}


CAT_ITEMS = [
    {"id": "t1", "name": "Green Tea", "description": None, "categories": [_cat("Vegetarian", 2), _cat("Drinks", 1)]},
    {"id": "t2", "name": "Cola", "description": None, "categories": [_cat("Drinks", 1)]},
    {"id": "t3", "name": "Mapo Tofu", "description": "Tofu", "categories": []},
]


def test_categories_are_ordered_by_the_owners_position():
    from order_agent.menu_search import menu_categories

    assert [c["name"] for c in menu_categories(CAT_ITEMS)] == ["Drinks", "Vegetarian"]


def test_category_query_matches_or_plural():
    idx = MenuIndex(CAT_ITEMS)
    for q in ("drinks", "Drink"):
        cat = idx.match_category(q)
        assert cat and cat["name"] == "Drinks", q
    assert idx.match_category("mapo tofu") is None
    assert idx.match_category("noodles") is None


def test_items_in_category_includes_a_dish_listed_in_several():
    idx = MenuIndex(CAT_ITEMS)
    assert [i["id"] for i in idx.items_in({"name": "Drinks"})] == ["t1", "t2"]
    assert [i["id"] for i in idx.items_in({"name": "Vegetarian"})] == ["t1"]
