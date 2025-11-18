# Système d'Agents Électriques Québécois ⚡🇨🇦

Application desktop complète avec 11 agents IA spécialisés pour l'industrie électrique québécoise, conforme aux normes CEQ, RBQ, RSST et CSA.

## 🚀 Démarrage Rapide

```bash
cd packages/quebec-electrical-agents
npm install
pip install -r python/requirements.txt
npm run electron:dev
```

**C'est tout!** L'application Electron s'ouvre avec backend intégré.

📖 **Guide complet**: Voir [QUICK_START.md](QUICK_START.md)

## Vue d'ensemble

Application desktop professionnelle avec interface graphique moderne qui permet:
- 📄 **Analyse automatique de plans PDF** via OCR et vision par ordinateur
- 📋 **Génération de BOM** avec vérification certifications CSA/UL
- ✅ **Audit de conformité** CEQ, RBQ, RSST, CSA
- 💬 **Chat IA temps réel** pour questions sur normes québécoises
- 🎯 **Drag & Drop** de plans directement dans l'interface
- 📊 **Dashboard interactif** avec statistiques en direct

### Fonctionnalités principales

- **Analyse automatique de plans électriques** via OCR et vision par ordinateur
- **Dashboard interactif** avec glisser-déposer de plans PDF
- **Base de connaissances vectorielle** (FAISS) pour les normes québécoises
- **11 agents spécialisés** couvrant tous les aspects de projets électriques
- **Communication temps réel** via WebSocket
- **Génération automatique de BOM** (Bill of Materials)
- **Vérification de conformité** aux normes CEQ, RBQ, RSST

## 🎨 Interface

### Application Electron Desktop

Interface moderne avec:
- **Dashboard** : Stats en temps réel, drag & drop
- **Plans** : Tous vos plans analysés
- **BOM** : Liste complète du matériel nécessaire
- **Conformité** : Audit CEQ/RBQ/RSST/CSA
- **Chat Agent** : Questions sur normes québécoises

### Backend Terminal

Le backend Node.js tourne en terminal avec:
- Express API (port 3000)
- WebSocket serveur (port 3001)
- Orchestration des 11 agents IA
- Interface avec Python (OCR, Vision, FAISS)

## 📦 Structure du Projet

```
packages/quebec-electrical-agents/
├── electron/              # Application Electron
│   ├── main/             # Processus principal
│   ├── preload/          # Script preload
│   └── renderer/         # Interface utilisateur
├── src/                  # Backend Node.js
│   ├── agents/           # 11 agents spécialisés
│   ├── services/         # Services (orchestration, FAISS, etc.)
│   ├── utils/            # Utilitaires
│   └── server.ts         # Serveur Express principal
├── python/               # Services Python
│   ├── plan_analyzer.py  # OCR + Vision
│   ├── knowledge_base.py # FAISS
│   └── requirements.txt  # Dépendances
└── docs/                 # Documentation
```

## 💻 Modes de Démarrage

### Mode Electron (Recommandé)

```bash
# Backend + Electron en une commande
npm run electron:dev
```

### Mode Backend Seul

```bash
# Pour développement backend ou intégration
npm run dev
```

### Mode Production

```bash
npm run build
npm start
```

### Build Application Distribuable

```bash
npm run electron:build
# Crée: .exe (Windows), .dmg (macOS), .AppImage (Linux)
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

## 🛠 Technologies

### Desktop
- **Electron** 28 - Application desktop cross-platform
- **Interface** - HTML5, CSS3, JavaScript moderne
- **Design** - Dark theme professionnel

### Backend
- **Node.js** + Express - Serveur API REST
- **Socket.IO** - Communication temps réel WebSocket
- **TypeScript** - Type-safe codebase

### Python
- **pytesseract** - OCR extraction texte
- **OpenCV** - Vision par ordinateur
- **FAISS** - Base de connaissances vectorielle
- **sentence-transformers** - Embeddings multilingues

### Base de Données
- **FAISS** - Recherche vectorielle normes québécoises
- **MongoDB** - Données projets (optionnel)
- **File System** - Plans PDF et résultats

## Normes québécoises supportées

- **CEQ** - Code Électrique du Québec
- **RBQ** - Régie du Bâtiment du Québec
- **RSST** - Règlement sur la Santé et la Sécurité du Travail
- **CSA** - Canadian Standards Association

## 🔄 Workflow Complet

```
1. Drag & Drop Plan PDF dans Electron
   ↓
2. Upload via HTTP API
   ↓
3. Analyse Python
   - OCR : Extraction texte (pytesseract)
   - Vision : Détection symboles (OpenCV)
   - Patterns : Équipements spécifiques Québec
   ↓
4. Orchestration des 11 Agents
   - Calculator : Calcul charge électrique CEQ
   - Supply Manager : Génération BOM
   - Safety Agent : Vérification RSST
   - Compliance : Audit CEQ/RBQ/RSST/CSA
   - Autres agents : Planification, diagnostic, etc.
   ↓
5. WebSocket → Electron (temps réel)
   - BOM générée automatiquement
   - Conformité vérifiée
   - Stats mises à jour
   - Chat disponible
   ↓
6. Interface Utilisateur
   - Consultez BOM détaillée
   - Vérifiez conformité par norme
   - Chattez avec agent IA
   - Exportez rapports
```

## 🎯 Cas d'Usage

### 1. Analyser Plan Résidentiel
- Drag & drop PDF
- BOM générée automatiquement
- Vérification conformité CEQ
- Détection cuisinière ≥5000W, DDFT, CAFCI

### 2. Vérifier Conformité Projet
- Upload plan existant
- Audit complet CEQ/RBQ/RSST
- Identification déficiences
- Actions correctives suggérées

### 3. Questions sur Normes
- Chat avec agent IA
- Recherche dans base FAISS
- Réponses avec références CEQ/RBQ/RSST
- Exemples concrets québécois

## Tests

```bash
# Tests unitaires
npm test

# Tests avec watch mode
npm run test:watch
```

## 📚 Documentation

- **[QUICK_START.md](QUICK_START.md)** - Guide de démarrage en 5 minutes
- **[ELECTRON_README.md](ELECTRON_README.md)** - Documentation application Electron
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Architecture complète du système
- **[README.md](README.md)** - Ce fichier

## 🤝 Contribution

1. Fork le projet
2. Créer branche (`git checkout -b feature/AmazingFeature`)
3. Commit (`git commit -m 'Add AmazingFeature'`)
4. Push (`git push origin feature/AmazingFeature`)
5. Ouvrir Pull Request

## 📄 Licence

Voir LICENSE dans la racine du projet

## 📞 Support

- Email: support@electrical-agents-quebec.ca
- Docs: https://docs.electrical-agents-quebec.ca
- Issues: https://github.com/qwen-code/quebec-electrical-agents

---

**Développé avec ⚡ pour l'industrie électrique québécoise**

*Conforme CEQ • RBQ • RSST • CSA depuis 2025* 🇨🇦
