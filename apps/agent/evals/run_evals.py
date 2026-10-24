"""AI evaluation suite for the phone ordering agent (LAUNCH_PLAN P4.2).

A simulated caller (an LLM following a scenario's goal) talks to the real OrderAgent over text, many times per
scenario. Only the order API is stubbed; prompts, tools and the model are the real ones.
The order that reaches the (stubbed) API is compared with the expected order. Exits 1 below the pass-rate threshold.

  cd apps/agent && uv run python -m evals.run_evals                 # all scenarios, 3 runs each
  uv run python -m evals.run_evals --runs 10 --only pickup- --threshold 0.9

Agent under test: openai or deepseek by default (whichever key is set; EVAL_AGENT_PROVIDER to force). xAI/Grok costs
real money, so it runs ONLY with an explicit EVAL_AGENT_PROVIDER=grok (needs XAI_API_KEY). The simulated caller is
openai or deepseek (EVAL_CALLER_PROVIDER), never xAI unless you also force it., EVAL_THRESHOLD (default 0.9). Calls a paid API: a full default run is
21 scenarios x 3 runs, well under a dollar.
"""
import argparse
import asyncio
import contextvars
import json
import logging
import os
import sys
import uuid
from pathlib import Path

if not os.environ.get("SSL_CERT_FILE"):  # python.org builds on macOS cannot verify TLS certs (websocket to xAI)
    import certifi

    os.environ["SSL_CERT_FILE"] = certifi.where()  # must run before aiohttp/livekit are imported

import httpx
from dotenv import load_dotenv
from livekit.agents import AgentSession
from livekit.plugins import openai

from order_agent import api, main as m
from order_agent.call_guard import CallInfo, is_goodbye

from .scenarios import MENU, SCENARIOS, Scenario
from .scoring import RunScore, markdown, score_run, summarize

load_dotenv(Path(__file__).resolve().parents[3] / ".env")
MAX_TURNS = 18
HANGUP = "[HANGUP]"

CALLER_PROMPT = """You are a customer phoning a restaurant to order food, speaking to an automated assistant.
Your goal: {goal}
Rules:
- Say ONE short, natural spoken sentence at a time, like a real caller. No lists, no markdown.
- Answer the assistant's questions directly. Only mention what your goal says; do not add other food.
- If asked when you want to pick the order up and your goal gives no time, say as soon as possible.
- If asked for your name, say "{name}". If they read your order back and it matches your goal, confirm with a clear yes. If it does not match, correct them.
- If asked whether you want anything else and you are done, say no.
- When the call is over (the assistant gave an order number and said goodbye, or you decided to order nothing and said goodbye), reply with exactly {hangup} and nothing else."""


OPENING = "Ask the caller what they would like to order, in one short sentence. Do not greet them again."


def has(key: str) -> bool:
    return bool(os.environ.get(key))


def agent_provider() -> str:
    """Which model plays the restaurant agent: deepseek or openai (the text pipeline), or grok (xAI realtime).
    xAI is expensive, so it is NEVER the default (not even when VOICE_MODE=grok): it only runs when
    EVAL_AGENT_PROVIDER=grok is set on purpose. Default: OpenAI if its key is set, else DeepSeek."""
    return os.environ.get("EVAL_AGENT_PROVIDER") or ("openai" if has("OPENAI_API_KEY") else "deepseek")


def caller_provider() -> str:
    """The simulated caller is always a cheap text LLM: openai | deepseek (EVAL_CALLER_PROVIDER). Never xAI by default."""
    if os.environ.get("EVAL_CALLER_PROVIDER"):
        return os.environ["EVAL_CALLER_PROVIDER"]
    if has("OPENAI_API_KEY"):
        return "openai"
    if has("DEEPSEEK_API_KEY"):
        return "deepseek"
    raise SystemExit("Set OPENAI_API_KEY or DEEPSEEK_API_KEY for the simulated caller (xAI is not used by default: too costly).")


CALLER_ENDPOINT = {
    "openai": (None, "OPENAI_API_KEY", "gpt-4o-mini"),
    "deepseek": ("https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat"),
    "xai": ("https://api.x.ai/v1", "XAI_API_KEY", "grok-4-fast-non-reasoning"),
}


def agent_llm():
    p = agent_provider()
    if p == "grok":
        from livekit.plugins import xai

        return xai.realtime.RealtimeModel(
            voice=os.environ.get("GROK_VOICE", "ara"), model=os.environ.get("GROK_MODEL", "grok-voice-latest")
        )
    model = os.environ.get("EVAL_AGENT_MODEL", "deepseek-chat" if p == "deepseek" else "gpt-4o-mini")
    return openai.LLM.with_deepseek(model=model) if p == "deepseek" else openai.LLM(model=model)


def caller_client():
    from openai import AsyncOpenAI

    base, key, _ = CALLER_ENDPOINT[caller_provider()]
    return AsyncOpenAI(base_url=base, api_key=os.environ[key]) if base else AsyncOpenAI()


async def caller_says(client, scn: Scenario, transcript: list[tuple[str, str]]) -> str:
    messages = [{"role": "system", "content": CALLER_PROMPT.format(goal=scn.goal, name=scn.name, hangup=HANGUP)}]
    if not transcript:
        messages.append({"role": "user", "content": "(The line connects. Say your first sentence.)"})
    for who, text in transcript:
        # From the caller model's point of view the assistant is the "user" it answers.
        messages.append({"role": "user" if who == "agent" else "assistant", "content": text})
    res = await client.chat.completions.create(
        model=os.environ.get("EVAL_CALLER_MODEL", CALLER_ENDPOINT[caller_provider()][2]), messages=messages, temperature=0.7, max_tokens=80
    )
    return (res.choices[0].message.content or "").strip()


def assistant_text(result) -> str:
    out = []
    for ev in result.events:
        item = getattr(ev, "item", None)
        if getattr(ev, "type", "") == "message" and getattr(item, "role", "") == "assistant":
            out.append(item.text_content or "")
    return " ".join(t for t in out if t)


CAPTURED: dict[str, list[list[dict]]] = {}  # call id -> orders that reached the stubbed API
PICKUPS: dict[str, dict | None] = {}  # call id -> the pickup time sent with the (last) order
# caller number -> the earlier order (number 7) a cancel/change scenario starts with, and what happened to it
WORLD: dict[str, dict] = {}
ITEMS = {i["id"]: i for i in MENU["items"]}
OPTIONS = {o["id"]: o for i in MENU["items"] for g in i["modifierGroups"] for o in g["options"]}


def existing_order(lines) -> dict:
    items, total = [], 0
    for item_id, qty, opts in lines:
        item = ITEMS[item_id]
        cents = (item["priceCents"] + sum(OPTIONS[o]["priceDeltaCents"] for o in opts)) * qty
        total += cents
        items.append({"item_id": item_id, "name": item["name"], "quantity": qty, "notes": "", "option_ids": list(opts),
                      "options": [OPTIONS[o]["name"] for o in opts], "line_cents": cents})
    return {"order_number": 7, "customer_name": "Sam", "total_cents": total, "can_change": True, "items": items}


async def fake_lookup(called, number, caller):
    w = WORLD.get(caller or "")
    if not w or number != 7 or not w["same_phone"]:
        return {"allowed": False, "reason": "no_match"}
    if w["status"] != "new":
        return {"allowed": False, "reason": "not_new"}
    return {"allowed": True, "order": existing_order(w["lines"])}


async def fake_cancel(called, number, caller):
    w = WORLD.get(caller or "")
    if not w or number != 7 or not w["same_phone"] or w["status"] != "new":
        return {"cancelled": False, "reason": "no_match"}
    w["state"] = "cancelled"
    return {"cancelled": True, "order_number": 7}


async def fake_submit(called, body):
    # Runs execute concurrently and the stub is process-wide, so route by the call id inside the idempotency key.
    orders = CAPTURED[body["idempotency_key"].rsplit(":", 1)[0]]
    orders.append(body["items"])
    PICKUPS[body["idempotency_key"].rsplit(":", 1)[0]] = body.get("pickup")
    if body.get("replaces_order_number") == 7 and body.get("caller") in WORLD:
        w = WORLD[body["caller"]]
        if not w["same_phone"] or w["status"] != "new":
            req = httpx.Request("POST", "http://x")
            raise httpx.HTTPStatusError("409", request=req, response=httpx.Response(409, request=req, text='{"error":"cannot_replace"}'))
        w["state"] = "replaced"
    return {"order_number": 100 + len(orders)}


TEXTED: dict[str, list[str]] = {}  # call id -> numbers the (stubbed) text API was asked to text
CURRENT_CALL: contextvars.ContextVar[str] = contextvars.ContextVar("current_call", default="")


async def fake_text(called, order_number, number):
    # The text API call carries no call id: concurrent runs are told apart by the task context set in run_once.
    TEXTED.setdefault(CURRENT_CALL.get(), []).append(number)
    return {"ok": True}


api.submit_order = fake_submit  # type: ignore[assignment]
api.request_order_text = fake_text  # type: ignore[assignment]
api.lookup_order = fake_lookup  # type: ignore[assignment]
api.cancel_order = fake_cancel  # type: ignore[assignment]


async def run_once(scn: Scenario, client) -> RunScore:
    call_id = f"eval-{uuid.uuid4().hex[:8]}"
    orders = CAPTURED.setdefault(call_id, [])
    done = asyncio.Event()
    # The caller number is unique per run: it keys the simulated earlier order for cancel/change scenarios.
    caller = f"+1555{uuid.uuid4().int % 10_000_000:07d}"
    if scn.existing is not None:
        WORLD[caller] = {"lines": scn.existing, "status": scn.existing_status, "same_phone": scn.same_phone, "state": "untouched"}
    CURRENT_CALL.set(call_id)
    agent = m.OrderAgent(
        "+10000000000", {**MENU, "text_orders": True} if scn.text_offer else MENU,
        call=CallInfo(call_id=call_id, caller=caller), on_order_submitted=done.set,
        opening=OPENING,  # the real greeting is spoken with TTS, which a text-only run does not have
    )
    transcript: list[tuple[str, str]] = []
    try:
        async with AgentSession(llm=agent_llm()) as session:
            await session.start(agent)
            if session.current_speech:
                await session.current_speech.wait_for_playout()
            for _ in range(MAX_TURNS):
                said = await caller_says(client, scn, transcript)
                if HANGUP in said:
                    break
                transcript.append(("caller", said))
                result = await asyncio.wait_for(session.run(user_input=said), timeout=60)
                transcript.append(("agent", assistant_text(result)))
                if done.is_set():
                    await asyncio.sleep(0)  # the real call hangs up here
                    break
    except Exception as e:  # a crash is a failed run, not a crashed suite
        if os.environ.get("EVAL_VERBOSE"):
            import traceback

            print(f"--- {scn.id} CRASH\n" + "\n".join(f"  {w}: {t}" for w, t in transcript), file=sys.stderr)
            traceback.print_exc()
        return score_run(scn.id, scn.expected, orders, error=repr(e)[:200], outcome=scn.outcome)
    actual = WORLD[caller]['state'] if caller in WORLD else None
    score = score_run(scn.id, scn.expected, orders, outcome=scn.outcome, actual_outcome=actual,
                       expect_hangup=scn.hangup, expect_pickup=scn.pickup, pickup=PICKUPS.get(call_id),
                       expect_text=scn.expect_text, texted=TEXTED.get(call_id, []), caller=caller,
                       # like production: end_call was called, OR the agent said goodbye (the safety net hangs up then)
                       hung_up=done.is_set() or any(is_goodbye(t) for w, t in transcript if w == "agent"))
    if os.environ.get("EVAL_VERBOSE") == "all" or (not score.passed and os.environ.get("EVAL_VERBOSE")):
        print(f"--- {scn.id}\n" + "\n".join(f"  {w}: {t}" for w, t in transcript), file=sys.stderr)
    return score


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=int(os.environ.get("EVAL_RUNS", 3)))
    ap.add_argument("--only", default="", help="run scenarios whose id contains this text")
    ap.add_argument("--threshold", type=float, default=float(os.environ.get("EVAL_THRESHOLD", 0.9)))
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--out", default="evals/last_run.json")
    args = ap.parse_args()
    logging.getLogger("livekit").setLevel(logging.ERROR)
    logging.getLogger("order_agent").setLevel(logging.ERROR)

    client = caller_client()
    todo = [s for s in SCENARIOS if args.only in s.id for _ in range(args.runs)]
    sem = asyncio.Semaphore(args.concurrency)

    async def guarded(s):
        async with sem:
            return await run_once(s, client)

    scores = await asyncio.gather(*(guarded(s) for s in todo))
    summary = summarize(list(scores), args.threshold)
    summary["agent"] = agent_provider()
    summary["caller"] = caller_provider()
    Path(args.out).write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    text = markdown(summary)
    text = f"Agent under test: **{summary['agent']}**, simulated caller: {summary['caller']}\n\n" + text
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        Path(os.environ["GITHUB_STEP_SUMMARY"]).write_text(text)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
