"""
PGI (Progiciel de Gestion Intégré / ERP) Data Detector Service

Detects structured project management data in AI responses and formats it
for rendering in the PGI Dashboard component.

Supports:
- Rentabilité (Profitability) data
- Main d'œuvre (Labor) tracking
- Matériel (Materials) inventory
- Project sections: KORLCC, Alexis Nihon, Urgences
"""

from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional, Literal
from datetime import datetime
import re
import json
from loguru import logger


class PGIProject(BaseModel):
    """PGI Project data model"""
    name: str = Field(..., description="Project name (KORLCC, Alexis Nihon, Urgences)")
    status: Literal["active", "completed", "pending", "urgent"] = Field(
        default="active",
        description="Project status"
    )
    budget: float = Field(..., description="Total project budget (CAD)")
    spent: float = Field(..., description="Amount spent so far (CAD)")
    completion: float = Field(..., ge=0, le=100, description="Completion percentage")


class PGIRentabilite(BaseModel):
    """Rentabilité (Profitability) data"""
    projects: List[PGIProject] = Field(default_factory=list)
    total_budget: float = Field(default=0.0)
    total_spent: float = Field(default=0.0)
    profit_margin: float = Field(default=0.0, description="Profit margin percentage")


class PGILabor(BaseModel):
    """Main d'œuvre (Labor) tracking"""
    date: str = Field(..., description="Date (YYYY-MM-DD)")
    hours: float = Field(..., description="Labor hours")
    cost: float = Field(..., description="Labor cost (CAD)")
    project: str = Field(..., description="Project name")
    workers: int = Field(default=1, description="Number of workers")


class PGIMaterial(BaseModel):
    """Matériel (Materials) data"""
    category: str = Field(..., description="Material category")
    quantity: float = Field(..., description="Quantity")
    cost: float = Field(..., description="Cost (CAD)")
    unit: str = Field(default="units", description="Unit of measurement")


class PGIData(BaseModel):
    """Complete PGI dashboard data"""
    type: Literal["pgi_dashboard"] = "pgi_dashboard"
    title: str = Field(default="Tableau de Bord PGI")
    generated_at: str = Field(default_factory=lambda: datetime.now().isoformat())

    # Core data
    rentabilite: Optional[PGIRentabilite] = None
    labor: List[PGILabor] = Field(default_factory=list)
    materials: List[PGIMaterial] = Field(default_factory=list)

    # Metadata
    projects_active: int = Field(default=0)
    total_revenue: float = Field(default=0.0)
    alerts: List[str] = Field(default_factory=list)


class PGIDetector:
    """
    Service to detect and extract PGI data from text responses.

    Uses regex patterns and keyword detection to identify structured
    project management data in AI responses.
    """

    def __init__(self):
        """Initialize PGI detector with patterns"""
        self.project_names = ["KORLCC", "Alexis Nihon", "Urgences", "Urgence"]

        # Regex patterns for data extraction
        self.patterns = {
            "budget": re.compile(r"budget[:\s]+(\$?[\d\s,]+)\$?", re.IGNORECASE),
            "spent": re.compile(r"dépens[eé][:\s]+(\$?[\d\s,]+)\$?", re.IGNORECASE),
            "revenue": re.compile(r"revenu[:\s]+(\$?[\d\s,]+)\$?", re.IGNORECASE),
            "hours": re.compile(r"(\d+(?:\.\d+)?)\s*heures?", re.IGNORECASE),
            "cost": re.compile(r"co[uû]t[:\s]+(\$?[\d\s,]+)\$?", re.IGNORECASE),
            "completion": re.compile(r"(\d+(?:\.\d+)?)\s*%?\s*(?:complet|terminé|avancement)", re.IGNORECASE),
            "workers": re.compile(r"(\d+)\s*(?:travailleur|ouvrier|électricien)s?", re.IGNORECASE),
        }

    def detect_and_format(self, text: str) -> Optional[PGIData]:
        """
        Detect if text contains PGI data and format it.

        Args:
            text: Text to analyze

        Returns:
            PGIData if detected, None otherwise
        """
        try:
            # Check for PGI keywords
            if not self._contains_pgi_keywords(text):
                return None

            logger.info("🔍 Detecting PGI data in response...")

            # Extract data
            projects = self._extract_projects(text)
            labor = self._extract_labor(text)
            materials = self._extract_materials(text)

            # If we have any data, create PGI structure
            if projects or labor or materials:
                # Calculate rentabilité
                rentabilite = None
                if projects:
                    total_budget = sum(p.budget for p in projects)
                    total_spent = sum(p.spent for p in projects)
                    profit_margin = ((total_budget - total_spent) / total_budget * 100) if total_budget > 0 else 0

                    rentabilite = PGIRentabilite(
                        projects=projects,
                        total_budget=total_budget,
                        total_spent=total_spent,
                        profit_margin=round(profit_margin, 2)
                    )

                # Generate alerts
                alerts = self._generate_alerts(projects, labor, materials)

                pgi_data = PGIData(
                    rentabilite=rentabilite,
                    labor=labor,
                    materials=materials,
                    projects_active=len(projects),
                    total_revenue=sum(p.budget for p in projects) if projects else 0,
                    alerts=alerts
                )

                logger.success(f"✅ PGI data extracted: {len(projects)} projects, {len(labor)} labor entries")
                return pgi_data

            return None

        except Exception as e:
            logger.error(f"Error detecting PGI data: {e}")
            return None

    def _contains_pgi_keywords(self, text: str) -> bool:
        """Check if text contains PGI-related keywords"""
        keywords = [
            "projet", "budget", "rentabilité", "profitabilité",
            "main d'œuvre", "matériel", "dépenses", "coût",
            "KORLCC", "Alexis Nihon", "Urgence",
            "dashboard", "tableau de bord", "statistiques"
        ]
        text_lower = text.lower()
        return any(keyword.lower() in text_lower for keyword in keywords)

    def _extract_projects(self, text: str) -> List[PGIProject]:
        """Extract project data from text"""
        projects = []

        for project_name in self.project_names:
            if project_name.lower() in text.lower():
                # Find section about this project
                project_section = self._extract_project_section(text, project_name)

                if project_section:
                    # Extract data
                    budget = self._extract_amount(project_section, "budget")
                    spent = self._extract_amount(project_section, "spent")
                    completion = self._extract_percentage(project_section)

                    # Determine status
                    status = "active"
                    if "urgent" in project_name.lower() or "urgence" in project_section.lower():
                        status = "urgent"
                    elif completion >= 100:
                        status = "completed"
                    elif "en attente" in project_section.lower() or "pending" in project_section.lower():
                        status = "pending"

                    if budget > 0:
                        projects.append(PGIProject(
                            name=project_name,
                            status=status,
                            budget=budget,
                            spent=spent,
                            completion=min(completion, 100.0)
                        ))

        # If no specific projects found, try to extract generic project data
        if not projects:
            projects = self._extract_generic_projects(text)

        return projects

    def _extract_project_section(self, text: str, project_name: str) -> str:
        """Extract text section related to a specific project"""
        # Simple heuristic: extract paragraph containing project name
        paragraphs = text.split('\n\n')
        for para in paragraphs:
            if project_name.lower() in para.lower():
                return para

        # Try sentence-level
        sentences = text.split('.')
        for i, sent in enumerate(sentences):
            if project_name.lower() in sent.lower():
                # Return this sentence + next 2
                return '. '.join(sentences[i:min(i+3, len(sentences))])

        return ""

    def _extract_amount(self, text: str, amount_type: str) -> float:
        """Extract monetary amount from text"""
        if amount_type == "budget":
            match = self.patterns["budget"].search(text)
        elif amount_type == "spent":
            match = self.patterns["spent"].search(text)
        elif amount_type == "revenue":
            match = self.patterns["revenue"].search(text)
        else:
            match = self.patterns["cost"].search(text)

        if match:
            amount_str = match.group(1).replace(',', '').replace(' ', '').replace('$', '')
            try:
                return float(amount_str)
            except ValueError:
                return 0.0

        return 0.0

    def _extract_percentage(self, text: str) -> float:
        """Extract completion percentage"""
        match = self.patterns["completion"].search(text)
        if match:
            try:
                return float(match.group(1))
            except ValueError:
                return 0.0
        return 0.0

    def _extract_labor(self, text: str) -> List[PGILabor]:
        """Extract labor/workforce data"""
        labor_entries = []

        # Look for labor-related keywords
        if any(keyword in text.lower() for keyword in ["main d'œuvre", "heures", "travailleur", "ouvrier"]):
            # Extract hours
            hours_matches = self.patterns["hours"].findall(text)
            cost = self._extract_amount(text, "cost")
            workers = self._extract_workers(text)

            if hours_matches:
                for hours_str in hours_matches[:5]:  # Limit to 5 entries
                    try:
                        hours = float(hours_str)
                        # Estimate cost if not provided
                        if cost == 0:
                            cost = hours * 45.0  # ~45 CAD/hour for electricians in Quebec

                        labor_entries.append(PGILabor(
                            date=datetime.now().strftime("%Y-%m-%d"),
                            hours=hours,
                            cost=cost,
                            project="General",
                            workers=workers
                        ))
                    except ValueError:
                        continue

        return labor_entries

    def _extract_workers(self, text: str) -> int:
        """Extract number of workers"""
        match = self.patterns["workers"].search(text)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                return 1
        return 1

    def _extract_materials(self, text: str) -> List[PGIMaterial]:
        """Extract material/equipment data"""
        materials = []

        # Common electrical materials in Quebec
        material_keywords = {
            "câble": "Câblage",
            "fil": "Câblage",
            "disjoncteur": "Protection",
            "panneau": "Panneaux",
            "conduit": "Conduits",
            "boîte": "Boîtes",
            "prise": "Prises et interrupteurs",
            "interrupteur": "Prises et interrupteurs",
            "luminaire": "Éclairage"
        }

        for keyword, category in material_keywords.items():
            if keyword in text.lower():
                # Try to extract quantity and cost
                # This is simplified - real implementation would be more sophisticated
                cost = self._extract_amount(text, "cost")
                if cost > 0:
                    materials.append(PGIMaterial(
                        category=category,
                        quantity=1.0,
                        cost=cost,
                        unit="units"
                    ))

        return materials

    def _extract_generic_projects(self, text: str) -> List[PGIProject]:
        """Extract generic project data when specific projects not mentioned"""
        projects = []

        budget = self._extract_amount(text, "budget")
        spent = self._extract_amount(text, "spent")
        completion = self._extract_percentage(text)

        if budget > 0:
            projects.append(PGIProject(
                name="Projet Général",
                status="active",
                budget=budget,
                spent=spent,
                completion=completion
            ))

        return projects

    def _generate_alerts(
        self,
        projects: List[PGIProject],
        labor: List[PGILabor],
        materials: List[PGIMaterial]
    ) -> List[str]:
        """Generate alerts based on project data"""
        alerts = []

        # Budget alerts
        for project in projects:
            if project.spent > project.budget * 0.9:
                alerts.append(f"⚠️ {project.name}: Budget presque dépassé ({project.spent / project.budget * 100:.1f}%)")

            if project.status == "urgent":
                alerts.append(f"🚨 {project.name}: Projet urgent nécessite attention")

        # Labor alerts
        total_labor_hours = sum(l.hours for l in labor)
        if total_labor_hours > 200:
            alerts.append(f"⏰ Heures élevées: {total_labor_hours:.1f}h cette semaine")

        # Material alerts
        total_material_cost = sum(m.cost for m in materials)
        if total_material_cost > 50000:
            alerts.append(f"💰 Coût matériel élevé: {total_material_cost:.2f} CAD")

        return alerts
