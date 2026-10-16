"""Container intake: location photo uploads, asset resolution and config exposure."""

import io
from unittest.mock import AsyncMock

import httpx
import pytest
from PIL import Image

from homebox_companion import HomeboxClient
from homebox_companion.core import HomeboxAPIError
from homebox_companion.core.config import Settings
from server.app import create_app
from server.dependencies import get_gateway

pytestmark = pytest.mark.unit


def jpeg_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), "red").save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
def gateway():
    # Gateway methods are dynamic delegates to this client's API surface.
    gateway = AsyncMock(spec=HomeboxClient)
    gateway.upload_attachment.return_value = {"id": "attachment-id", "type": "photo"}
    return gateway


def make_client(gateway, **settings):
    app = create_app(Settings(disable_update_check=True, **settings))
    app.dependency_overrides[get_gateway] = lambda: gateway
    # Legacy auth rejects multipart requests without a bearer token before routing.
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test", headers={"Authorization": "Bearer test-token"}
    )


async def upload(client, path, data=None, content=None):
    return await client.post(
        path,
        files={"file": ("intake.jpg", content or jpeg_bytes(), "image/jpeg")},
        data=data,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/locations/loc-1/attachments", "/api/items/item-1/attachments"])
async def test_upload_targets_entity_and_omits_primary_by_default(gateway, path):
    async with make_client(gateway) as client:
        response = await upload(client, path)

    assert response.status_code == 200
    assert response.json()["id"] == "attachment-id"
    kwargs = gateway.upload_attachment.call_args.kwargs
    assert kwargs["item_id"] == path.split("/")[3]
    assert kwargs["filename"] == "intake.jpg"
    assert kwargs["attachment_type"] == "photo"
    assert "primary" not in kwargs


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/locations/loc-1/attachments", "/api/items/item-1/attachments"])
@pytest.mark.parametrize(("raw", "expected"), [("true", True), ("false", False)])
async def test_upload_passes_primary_through(gateway, path, raw, expected):
    async with make_client(gateway) as client:
        response = await upload(client, path, data={"primary": raw})

    assert response.status_code == 200
    assert gateway.upload_attachment.call_args.kwargs["primary"] is expected


@pytest.mark.asyncio
async def test_location_upload_enforces_size_limit(gateway):
    async with make_client(gateway, max_upload_size_mb=1) as client:
        response = await upload(client, "/api/locations/loc-1/attachments", content=b"x" * (1024 * 1024 + 1))

    assert response.status_code == 413
    gateway.upload_attachment.assert_not_awaited()


@pytest.mark.asyncio
async def test_location_upload_rejects_empty_file(gateway):
    async with make_client(gateway) as client:
        response = await client.post(
            "/api/locations/loc-1/attachments", files={"file": ("empty.jpg", b"", "image/jpeg")}
        )

    assert response.status_code == 400
    gateway.upload_attachment.assert_not_awaited()


@pytest.mark.asyncio
async def test_client_sends_primary_multipart_field_only_when_set():
    seen: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.content)
        return httpx.Response(200, json={"id": "attachment-id"})

    async with HomeboxClient(base_url="http://homebox/api/v1") as client:
        client.client._transport = httpx.MockTransport(handler)
        await client.upload_attachment("token", "loc-1", jpeg_bytes(), "a.jpg")
        await client.upload_attachment("token", "loc-1", jpeg_bytes(), "b.jpg", primary=True)
        await client.upload_attachment("token", "loc-1", jpeg_bytes(), "c.jpg", primary=False)

    assert b'name="primary"' not in seen[0]
    assert b'name="primary"\r\n\r\ntrue' in seen[1]
    assert b'name="primary"\r\n\r\nfalse' in seen[2]


@pytest.mark.asyncio
async def test_asset_lookup_returns_item_and_nearest_location(gateway):
    gateway.get_item_by_asset_id.return_value = {"id": "box-id", "name": "Box", "assetId": "000-001"}
    gateway.get_item.return_value = {
        "id": "box-id",
        "name": "Box",
        "assetId": "000-001",
        "parent": {"id": "shelf-item", "name": "Shelf"},
    }
    gateway.get_item_path.return_value = [
        {"id": "garage", "name": "Garage", "type": "location"},
        {"id": "shelf-item", "name": "Shelf", "type": "item"},
        {"id": "box-id", "name": "Box", "type": "item"},
    ]

    async with make_client(gateway) as client:
        response = await client.get("/api/items/by-asset/000-001")

    assert response.status_code == 200
    assert response.json() == {
        "id": "box-id",
        "name": "Box",
        "asset_id": "000-001",
        "location_id": "garage",
        "location_name": "Garage",
        "parent_id": "shelf-item",
    }
    gateway.get_item_by_asset_id.assert_awaited_once_with("000-001")


@pytest.mark.asyncio
async def test_asset_lookup_falls_back_to_parent_when_path_unavailable(gateway):
    gateway.get_item_by_asset_id.return_value = {"id": "box-id"}
    gateway.get_item.return_value = {"id": "box-id", "name": "Box", "parent": {"id": "garage", "name": "Garage"}}
    gateway.get_item_path.side_effect = HomeboxAPIError("boom")

    async with make_client(gateway) as client:
        response = await client.get("/api/items/by-asset/000-001")

    assert response.status_code == 200
    assert response.json()["location_id"] == "garage"


@pytest.mark.asyncio
async def test_unknown_asset_id_returns_404(gateway):
    error = HomeboxAPIError("Homebox response could not be processed")
    error.__cause__ = ValueError("No item found with asset ID: 000-999")
    gateway.get_item_by_asset_id.side_effect = error

    async with make_client(gateway) as client:
        response = await client.get("/api/items/by-asset/000-999")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_item_describes_item_location(gateway):
    gateway.get_item.return_value = {"id": "box-id", "name": "Box", "parent": {"id": "garage", "name": "Garage"}}
    gateway.get_item_path.return_value = [{"id": "garage", "name": "Garage", "type": "location"}]

    async with make_client(gateway) as client:
        response = await client.get("/api/items/box-id")

    assert response.status_code == 200
    assert response.json()["location_id"] == "garage"
    assert response.json()["asset_id"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("settings", "expected"),
    [
        ({}, (True, False)),
        ({"container_intake_photos": False, "skip_item_photos": True}, (False, True)),
    ],
)
async def test_config_exposes_intake_flags(gateway, settings, expected):
    async with make_client(gateway, **settings) as client:
        response = await client.get("/api/config")

    body = response.json()
    assert (body["container_intake_photos"], body["skip_item_photos"]) == expected


def test_intake_flags_read_from_environment(monkeypatch):
    monkeypatch.setenv("HBC_CONTAINER_INTAKE_PHOTOS", "false")
    monkeypatch.setenv("HBC_SKIP_ITEM_PHOTOS", "true")
    settings = Settings()
    assert settings.container_intake_photos is False
    assert settings.skip_item_photos is True
