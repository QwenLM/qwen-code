# Architecture - Système d'Agents Électriques Québécois

## Vue d'ensemble

Système complet d'agents IA pour l'industrie électrique québécoise, intégrant analyse de plans, génération de BOM, vérification de conformité CEQ/RBQ/RSST, et dashboard interactif avec communication temps réel.

## Architecture Globale

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend Dashboard (React)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ Plan Viewer  │  │ BOM Generator│  │ Compliance   │         │
│  │ (Drag&Drop)  │  │              │  │ Dashboard    │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ Chat Agent   │  │ Metrics      │  │ Project      │         │
│  │ Interface    │  │ Realtime     │  │ Timeline     │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└────────────────────────┬────────────────────────────────────────┘
                         │ WebSocket (Socket.IO)
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│                  Backend Services (Node.js/Express)              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           Orchestration Service (Coordinator)             │  │
│  │  - Workflow Management                                    │  │
│  │  - Agent Coordination                                     │  │
│  │  - Real-time Updates                                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                        │
│         ┌───────────────┼───────────────┐                      │
│         ↓               ↓               ↓                      │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐             │
│  │Plan Analyzer│ │Quebec KB    │ │Agent Manager│             │
│  │Service      │ │Service      │ │Service      │             │
│  │(TS→Python)  │ │(TS→Python)  │ │             │             │
│  └─────────────┘ └─────────────┘ └─────────────┘             │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ↓               ↓               ↓
┌─────────────────┐ ┌────────────┐ ┌────────────┐
│  Python Layer   │ │  Database  │ │  Storage   │
│  - OCR          │ │  MongoDB   │ │  MinIO/S3  │
│  - CV (OpenCV)  │ │  Metadata  │ │  Plans PDF │
│  - FAISS KB     │ │  Projects  │ │  Images    │
│  - ML Models    │ │  Materials │ │  Reports   │
└─────────────────┘ └────────────┘ └────────────┘
```

## Composants Principaux

### 1. Frontend (React + TypeScript)

**Technologies:**
- React 18
- TypeScript
- Material-UI (MUI)
- Chart.js / D3.js
- Socket.IO Client
- React-PDF
- react-dropzone

**Fonctionnalités:**
- Drag & Drop de plans PDF
- Visualisation temps réel
- Chat avec agents IA
- Dashboards personnalisés
- Génération de rapports

### 2. Backend Services (Node.js + Express)

**Services Principaux:**

#### OrchestrationService
- Coordonne tous les agents
- Gère le workflow complet
- WebSocket pour temps réel
- File: `src/services/orchestration-service.ts`

#### PlanAnalyzerService
- Interface TypeScript → Python
- Appelle le script Python d'analyse
- Gère conversion PDF → images
- File: `src/services/plan-analyzer-service.ts`

#### QuebecStandardsService
- Interface avec base FAISS
- Recherche dans normes CEQ/RBQ/RSST
- Génération de guides conformité
- File: `src/services/quebec-standards-service.ts`

### 3. Les 11 Agents Électriques

**1. ElectricalSafetyAgent** (`electrical-safety-agent.ts`)
- Conformité RSST
- Vérification sécurité
- DDFT/GFCI
- Mise à la terre

**2. SitePlannerAgent** (`site-planner-agent.ts`)
- Planification chantier
- Permis RBQ
- Échéancier
- Conditions hivernales

**3. ElectricalCalculatorAgent** (`electrical-calculator-agent.ts`)
- Calculs de charge
- Dimensionnement CEQ
- Chute de tension
- Services requis

**4. ProjectManagerAgent** (`project-manager-agent.ts`)
- Gestion de projet
- Budget/Timeline
- Équipe/Ressources
- Rapports RBQ

**5. DiagnosticianAgent** (`diagnostician-agent.ts`)
- Diagnostic électrique
- Tests conformité
- Analyse thermique
- Recommandations

**6. ComplianceQCAgent** (`compliance-qc-agent.ts`)
- Audit CEQ/RBQ/RSST/CSA
- Déficiences
- Rapports conformité
- Certification

**7. SupplyManagerAgent** (`supply-manager-agent.ts`)
- Génération BOM
- Gestion inventaire
- Certifications CSA/UL
- Commandes matériel

**8. TrainingCoordinatorAgent** (`training-coordinator-agent.ts`)
- Besoins formation
- Programmes RSST
- Certifications
- Formation continue RBQ

**9. DirectiveTrackerAgent** (`directive-tracker-agent.ts`)
- Suivi directives
- Veille réglementaire
- Conformité projets
- Alertes changements

**10. MaterialTrackerAgent** (`material-tracker-agent.ts`)
- Traçabilité matériel
- Certifications
- Mouvements
- Audits

**11. DashboardCreatorAgent** (`dashboard-creator-agent.ts`)
- Création dashboards
- Widgets personnalisés
- Chat interface
- Code React généré

### 4. Python Layer

**plan_analyzer.py**
- OCR avec pytesseract
- Vision avec OpenCV
- Détection symboles électriques
- Extraction spécifications
- Analyse québécoise (5000W stove, DDFT, etc.)

**knowledge_base.py**
- FAISS vector database
- Sentence transformers
- Indexation CEQ/RBQ/RSST/CSA
- Recherche sémantique
- Filtrage par source/catégorie

**Dépendances Python:**
```
pytesseract
opencv-python
PyMuPDF
faiss-cpu
sentence-transformers
numpy
Pillow
```

### 5. Base de Données

**MongoDB Collections:**
- `plans` - Plans électriques analysés
- `projects` - Projets électriques
- `equipment` - Équipements détectés
- `materials` - Inventaire matériel
- `compliance_audits` - Audits conformité
- `directives` - Directives actives
- `training_sessions` - Sessions formation

**FAISS Index:**
- `knowledge_index.faiss` - Index vectoriel
- `knowledge_metadata.pkl` - Métadonnées normes

## Workflow Principal

### Workflow Complet: PDF → Dashboard

```
1. Upload PDF Plan
   ↓
2. PlanAnalyzerService
   - Conversion PDF → Images (300 DPI)
   - OCR extraction texte (pytesseract)
   - CV détection symboles (OpenCV)
   - Identification équipements spéciaux Québec
   ↓
3. ElectricalCalculatorAgent
   - Calcul charge totale (CEQ 8-200)
   - Dimensionnement service
   - Circuits cuisinière ≥5000W
   ↓
4. SupplyManagerAgent
   - Génération BOM complète
   - Vérification certifications CSA/UL
   - Estimation coûts
   ↓
5. ElectricalSafetyAgent
   - Vérification RSST
   - DDFT/GFCI requis
   - Mise à la terre
   ↓
6. ComplianceQCAgent
   - Audit CEQ/RBQ/RSST/CSA
   - Déficiences critiques/majeures/mineures
   - Rapport conformité
   ↓
7. DirectiveTrackerAgent
   - Vérification directives actives
   - Conformité normes récentes
   ↓
8. SitePlannerAgent
   - Plan de chantier
   - Phases travaux
   - Permis RBQ
   ↓
9. DashboardCreatorAgent
   - Génération dashboard personnalisé
   - Widgets selon rôle utilisateur
   - Chat interface
   ↓
10. Résultats Dashboard
   - BOM complète
   - Rapport conformité
   - Plan chantier
   - Interface chat temps réel
```

## Normes Québécoises Supportées

### CEQ (Code Électrique du Québec)

**Sections Clés:**
- **6-304**: Cuisinières ≥5000W - Circuit dédié 40A
- **26-700**: Protection DDFT zones humides
- **26-724**: Protection CAFCI chambres
- **62-116**: Planchers chauffants électriques
- **10-700**: Mise à la terre
- **8-200**: Calcul de charge résidentielle
- **Table 2**: Dimensionnement conducteurs

### RSST (Santé et Sécurité du Travail)

**Articles Clés:**
- **185**: Protection contre chocs électriques
- **177**: Espaces de travail sécuritaires
- **185-187**: Cadenassage équipements

### RBQ (Régie du Bâtiment du Québec)

**Exigences:**
- Licence maître électricien obligatoire
- Permis de travaux
- Inspection municipale
- Formation continue 8h/an

### CSA (Canadian Standards Association)

**Standards:**
- C22.1: Certification équipements
- Équipements extérieurs: -40°C à +40°C
- Protection IP65 minimum
- Câbles NMD90 (Loomex)

## Spécificités Québécoises

### 1. Conditions Climatiques
- Températures: -40°C à +40°C
- Équipements certifiés froid extrême
- Protection gel/glace
- Chauffage anti-gel panneaux

### 2. Équipements Spéciaux
- **Cuisinière ≥5000W**: Circuit dédié 40A (CEQ 6-304)
- **Planchers chauffants**: Thermostat + sonde (CEQ 62-116)
- **DDFT**: Salles de bain, cuisine, extérieur, garage
- **CAFCI**: Toutes chambres à coucher

### 3. Processus RBQ
1. Demande permis municipal
2. Travaux par maître électricien licencié
3. Inspection intermédiaire (câblage)
4. Tests conformité
5. Inspection finale municipale
6. Certificat conformité RBQ
7. Mise sous tension autorisée

## Communication Temps Réel

### WebSocket Events

**Client → Server:**
```typescript
socket.emit('user-message', { message, context })
socket.emit('analyze-plan', { planId, filename })
socket.emit('request-bom', { projectId })
```

**Server → Client:**
```typescript
socket.on('agent-message', (message) => { })
socket.on('agent-typing', (isTyping) => { })
socket.on('plan-analysis-complete', (result) => { })
socket.on('dashboard-update', (data) => { })
socket.on('compliance-alert', (alert) => { })
```

## API Endpoints

### Plans
- `POST /api/plans/upload` - Upload plan PDF
- `GET /api/plans/:id` - Récupérer plan
- `POST /api/agents/analyze` - Déclencher analyse

### Projets
- `GET /api/projects/status` - Statut projets
- `POST /api/projects/create` - Créer projet
- `PUT /api/projects/:id` - Mettre à jour

### Conformité
- `GET /api/compliance/summary` - Résumé conformité
- `POST /api/compliance/audit` - Audit complet
- `GET /api/directives/active` - Directives actives

### Matériel
- `GET /api/materials/inventory` - Inventaire
- `GET /api/bom/:projectId` - BOM projet
- `POST /api/materials/receive` - Réception matériel

### Chat
- `POST /api/chat/message` - Message agent
- `GET /api/chat/history/:projectId` - Historique

## Sécurité

### Authentification
- JWT tokens
- Role-based access control (RBAC)
- Maître électricien, Compagnon, Apprenti, Gestionnaire

### Validation
- Joi schemas pour toutes les entrées
- Validation fichiers PDF (type, taille)
- Sanitization des données

### Données Sensibles
- Certificats RBQ chiffrés
- Données projet confidentielles
- Logs d'audit

## Déploiement

### Docker Compose

```yaml
services:
  backend:
    build: ./backend
    ports: ["3000:3000"]
    environment:
      - MONGODB_URI
      - REDIS_URL
    depends_on:
      - mongodb
      - redis

  python-services:
    build: ./python
    volumes:
      - ./data:/app/data

  mongodb:
    image: mongo:6

  redis:
    image: redis:7

  frontend:
    build: ./frontend
    ports: ["80:80"]
```

### Kubernetes

- Pods pour backend, Python, frontend
- Services pour communication interne
- Ingress pour exposition externe
- ConfigMaps pour configuration
- Secrets pour credentials
- Persistent volumes pour FAISS/MongoDB

## Monitoring et Logs

### Logging
- Winston (Node.js)
- Niveaux: error, warn, info, debug
- Rotation des logs
- Logs centralisés (ELK stack)

### Métriques
- Temps d'analyse de plans
- Taux de conformité
- Utilisation agents
- Performance FAISS

### Alertes
- Non-conformités critiques
- Erreurs système
- Certifications expirantes
- Directives nouvelles

## Évolutions Futures

### Phase 2
- Modèle YOLO custom pour symboles électriques québécois
- Reconnaissance automatique marques CSA/UL
- Intégration CAD pour plans 3D
- Mobile app (iOS/Android)

### Phase 3
- IA générative pour conception plans
- Optimisation automatique layouts
- Simulation charge/consommation
- Intégration ERP/CRM

### Phase 4
- AR (Réalité Augmentée) pour installation
- IoT monitoring installations
- Prédiction maintenance
- Blockchain pour certifications

## Support et Documentation

### Documentation
- README.md - Guide démarrage
- ARCHITECTURE.md - Ce document
- API_DOCS.md - Documentation API
- DEPLOYMENT.md - Guide déploiement

### Ressources
- Code Électrique du Québec: https://www.rbq.gouv.qc.ca/
- RSST: https://www.legisquebec.gouv.qc.ca/
- CSA: https://www.csagroup.org/
- Hydro-Québec: https://www.hydroquebec.com/

### Contact
- Email: support@electrical-agents-quebec.ca
- Documentation: https://docs.electrical-agents-quebec.ca
- GitHub: https://github.com/qwen-code/quebec-electrical-agents

---

**Version**: 0.1.0
**Dernière mise à jour**: 2025-11-18
**Auteur**: Équipe Qwen Code - Agents Électriques Québécois
