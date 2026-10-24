"""When xAI is unusable the caller must hear a short apology instead of silence (no network: httpx is faked)."""
import asyncio

import httpx
import pytest

from order_agent import main as m


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(m, "_grok_check", None)
    monkeypatch.setenv("XAI_API_KEY", "xai-test")


def fake_httpx(monkeypatch, status=200, body=None, exc=None):
    class Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            if exc:
                raise exc
            return httpx.Response(status, json=body or {}, request=httpx.Request("GET", url))
    monkeypatch.setattr(m.httpx, "AsyncClient", Client)


def test_blocked_team_means_unavailable(monkeypatch):
    fake_httpx(monkeypatch, 200, {"team_blocked": True, "api_key_blocked": False})
    usable, why = run(m.grok_available())
    assert usable is False and "out of credit" in why


def test_forbidden_or_missing_key_means_unavailable(monkeypatch):
    fake_httpx(monkeypatch, 403, {"error": "credits"})
    assert run(m.grok_available())[0] is False
    monkeypatch.setattr(m, "_grok_check", None)
    monkeypatch.delenv("XAI_API_KEY")
    assert run(m.grok_available()) == (False, "XAI_API_KEY is not set")


def test_healthy_account_is_available_and_a_flaky_check_never_blocks_calls(monkeypatch):
    fake_httpx(monkeypatch, 200, {"team_blocked": False, "api_key_blocked": False})
    assert run(m.grok_available())[0] is True
    monkeypatch.setattr(m, "_grok_check", None)
    fake_httpx(monkeypatch, exc=httpx.ConnectTimeout("slow"))
    assert run(m.grok_available())[0] is True  # the check itself failed: try the call anyway
    monkeypatch.setattr(m, "_grok_check", None)
    fake_httpx(monkeypatch, 500)
    assert run(m.grok_available())[0] is True


def test_the_result_is_cached_so_calls_are_not_delayed(monkeypatch):
    calls = []

    class Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            calls.append(1)
            return httpx.Response(200, json={"team_blocked": True}, request=httpx.Request("GET", url))
    monkeypatch.setattr(m.httpx, "AsyncClient", Client)
    run(m.grok_available()); run(m.grok_available())
    assert len(calls) == 1


def test_the_apology_is_plain_and_the_line_is_always_dropped(monkeypatch):
    assert "system problem" in m.SYSTEM_DOWN_MESSAGE and "call back" in m.SYSTEM_DOWN_MESSAGE
    hung = []

    async def fake_hang_up(ctx):
        hung.append(ctx)

    class Boom:  # speaking fails (e.g. TTS key missing): the caller must still not be left on a dead line
        def __init__(self, *a, **k): raise RuntimeError("no tts")
    monkeypatch.setattr(m, "hang_up", fake_hang_up)
    monkeypatch.setattr(m, "AgentSession", Boom)
    run(m.speak_and_hang_up("ctx", "hello"))
    assert hung == ["ctx"]


def test_phone_numbers_are_read_digit_by_digit():
    assert m.spoken_number("+14155550199") == "four one five, five five five, zero one nine nine"
    # other countries: groups of three, last four together, every digit exactly once
    spoken = m.spoken_number("+442071234567").replace(",", "").split()
    assert " ".join(spoken) == "four four two zero seven one two three four five six seven"
    assert m.spoken_number(None) is None and m.spoken_number("12") is None


def test_the_apology_reads_the_human_line_twice_when_there_is_one():
    msg = m.system_down_message("+14155550199")
    assert msg.count("four one five, five five five, zero one nine nine") == 2
    assert "system problem" in msg and "+" not in msg and "4155550199" not in msg
    assert "call the restaurant directly." in m.system_down_message(None)  # no number: no invented one


def test_the_model_never_says_the_number_the_system_reads_it():
    from evals.scenarios import MENU

    prompt = m.build_instructions({**MENU, "transfer_number": "+14155550199"})
    assert "zero one nine nine" not in prompt and "4155550199" not in prompt  # not in the model's hands
    assert "never say, guess or invent any phone number" in prompt

    spoken = []

    class FakeSession:
        def say(self, text):
            spoken.append(text)

    class A(m.OrderAgent):
        session = FakeSession()
    a = A("+1", {**MENU, "transfer_number": "+14155550199"})
    hint = a._read_restaurant_number()
    assert spoken == ["The restaurant's number is four one five, five five five, zero one nine nine. "
                      "Again: four one five, five five five, zero one nine nine."]
    assert "do NOT say any number yourself" in hint
    spoken.clear()
    assert A("+1", MENU)._read_restaurant_number() == "" and spoken == []  # no number on file: nothing is invented
