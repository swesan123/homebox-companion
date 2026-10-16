"""Unit tests for the optional chat-only model (HBC_CHAT_LLM_MODEL)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from homebox_companion.core.llm_router import (
    _build_router_from_profiles,
    get_chat_model_name,
    invalidate_router,
)
from homebox_companion.core.llm_utils import LLMCredentials

pytestmark = pytest.mark.unit

_OVERRIDE = "homebox_companion.core.llm_router._chat_model_override"


@pytest.fixture(autouse=True)
def reset_router():
    invalidate_router()
    yield
    invalidate_router()


def _creds(api_base: str | None = None) -> LLMCredentials:
    return LLMCredentials(
        model="gemini/gemini-4-argon",
        api_key="primary-key",
        api_base=api_base,
        profile_name="primary",
    )


def _build(override: str, fallback=None, api_base: str | None = None):
    with (
        patch(_OVERRIDE, return_value=override),
        patch(
            "homebox_companion.core.llm_utils.resolve_llm_credentials",
            return_value=_creds(api_base),
        ),
        patch("homebox_companion.core.llm_router.get_fallback_profile", return_value=fallback),
    ):
        return _build_router_from_profiles()


def test_chat_model_name_defaults_to_primary() -> None:
    with patch(_OVERRIDE, return_value=""):
        assert get_chat_model_name() == "primary"


def test_chat_model_name_is_chat_when_override_set() -> None:
    with patch(_OVERRIDE, return_value="gemini/gemini-3.8-flash"):
        assert get_chat_model_name() == "chat"


def test_router_has_no_chat_deployment_without_override() -> None:
    router = _build("")
    assert [m["model_name"] for m in router.model_list] == ["primary"]


def test_router_adds_chat_deployment_sharing_primary_credentials() -> None:
    router = _build("gemini/gemini-3.8-flash", api_base="https://proxy.example")
    by_name = {m["model_name"]: m["litellm_params"] for m in router.model_list}

    assert by_name["primary"]["model"] == "gemini/gemini-4-argon"
    assert by_name["chat"]["model"] == "gemini/gemini-3.8-flash"
    assert by_name["chat"]["api_key"] == "primary-key"
    assert by_name["chat"]["api_base"] == "https://proxy.example"


def test_chat_deployment_falls_back_when_fallback_profile_exists() -> None:
    fallback = MagicMock()
    fallback.model = "gemini/gemini-3.8-flash"
    fallback.api_key = None
    fallback.api_base = None

    router = _build("gemini/gemini-3.8-flash", fallback=fallback)

    names = [m["model_name"] for m in router.model_list]
    assert names == ["primary", "chat", "fallback"]
    assert {"chat": ["fallback"]} in router.fallbacks
    assert {"primary": ["fallback"]} in router.fallbacks


def test_chat_client_requests_chat_model_name() -> None:
    from homebox_companion.chat.llm_client import LLMClient

    with patch(_OVERRIDE, return_value="gemini/gemini-3.8-flash"):
        kwargs = LLMClient()._build_request_kwargs([], None, stream=False)
    assert kwargs["model"] == "chat"

    with patch(_OVERRIDE, return_value=""):
        kwargs = LLMClient()._build_request_kwargs([], None, stream=False)
    assert kwargs["model"] == "primary"


def test_config_defaults_to_no_chat_override(monkeypatch: pytest.MonkeyPatch) -> None:
    from homebox_companion.core.config import Settings

    monkeypatch.delenv("HBC_CHAT_LLM_MODEL", raising=False)
    assert Settings(_env_file=None).chat_llm_model == ""
    monkeypatch.setenv("HBC_CHAT_LLM_MODEL", "gemini/gemini-3.8-flash")
    assert Settings(_env_file=None).chat_llm_model == "gemini/gemini-3.8-flash"
