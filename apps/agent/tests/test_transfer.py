import asyncio

from order_agent.transfer import Transferer, tel_uri


def run(coro):
    return asyncio.run(coro)


def test_tel_uri_accepts_only_e164():
    assert tel_uri("+14155550100") == "tel:+14155550100"
    assert tel_uri(" +1 415 555 0100 ") == "tel:+14155550100"
    assert tel_uri("4155550100") is None and tel_uri("") is None and tel_uri("+0123") is None


def make(number="+14155550100", ok=True, raises=False):
    log = []

    async def do(uri):
        log.append(("dial", uri))
        if raises:
            raise RuntimeError("sip down")
        return ok

    async def say(text):
        log.append(("say", text.split(",")[0][:30]))

    async def exact(text):
        log.append(("exact", text))

    async def wait():
        log.append(("wait",))

    async def report(via, good, error):
        log.append(("report", via, good, error))

    t = Transferer(number, do_transfer=do, say=say, say_exact=exact, wait_quiet=wait, report=report,
                   on_start=lambda: log.append(("start",)), on_done=lambda: log.append(("done",)), on_failed=lambda: log.append(("failed",)))
    return t, log


async def settle(t):
    await t._task


def test_keypad_zero_announces_then_dials_then_reports():
    async def go():
        t, log = make()
        assert t.request("keypad") is True and t.active
        await settle(t)
        return log
    log = run(go())
    kinds = [e[0] for e in log]
    assert kinds == ["start", "say", "dial", "report", "done"]
    assert ("dial", "tel:+14155550100") in log and ("report", "keypad", True, None) in log


def test_spoken_request_waits_for_the_model_to_finish_speaking():
    async def go():
        t, log = make()
        t.request("request")
        await settle(t)
        return [e[0] for e in log]
    assert run(go()) == ["start", "wait", "dial", "report", "done"]


def test_no_human_line_means_no_transfer_and_one_polite_notice_for_keypad():
    async def go():
        t, log = make(number=None)
        assert t.request("keypad") is False and t.request("keypad") is False and not t.active
        assert t.request("request") is False
        await asyncio.sleep(0)
        return log
    log = run(go())
    assert [e[0] for e in log] == ["say"]  # told once, never dialled


def test_second_request_while_forwarding_is_ignored():
    async def go():
        t, log = make()
        assert t.request("keypad") is True
        assert t.request("keypad") is False
        await settle(t)
        return [e for e in log if e[0] == "dial"]
    assert len(run(go())) == 1


def test_failed_transfer_keeps_the_caller_and_reports_it():
    async def go(**kw):
        t, log = make(**kw)
        t.request("request")
        await settle(t)
        await asyncio.sleep(0)
        return t, log
    for kw in ({"ok": False}, {"raises": True}):
        t, log = run(go(**kw))
        kinds = [e[0] for e in log]
        assert "done" not in kinds and kinds[-3:] == ["failed", "say", "exact"], kinds
        spoken = [e[1] for e in log if e[0] == "exact"][0]
        assert spoken.count("four one five, five five five, zero one zero zero") == 2 and "+" not in spoken
        assert not t.active  # the caller can try again
        rep = next(e for e in log if e[0] == "report")
        assert rep[2] is False and rep[3]
