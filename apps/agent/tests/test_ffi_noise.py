"""The harmless LiveKit FfiHandle.__del__ assertion after a hang-up is hidden; other unraisable errors still show."""
import sys
import types

from order_agent import main as m


def unraisable(exc, obj):
    return types.SimpleNamespace(exc_type=type(exc), exc_value=exc, exc_traceback=None, err_msg=None, object=obj)


class FfiHandle:
    def __del__(self):  # stands in for livekit.rtc._ffi_client.FfiHandle.__del__
        pass


def test_ffi_handle_assertion_is_swallowed_and_others_are_reported(monkeypatch):
    shown = []
    monkeypatch.setattr(sys, "__unraisablehook__", lambda u: shown.append(u))
    m._quiet_ffi_handle_noise(unraisable(AssertionError(), FfiHandle.__del__))
    assert shown == []                                   # the known noise: hidden
    other = unraisable(ValueError("real problem"), FfiHandle.__del__)
    m._quiet_ffi_handle_noise(other)
    other2 = unraisable(AssertionError(), print)         # an assertion somewhere else must still be reported
    m._quiet_ffi_handle_noise(other2)
    assert shown == [other, other2]


def test_the_hook_is_installed():
    assert sys.unraisablehook is m._quiet_ffi_handle_noise
