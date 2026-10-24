"""The agent must be able to hang up when the caller says goodbye without ordering (no order submitted)."""
import asyncio

from order_agent import main as m
from order_agent.call_guard import CallInfo
from evals.scenarios import MENU


def run(coro):
    return asyncio.run(coro)


def test_end_call_arms_the_hangup_and_asks_for_one_short_goodbye():
    armed = []
    a = m.OrderAgent("+1", MENU, call=CallInfo("r", "+15551234567"), on_order_submitted=lambda: armed.append(1))
    out = run(a.end_call(None))
    assert armed == [1] and "ONE very short goodbye" in out


def test_end_call_does_nothing_during_a_transfer():
    armed = []

    class Transfer:
        active = True
    a = m.OrderAgent("+1", MENU, call=CallInfo("r", None, Transfer()), on_order_submitted=lambda: armed.append(1))
    assert armed == [] and "transferred" in run(a.end_call(None))


def test_prompt_tells_the_model_to_call_end_call_after_a_goodbye():
    p = m.build_instructions(MENU)
    assert "call end_call in that same turn" in p and "the line stays open" in p


class FakeSession:
    agent_state = "thinking"

    def __init__(self):
        self.handlers = {}

    def on(self, name):
        def deco(fn):
            self.handlers[name] = fn
            return fn
        return deco

    def emit(self, old, new):
        class Ev:
            old_state, new_state = old, new
        self.handlers["agent_state_changed"](Ev())


def test_line_drops_once_the_goodbye_has_been_spoken(monkeypatch):
    """armed -> speaking (goodbye) -> listening: hang up about a second after the goodbye ends, not before."""
    hung = []

    async def fake_hang_up(ctx):
        hung.append(ctx)
    monkeypatch.setattr(m, "hang_up", fake_hang_up)

    async def scenario():
        sess = FakeSession()
        arm = m.end_call_after_goodbye("ctx", sess)
        arm()
        sess.emit("listening", "thinking")
        sess.emit("thinking", "speaking")  # the goodbye
        await asyncio.sleep(0.3)
        assert hung == []                   # still talking
        sess.emit("speaking", "listening")  # goodbye finished
        await asyncio.sleep(0.5)
        assert hung == []                   # a beat of silence first
        await asyncio.sleep(1.0)
        return list(hung)
    assert run(scenario()) == ["ctx"]


def test_goodbye_detection():
    from order_agent.call_guard import is_goodbye

    for yes in ["No problem at all. Thanks for calling, have a good one!", "Goodbye!", "Okay, bye bye."]:
        assert is_goodbye(yes), yes
    for no in ["What would you like to order?", "Anything else?", "Your order is one cola for three dollars.",
               "Thanks for calling Demo Pizza. What would you like to order?",
               "Goodbye? Are you sure you do not want to order?", "", None]:
        assert not is_goodbye(no), no


class Msg:
    type = "message"

    def __init__(self, role, text):
        self.role, self.text_content = role, text


def test_hangup_even_if_the_model_never_calls_end_call(monkeypatch):
    """The reported bug: caller says bye, agent says bye, line stays open."""
    hung = []

    async def fake_hang_up(ctx):
        hung.append(ctx)
    monkeypatch.setattr(m, "hang_up", fake_hang_up)

    async def scenario():
        sess = FakeSession()
        m.end_call_after_goodbye("ctx", sess)  # armed by nobody: only the goodbye detector can end this call
        class Ev:
            def __init__(self, item): self.item = item
        sess.agent_state = "listening"       # the goodbye has finished playing when the message is committed
        sess.handlers["conversation_item_added"](Ev(Msg("user", "by the way, I have a question")))  # not a goodbye
        await asyncio.sleep(1.3)
        assert hung == []
        sess.handlers["conversation_item_added"](Ev(Msg("assistant", "No problem, thanks for calling. Goodbye!")))
        await asyncio.sleep(1.5)
        return list(hung)
    assert run(scenario()) == ["ctx"]


def test_caller_goodbye_detection():
    from order_agent.call_guard import caller_said_goodbye as c

    for yes in ["bye", "Bye!", "ok goodbye", "bye-bye now", "thanks, Bye"]:
        assert c(yes), yes
    for no in ["by the way, one more thing", "I would like a pizza", "hello", "", None]:
        assert not c(no), no


def test_caller_saying_bye_hangs_up_no_matter_what_the_agent_was_doing(monkeypatch):
    hung = []

    async def fake_hang_up(ctx):
        hung.append(ctx)
    monkeypatch.setattr(m, "hang_up", fake_hang_up)

    async def scenario():
        sess = FakeSession()
        m.end_call_after_goodbye("ctx", sess)
        class Ev:
            def __init__(self, item): self.item = item
        sess.agent_state = "listening"
        # mid-order, the caller says bye: the call ends, even though the agent never said goodbye and no order was placed
        sess.handlers["conversation_item_added"](Ev(Msg("user", "forget it, bye")))
        await asyncio.sleep(1.5)
        first = list(hung)
        return first
    assert run(scenario()) == ["ctx"]


def test_the_agents_reply_to_a_goodbye_is_not_cut_off(monkeypatch):
    hung = []

    async def fake_hang_up(ctx):
        hung.append(ctx)
    monkeypatch.setattr(m, "hang_up", fake_hang_up)

    async def scenario():
        sess = FakeSession()
        m.end_call_after_goodbye("ctx", sess)
        class Ev:
            def __init__(self, item): self.item = item
        sess.agent_state = "listening"
        sess.handlers["conversation_item_added"](Ev(Msg("user", "bye")))
        sess.emit("listening", "thinking")      # the agent starts replying right away
        sess.emit("thinking", "speaking")
        await asyncio.sleep(1.5)
        assert hung == []                       # still saying its goodbye: not hung up
        sess.emit("speaking", "listening")
        await asyncio.sleep(1.5)
        return list(hung)
    assert run(scenario()) == ["ctx"]
