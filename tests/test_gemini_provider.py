"""Tests for Gemini as a first-class LLM provider.

Offline tests verify that LiteLLM recognizes the Gemini model ids we document,
that the capability gate lets them through without HBC_LLM_ALLOW_UNSAFE_MODELS,
and that the structured-output schemas survive LiteLLM's Gemini request
transformation. The live test hits the real Gemini API.

Environment variables (live test only):
    - TEST_GEMINI_API_KEY (required)
    - TEST_GEMINI_MODEL (optional, defaults to gemini/gemini-4-argon)

Run with: TEST_GEMINI_API_KEY=your-key uv run pytest tests/test_gemini_provider.py -m live
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from homebox_companion import detect_items_from_bytes
from homebox_companion.ai.llm import vision_completion
from homebox_companion.ai.model_capabilities import get_model_capabilities
from homebox_companion.ai.response_models import ItemsResponse, get_items_response_model
from homebox_companion.core import config
from homebox_companion.core.llm_router import get_router, invalidate_router
from homebox_companion.core.llm_utils import LLMCredentials
from homebox_companion.core.persistent_settings import CustomFieldDefinition

GEMINI_MODELS = ["gemini/gemini-4-argon", "gemini/gemini-3.8-flash"]

TINY_IMAGE_DATA_URI = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


@pytest.fixture(autouse=True)
def reset_state():
    """Reset capability cache and Router singleton around each test."""
    get_model_capabilities.cache_clear()
    invalidate_router()
    yield
    get_model_capabilities.cache_clear()
    invalidate_router()


@pytest.mark.unit
class TestGeminiCapabilities:
    """LiteLLM must know the documented Gemini ids without the unsafe flag."""

    @pytest.mark.parametrize("model", GEMINI_MODELS)
    def test_capabilities_detected(self, model: str) -> None:
        caps = get_model_capabilities(model)

        assert caps.vision is True
        assert caps.multi_image is True
        assert caps.structured_output is True


@pytest.mark.integration
class TestGeminiVisionCompletion:
    """vision_completion passes the response model through for Gemini."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("model", GEMINI_MODELS)
    async def test_response_model_passed_to_router(self, model: str, monkeypatch) -> None:
        monkeypatch.setattr(config.settings, "llm_allow_unsafe_models", False)
        monkeypatch.setattr(config.settings, "rate_limit_enabled", False)

        mock_creds = LLMCredentials(model=model, api_key="test-key", api_base=None, profile_name="primary")

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '{"items": [{"name": "AA Battery", "quantity": 4}]}'
        mock_response.usage = None

        with (
            patch("homebox_companion.core.llm_utils.resolve_llm_credentials", return_value=mock_creds),
            patch("homebox_companion.core.llm_router.get_fallback_profile", return_value=None),
        ):
            router = get_router()
            with patch.object(router, "acompletion", new_callable=AsyncMock) as mock_completion:
                mock_completion.return_value = mock_response

                result = await vision_completion(
                    system_prompt="sys",
                    user_prompt="detect",
                    image_data_uris=[TINY_IMAGE_DATA_URI, TINY_IMAGE_DATA_URI],
                    expected_keys=["items"],
                    response_model=ItemsResponse,
                )

        assert result["items"][0]["name"] == "AA Battery"
        mock_completion.assert_called_once()
        assert mock_completion.call_args.kwargs["response_format"] is ItemsResponse


@pytest.mark.unit
class TestGeminiSchemaTransformation:
    """LiteLLM's Gemini transformation must accept our response models."""

    @staticmethod
    def _transform(response_model: type) -> dict[str, Any]:
        from litellm.llms.vertex_ai.gemini import transformation
        from litellm.utils import get_optional_params

        # LiteLLM's internal signature is loosely typed; call it untyped.
        transform: Any = transformation.sync_transform_request_body

        optional_params = get_optional_params(
            model="gemini-4-argon",
            custom_llm_provider="gemini",
            response_format=response_model,
        )
        messages = [
            {"role": "system", "content": "sys"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "detect"},
                    {"type": "image_url", "image_url": {"url": TINY_IMAGE_DATA_URI}},
                ],
            },
        ]
        return transform(
            gemini_api_key="test-key",
            messages=messages,
            api_base=None,
            model="gemini-4-argon",
            client=None,
            timeout=10,
            extra_headers=None,
            optional_params=dict(optional_params),
            logging_obj=SimpleNamespace(pre_call=lambda **_: None),
            custom_llm_provider="gemini",
            litellm_params={},
            vertex_project=None,
            vertex_location=None,
            vertex_auth_header=None,
        )

    def test_static_items_response(self) -> None:
        body = self._transform(ItemsResponse)

        config_ = body["generationConfig"]
        assert config_["response_mime_type"] == "application/json"
        # Optional (str | None) fields are emitted as anyOf, which Gemini's
        # responseJsonSchema accepts natively.
        assert "anyOf" in str(config_["response_json_schema"])
        assert body["contents"][0]["parts"][-1].get("inline_data")

    def test_dynamic_custom_field_model(self) -> None:
        custom_fields = [
            CustomFieldDefinition(name="Storage Location", ai_instruction="Where this is kept"),
            CustomFieldDefinition(name="Cable Length", ai_instruction="Estimated length"),
        ]

        body = self._transform(get_items_response_model(custom_fields))

        schema_text = str(body["generationConfig"]["response_json_schema"])
        assert "storageLocation" in schema_text
        assert "cableLength" in schema_text


@pytest.fixture
def gemini_api_key() -> str:
    """Provide Gemini API key, skipping test if not set."""
    key = os.environ.get("TEST_GEMINI_API_KEY", "").strip()
    if not key:
        pytest.skip("TEST_GEMINI_API_KEY must be set for Gemini tests.")
    return key


@pytest.fixture
def gemini_model() -> str:
    """Provide Gemini model name."""
    return os.environ.get("TEST_GEMINI_MODEL", "gemini/gemini-4-argon").strip()


@pytest.mark.live
@pytest.mark.asyncio
async def test_gemini_multi_item_detection(
    gemini_api_key: str,
    gemini_model: str,
    multi_item_single_image_path: Path,
    monkeypatch,
) -> None:
    """Gemini should detect multiple distinct items from a single photo."""
    monkeypatch.setenv("HBC_LLM_API_KEY", gemini_api_key)
    monkeypatch.setenv("HBC_LLM_MODEL", gemini_model)
    config.settings = config.Settings()
    invalidate_router()

    detected_items = await detect_items_from_bytes(
        image_bytes=multi_item_single_image_path.read_bytes(),
        single_item=False,
    )

    assert len(detected_items) > 1, "Expected multiple items from multi-item image"
    for item in detected_items:
        assert item.name, "Each item must have a name"
        assert item.quantity >= 1, "Each item must have positive quantity"
