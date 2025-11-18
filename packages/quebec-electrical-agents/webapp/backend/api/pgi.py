"""
PGI API - Project management dashboard data
"""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional
from loguru import logger

from services.pgi_detector import PGIDetector

pgi_router = APIRouter()


class TextAnalysisRequest(BaseModel):
    """Request to analyze text for PGI data"""
    text: str


@pgi_router.post("/pgi/analyze")
async def analyze_for_pgi(
    request_data: TextAnalysisRequest,
    request: Request
):
    """
    Analyze text and extract PGI dashboard data.

    Detects project management data like budgets, labor hours,
    material costs, and formats it for dashboard visualization.

    Returns:
        PGI data if detected, null otherwise
    """
    try:
        pgi_detector: PGIDetector = request.app.state.pgi_detector

        pgi_data = pgi_detector.detect_and_format(request_data.text)

        if pgi_data:
            return JSONResponse(content={
                "success": True,
                "detected": True,
                "data": pgi_data.model_dump()
            })
        else:
            return JSONResponse(content={
                "success": True,
                "detected": False,
                "data": None
            })

    except Exception as e:
        logger.exception(f"Error analyzing PGI data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@pgi_router.get("/pgi/sample")
async def get_sample_pgi_data():
    """
    Get sample PGI dashboard data for testing.

    Returns realistic sample data for Quebec electrical projects.
    """
    from services.pgi_detector import PGIData, PGIRentabilite, PGIProject, PGILabor, PGIMaterial
    from datetime import datetime, timedelta

    # Create sample data
    sample_data = PGIData(
        rentabilite=PGIRentabilite(
            projects=[
                PGIProject(
                    name="KORLCC",
                    status="active",
                    budget=450000.0,
                    spent=320000.0,
                    completion=71.0
                ),
                PGIProject(
                    name="Alexis Nihon",
                    status="active",
                    budget=680000.0,
                    spent=480000.0,
                    completion=65.0
                ),
                PGIProject(
                    name="Urgences",
                    status="urgent",
                    budget=125000.0,
                    spent=95000.0,
                    completion=45.0
                )
            ],
            total_budget=1255000.0,
            total_spent=895000.0,
            profit_margin=28.69
        ),
        labor=[
            PGILabor(
                date=(datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d"),
                hours=45.0,
                cost=2025.0,
                project="KORLCC",
                workers=3
            ),
            PGILabor(
                date=(datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d"),
                hours=52.0,
                cost=2340.0,
                project="Alexis Nihon",
                workers=4
            ),
            PGILabor(
                date=(datetime.now() - timedelta(days=4)).strftime("%Y-%m-%d"),
                hours=38.0,
                cost=1710.0,
                project="KORLCC",
                workers=2
            ),
            PGILabor(
                date=(datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d"),
                hours=64.0,
                cost=2880.0,
                project="Alexis Nihon",
                workers=4
            ),
            PGILabor(
                date=(datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d"),
                hours=28.0,
                cost=1260.0,
                project="Urgences",
                workers=2
            ),
            PGILabor(
                date=(datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d"),
                hours=56.0,
                cost=2520.0,
                project="KORLCC",
                workers=4
            ),
            PGILabor(
                date=datetime.now().strftime("%Y-%m-%d"),
                hours=48.0,
                cost=2160.0,
                project="Alexis Nihon",
                workers=3
            )
        ],
        materials=[
            PGIMaterial(category="Câblage", quantity=2500.0, cost=12500.0, unit="m"),
            PGIMaterial(category="Protection", quantity=45.0, cost=6750.0, unit="units"),
            PGIMaterial(category="Panneaux", quantity=8.0, cost=24000.0, unit="units"),
            PGIMaterial(category="Conduits", quantity=450.0, cost=4500.0, unit="m"),
            PGIMaterial(category="Boîtes", quantity=120.0, cost=2400.0, unit="units"),
            PGIMaterial(category="Prises et interrupteurs", quantity=85.0, cost=3400.0, unit="units"),
            PGIMaterial(category="Éclairage", quantity=32.0, cost=9600.0, unit="units")
        ],
        projects_active=3,
        total_revenue=1255000.0,
        alerts=[
            "⚠️ Alexis Nihon: Budget à 70.6% utilisé",
            "🚨 Urgences: Projet urgent nécessite attention",
            "⏰ Heures élevées: 331.0h cette semaine"
        ]
    )

    return JSONResponse(content={
        "success": True,
        "data": sample_data.model_dump()
    })
