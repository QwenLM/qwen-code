# Système d'Agents Électriques Québécois

Système d'agents IA spécialisés pour l'industrie électrique québécoise, intégré dans Qwen Code.

## Vue d'ensemble

Ce package fournit 11 agents IA spécialisés pour l'analyse, la planification et la gestion de projets électriques conformes aux normes québécoises (CEQ, RBQ, RSST).

### Fonctionnalités principales

- **Analyse automatique de plans électriques** via OCR et vision par ordinateur
- **Dashboard interactif** avec glisser-déposer de plans PDF
- **Base de connaissances vectorielle** (FAISS) pour les normes québécoises
- **11 agents spécialisés** couvrant tous les aspects de projets électriques
- **Communication temps réel** via WebSocket
- **Génération automatique de BOM** (Bill of Materials)
- **Vérification de conformité** aux normes CEQ, RBQ, RSST

## Architecture

```
packages/quebec-electrical-agents/
├── src/
│   ├── agents/           # 11 agents électriques spécialisés
│   ├── services/         # Services (FAISS, OCR, vision, etc.)
│   ├── models/           # Modèles MongoDB
│   ├── controllers/      # Contrôleurs Express
│   ├── routes/           # Routes API
│   ├── middleware/       # Middleware Express
│   ├── utils/            # Utilitaires
│   ├── frontend/         # Dashboard React
│   └── server.ts         # Serveur principal
├── test/                 # Tests
└── docs/                 # Documentation
```

## Installation

```bash
cd packages/quebec-electrical-agents
npm install
```

## Utilisation

### Démarrer le serveur de développement

```bash
npm run dev
```

### Build pour production

```bash
npm run build
npm start
```

## Les 11 Agents Spécialisés

1. **Agent de sécurité électrique** - Conformité RSST
2. **Agent de planification de chantier** - Organisation des travaux
3. **Agent de calcul électrique** - Dimensionnement selon CEQ
4. **Agent de gestion de projet** - Coordination et suivi
5. **Agent de diagnostic électrique** - Analyse et détection de problèmes
6. **Agent de conformité qualité** - Vérification CEQ/RBQ
7. **Agent de gestion des approvisionnements** - Gestion de matériel
8. **Agent de formation** - Montée en compétences
9. **Agent de suivi de directive** - Respect des consignes
10. **Agent de suivi de matériel** - Inventaire et logistique
11. **Agent de création de dashboard** - Visualisation de données

## Technologies utilisées

- **Backend**: Node.js, Express, MongoDB
- **Frontend**: React, Material-UI, Socket.IO
- **IA**: FAISS (recherche vectorielle), Google AI
- **Vision**: Tesseract.js (OCR), Sharp (traitement d'image)
- **WebSocket**: Socket.IO pour communication temps réel

## Normes québécoises supportées

- **CEQ** - Code Électrique du Québec
- **RBQ** - Régie du Bâtiment du Québec
- **RSST** - Règlement sur la Santé et la Sécurité du Travail

## Workflow typique

1. L'utilisateur glisse-dépose un plan électrique PDF dans le dashboard
2. Le système extrait automatiquement le matériel via OCR/vision
3. Les agents analysent la conformité aux normes québécoises
4. Génération d'une BOM complète avec spécifications
5. Création d'un rapport de conformité détaillé
6. L'utilisateur peut interagir avec les agents via chat intégré

## Tests

```bash
# Tests unitaires
npm test

# Tests avec watch mode
npm run test:watch
```

## Documentation

Pour plus de détails, consultez la documentation dans le dossier `/quebec-electrical-agents` à la racine du projet.

## Licence

Voir LICENSE dans la racine du projet
