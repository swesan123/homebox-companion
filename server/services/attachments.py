"""Shared attachment upload handling for item and location entities."""

from typing import Any

from fastapi import Request, UploadFile
from loguru import logger

from homebox_companion import HomeboxGateway
from homebox_companion.ai.images import compress_image_for_upload

from ..dependencies import validate_file_size
from .image_processing import run_image_processing


async def upload_entity_photo(
    request: Request,
    gateway: HomeboxGateway,
    entity_id: str,
    file: UploadFile,
    primary: bool | None = None,
) -> dict[str, Any]:
    """Validate, compress and upload an image as a photo attachment.

    Items and locations are both entities in Homebox 0.26, so they share one
    upload path. ``primary`` is only forwarded to Homebox when explicitly set.

    Raises:
        HTTPException: If the file is empty or exceeds the configured size limit.
    """
    logger.info(f"Uploading attachment to entity: {entity_id}")
    logger.debug(f"File: {file.filename}, content_type: {file.content_type}")

    # Validate file size (raises HTTPException if too large)
    file_bytes = await validate_file_size(file, request.app.state.settings)

    # Log file size for diagnostics - helps identify empty/corrupted uploads
    file_size = len(file_bytes)
    logger.debug(f"Received file: {file.filename}, size: {file_size:,} bytes")
    if file_size == 0:
        logger.warning(f"Empty file received for entity {entity_id}: {file.filename}")
    elif file_size < 1000:
        logger.warning(f"Suspiciously small file for entity {entity_id}: {file.filename} ({file_size} bytes)")

    filename = file.filename or "image.jpg"
    mime_type = file.content_type or "image/jpeg"

    max_dimension, jpeg_quality = request.app.state.settings.image_quality_params
    file_bytes, mime_type = await run_image_processing(
        compress_image_for_upload, file_bytes, max_dimension, jpeg_quality
    )

    extra: dict[str, Any] = {} if primary is None else {"primary": primary}
    result = await gateway.upload_attachment(
        item_id=entity_id,
        file_bytes=file_bytes,
        filename=filename,
        mime_type=mime_type,
        attachment_type="photo",
        **extra,
    )
    logger.info(f"Successfully uploaded attachment to entity {entity_id}")
    return result
