# Structure du Backend - Système d'agents électriques québécois

## Répertoire principal
```
backend/
├── src/
│   ├── services/
│   │   ├── faissService.js          # Service principal FAISS
│   │   ├── embeddingService.js      # Service de génération d'embeddings
│   │   ├── knowledgeBaseService.js  # Service de gestion de la base de connaissances
│   │   ├── quebecStandardsService.js # Service spécifique aux normes québécoises
│   │   ├── materialRecognitionService.js # Service de reconnaissance de matériel
│   │   ├── cvService.js             # Service de vision par ordinateur
│   │   ├── symbolDetectorService.js # Service de détection de symboles
│   │   ├── ocrService.js            # Service OCR
│   │   ├── electricalCatalogService.js # Service de catalogue électrique
│   │   └── socketService.js         # Service de gestion WebSocket
│   ├── models/
│   │   ├── KnowledgeChunk.js        # Modèle pour les fragments de connaissances
│   │   ├── DetectedEquipment.js     # Modèle pour les équipements détectés
│   │   ├── QuebecStandard.js        # Modèle pour les normes québécoises
│   │   ├── ComplianceCheck.js       # Modèle pour les vérifications de conformité
│   │   ├── QuebecEquipment.js       # Modèle pour les équipements certifiés
│   │   └── Plan.js                  # Modèle pour les plans électriques
│   ├── controllers/
│   │   ├── knowledgeController.js   # Contrôleur pour les requêtes de connaissance
│   │   ├── planController.js        # Contrôleur pour la gestion des plans
│   │   ├── uploadController.js      # Contrôleur pour les uploads
│   │   └── quebecStandardsController.js # Contrôleur pour les normes québécoises
│   ├── routes/
│   │   ├── knowledge.js             # Routes pour la base de connaissances
│   │   ├── plans.js                 # Routes pour la gestion des plans
│   │   ├── upload.js                # Routes pour les uploads
│   │   └── quebecStandards.js       # Routes pour les normes québécoises
│   ├── middleware/
│   │   ├── dragDropUpload.js        # Middleware pour le traitement des uploads
│   │   └── auth.js                  # Middleware d'authentification
│   └── utils/
│       ├── quebecStandards.js       # Utilitaires pour les normes québécoises
│       ├── pdfUtils.js              # Utilitaires pour la manipulation de PDF
│       └── socketUtils.js           # Utilitaires pour WebSocket
├── uploads/
│   ├── plans/                       # Répertoire pour les plans uploadés
│   └── temp/                        # Répertoire temporaire
├── data/
│   ├── knowledge_index.faiss        # Index FAISS pour la base de connaissances
│   └── knowledge_metadata.json      # Métadonnées pour l'index FAISS
└── package.json                     # Dépendances du projet
```