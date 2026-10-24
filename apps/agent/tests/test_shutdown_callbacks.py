"""LiveKit awaits every shutdown callback; a plain function returning a non-awaitable crashed shutdown."""
import inspect
import re
from pathlib import Path


def test_every_shutdown_callback_is_an_async_function():
    src = Path(__file__).resolve().parents[1].joinpath("src/order_agent/main.py").read_text()
    registered = re.findall(r"add_shutdown_callback\((\w+)\)", src)
    assert registered, "expected named callbacks"
    assert "add_shutdown_callback(lambda" not in src
    for name in registered:
        assert re.search(rf"async def {name}\(", src), f"{name} must be `async def`"
