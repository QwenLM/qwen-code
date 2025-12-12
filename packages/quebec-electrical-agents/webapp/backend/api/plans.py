"""
Plans API - Upload and manage electrical plans
"""

from fastapi import APIRouter, UploadFile, File, HTTPException, Form
from fastapi.responses import JSONResponse
from pathlib import Path
import shutil
import uuid
from loguru import logger

plans_router = APIRouter()

# Upload directory
UPLOAD_DIR = Path("uploads/plans")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@plans_router.post("/plans/upload")
async def upload_plan(
    file: UploadFile = File(...),
    project_name: str = Form(default="Untitled Project")
):
    """
    Upload an electrical plan (PDF or image).

    Supports:
    - PDF files
    - PNG, JPG images

    Returns:
        Plan metadata and file path
    """
    try:
        # Validate file type
        allowed_types = ['application/pdf', 'image/png', 'image/jpeg']
        if file.content_type not in allowed_types:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type. Allowed: PDF, PNG, JPG"
            )

        # Generate unique filename
        file_extension = Path(file.filename).suffix
        unique_filename = f"{uuid.uuid4()}{file_extension}"
        file_path = UPLOAD_DIR / unique_filename

        # Save file
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        logger.info(f"📄 Saved plan: {unique_filename}")

        # Get file size
        file_size = file_path.stat().st_size

        return JSONResponse(content={
            "success": True,
            "plan": {
                "original_filename": file.filename,
                "saved_filename": unique_filename,
                "path": str(file_path),
                "project_name": project_name,
                "file_size": file_size,
                "file_type": file.content_type
            }
        })

    except Exception as e:
        logger.exception(f"Error uploading plan: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@plans_router.get("/plans/{filename}")
async def get_plan(filename: str):
    """Get plan file metadata"""
    try:
        file_path = UPLOAD_DIR / filename

        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Plan not found")

        file_size = file_path.stat().st_size

        return JSONResponse(content={
            "filename": filename,
            "path": str(file_path),
            "file_size": file_size,
            "exists": True
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error getting plan: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@plans_router.delete("/plans/{filename}")
async def delete_plan(filename: str):
    """Delete a plan file"""
    try:
        file_path = UPLOAD_DIR / filename

        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Plan not found")

        file_path.unlink()
        logger.info(f"🗑️  Deleted plan: {filename}")

        return JSONResponse(content={
            "success": True,
            "message": f"Plan {filename} deleted"
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error deleting plan: {e}")
        raise HTTPException(status_code=500, detail=str(e))
