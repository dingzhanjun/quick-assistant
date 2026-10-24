from order_agent import main as m
from evals.scenarios import MENU


def test_prompt_never_volunteers_choices_a_dish_does_not_have():
    p = m.build_instructions(MENU)
    assert "does NOT have is never mentioned" in p and "unless the caller themselves asks" in p


def test_prompt_knows_about_human_transfer_and_order_changes():
    p = m.build_instructions(MENU)
    assert "transfer_to_human" in p and "find_order" in p and "cancel_found_order" in p


def test_address_is_given_to_the_agent_only_when_set_and_only_on_request():
    with_address = m.build_instructions({**MENU, "address": "123 Main Street, Springfield"})
    assert "123 Main Street, Springfield" in with_address and "only if the caller asks where" in with_address
    without = m.build_instructions(MENU)
    assert "do not know the restaurant's address" in without and "Never make one up" in without


def test_each_confirmed_item_gets_a_short_filler_before_add_item():
    en = m.build_instructions(MENU)
    assert '"Sure." or "OK."' in en and "never the same word twice in a row" in en
    assert "WITHOUT saying Sure / OK again" in en
    assert 'say nothing before the add_item call' not in en  # the old rule that forbade the filler
