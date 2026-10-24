from order_agent.main import greeting


def test_greeting_discloses_the_assistant_before_asking_for_the_order():
    g = greeting("Demo Pizza")
    assert g.startswith("Thanks for calling Demo Pizza.")
    assert "automated ordering assistant" in g
    assert g.index("automated") < g.index("What would you like to order?")
