"""
FastAPI Backend - Quebec Electrical Agents Web Application
Système d'agents IA pour l'industrie électrique québécoise

This backend provides:
- Streaming AI responses via Server-Sent Events
- PGI (ERP) dashboard data detection and formatting
- Photo GPS geolocation for electrical plans
- Integration with existing electrical analysis agents
"""

from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from contextlib import asynccontextmanager
from loguru import logger
import sys
from pathlib import Path

# Add parent directory to path for existing services
sys.path.append(str(Path(__file__).parent.parent.parent))

from api.stream import stream_router
from api.photos import photos_router
from api.plans import plans_router
from api.pgi import pgi_router
from services.pgi_detector import PGIDetector
from services.photo_gps import PhotoGPSService

# Configure logging
logger.remove()
logger.add(
    sys.stdout,
    colorize=True,
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan> - <level>{message}</level>"
)
logger.add(
    "logs/webapp_backend.log",
    rotation="500 MB",
    retention="10 days",
    level="INFO"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifecycle manager for FastAPI application.
    Initializes services on startup and cleans up on shutdown.
    """
    logger.info("🚀 Starting Quebec Electrical Agents Web Backend...")

    # Initialize services
    app.state.pgi_detector = PGIDetector()
    app.state.photo_gps = PhotoGPSService()

    logger.info("✅ All services initialized successfully")
    logger.info("📡 Backend ready to accept requests")

    yield

    logger.info("🛑 Shutting down backend services...")


# Create FastAPI application
app = FastAPI(
    title="Quebec Electrical Agents API",
    description="API backend for Quebec electrical project management with AI agents",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Include routers
app.include_router(stream_router, prefix="/api", tags=["Streaming"])
app.include_router(photos_router, prefix="/api", tags=["Photos GPS"])
app.include_router(plans_router, prefix="/api", tags=["Plans"])
app.include_router(pgi_router, prefix="/api", tags=["PGI Dashboard"])


@app.get("/")
async def root():
    """Root endpoint - API health check"""
    return {
        "message": "Quebec Electrical Agents API",
        "version": "1.0.0",
        "status": "operational",
        "features": [
            "AI Streaming Chat",
            "PGI Dashboard Data",
            "Photo GPS Geolocation",
            "Electrical Plan Analysis",
            "CEQ/RBQ/RSST Compliance"
        ]
    }


@app.get("/api/health")
async def health_check():
    """
    Health check endpoint for monitoring.

    Returns:
        dict: Service health status
    """
    return {
        "status": "healthy",
        "services": {
            "pgi_detector": "operational",
            "photo_gps": "operational",
            "ai_agents": "operational"
        }
    }


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Custom HTTP exception handler with logging"""
    logger.error(f"HTTP {exc.status_code}: {exc.detail} - {request.url}")
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "path": str(request.url)}
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """General exception handler for unexpected errors"""
    logger.exception(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "error": str(exc)}
    )


if __name__ == "__main__":
    import uvicorn

    logger.info("🔥 Starting Uvicorn server...")
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_config=None  # Use loguru instead
    )
