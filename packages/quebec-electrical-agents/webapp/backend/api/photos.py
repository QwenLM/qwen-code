"""
Photos API - Upload photos and extract GPS coordinates
"""

from fastapi import APIRouter, UploadFile, File, HTTPException, Request, Form
from fastapi.responses import JSONResponse
from typing import List, Optional
from pathlib import Path
import shutil
import uuid
from loguru import logger

from services.photo_gps import PhotoGPSService, GeoreferencedPlan

photos_router = APIRouter()

# Upload directory
UPLOAD_DIR = Path("uploads/photos")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@photos_router.post("/photos/upload")
async def upload_photos(
    files: List[UploadFile] = File(...),
    request: Request = None
):
    """
    Upload multiple photos and extract GPS metadata.

    Accepts multiple photo files, saves them, and extracts GPS coordinates
    from EXIF data.

    Returns:
        List of photo metadata including GPS coordinates
    """
    try:
        photo_service: PhotoGPSService = request.app.state.photo_gps
        results = []

        for file in files:
            # Validate file type
            if not file.content_type.startswith('image/'):
                raise HTTPException(status_code=400, detail=f"File {file.filename} is not an image")

            # Generate unique filename
            file_extension = Path(file.filename).suffix
            unique_filename = f"{uuid.uuid4()}{file_extension}"
            file_path = UPLOAD_DIR / unique_filename

            # Save file
            with open(file_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)

            logger.info(f"📸 Saved photo: {unique_filename}")

            # Extract metadata
            metadata = photo_service.extract_photo_metadata(str(file_path))

            results.append({
                "original_filename": file.filename,
                "saved_filename": unique_filename,
                "path": str(file_path),
                "metadata": metadata.model_dump()
            })

        logger.success(f"✅ Processed {len(results)} photos")

        return JSONResponse(content={
            "success": True,
            "count": len(results),
            "photos": results
        })

    except Exception as e:
        logger.exception(f"Error uploading photos: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@photos_router.post("/photos/map-to-plan")
async def map_photos_to_plan(
    photo_paths: List[str],
    plan_path: str,
    reference_points: List[dict],
    request: Request = None
):
    """
    Map uploaded photos to positions on an electrical plan.

    Uses GPS coordinates from photos and georeferenced plan to determine
    where each photo was taken relative to the plan.

    Args:
        photo_paths: List of photo file paths
        plan_path: Path to electrical plan
        reference_points: List of {x, y, lat, lon} reference points

    Returns:
        List of photos mapped to plan coordinates
    """
    try:
        photo_service: PhotoGPSService = request.app.state.photo_gps

        # Create georeferenced plan
        plan = photo_service.create_georeferenced_plan(plan_path, reference_points)

        # Batch process photos
        photos_on_plan = photo_service.batch_process_photos(photo_paths, plan)

        return JSONResponse(content={
            "success": True,
            "plan": plan.model_dump(),
            "photos": [p.model_dump() for p in photos_on_plan]
        })

    except Exception as e:
        logger.exception(f"Error mapping photos to plan: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@photos_router.get("/photos/{filename}/metadata")
async def get_photo_metadata(filename: str, request: Request):
    """
    Get metadata for a specific photo.

    Returns:
        Photo metadata including GPS if available
    """
    try:
        photo_service: PhotoGPSService = request.app.state.photo_gps
        file_path = UPLOAD_DIR / filename

        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Photo not found")

        metadata = photo_service.extract_photo_metadata(str(file_path))

        return JSONResponse(content=metadata.model_dump())

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error getting photo metadata: {e}")
        raise HTTPException(status_code=500, detail=str(e))
