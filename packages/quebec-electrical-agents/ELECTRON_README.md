# Application Electron - Agents Électriques Québécois

Application desktop pour l'analyse de plans électriques québécois avec agents IA.

## Installation

```bash
cd packages/quebec-electrical-agents

# Installer dépendances Node.js
npm install

# Installer dépendances Python
pip install -r python/requirements.txt

# Installer Tesseract OCR (requis pour OCR)
# Ubuntu/Debian:
sudo apt-get install tesseract-ocr tesseract-ocr-fra

# macOS:
brew install tesseract tesseract-lang

# Windows:
# Télécharger depuis: https://github.com/UB-Mannheim/tesseract/wiki
```

## Initialisation

```bash
# Initialiser la base de connaissances FAISS
python3 python/knowledge_base.py init

# Créer fichier .env
cp .env.example .env
```

## Démarrage

### Mode Développement

```bash
# Démarrer backend + Electron (recommandé)
npm run electron:dev
```

Cela démarre:
1. Le serveur backend Node.js (port 3000)
2. Le serveur WebSocket (port 3001)
3. L'application Electron

### Démarrage Manuel

```bash
# Terminal 1: Backend
npm run dev

# Terminal 2: Electron (attendre que backend démarre)
npm run electron
```

## Build Production

```bash
# Build TypeScript
npm run build

# Build Electron app
npm run electron:build
```

Cela créera les installateurs dans le dossier `dist/`:
- **Windows**: `.exe` (NSIS)
- **macOS**: `.dmg`
- **Linux**: `.AppImage`, `.deb`

## Fonctionnalités

### 📊 Dashboard
- Statistiques en temps réel
- Activité récente
- États de connexion

### 📄 Plans
- **Drag & Drop** de plans PDF/images
- Upload par sélection de fichier
- Analyse automatique OCR + Vision
- Détection équipements électriques

### 📋 BOM (Bill of Materials)
- Génération automatique à partir de plans
- Vérification certifications CSA/UL
- Estimation des coûts
- Export possible

### ✅ Conformité
- Audit CEQ, RBQ, RSST, CSA
- Identification des déficiences
- Actions correctives
- Rapports détaillés

### 💬 Chat Agent
- Communication avec agent IA
- Questions sur normes québécoises
- Réponses basées sur FAISS
- Temps réel via WebSocket

## Architecture

```
electron/
├── main/
│   └── index.js          # Processus principal Electron
├── preload/
│   └── preload.js        # Script preload (sécurité)
└── renderer/
    ├── index.html        # Interface HTML
    ├── styles.css        # Styles CSS
    └── app.js            # Logique JavaScript
```

### Communication

```
┌─────────────┐
│  Electron   │
│   Renderer  │
└──────┬──────┘
       │ HTTP/WebSocket
       ↓
┌─────────────┐
│  Backend    │
│  Node.js    │
└──────┬──────┘
       │ spawn
       ↓
┌─────────────┐
│   Python    │
│  OCR/FAISS  │
└─────────────┘
```

## Menu de l'Application

### Fichier
- **Ouvrir Plan PDF** (`Ctrl+O` / `Cmd+O`)
- **Nouveau Projet** (`Ctrl+N` / `Cmd+N`)
- **Quitter** (`Ctrl+Q` / `Cmd+Q`)

### Agents
- Initialiser Base de Connaissances
- Statut Backend

### Aide
- Documentation CEQ
- Normes RSST
- À propos

## Formats Supportés

### Plans Électriques
- **PDF** (recommandé)
- **PNG**
- **JPG/JPEG**

**Taille maximale:** 50MB

## Normes Québécoises

L'application vérifie la conformité aux normes:

### CEQ (Code Électrique du Québec)
- **6-304**: Cuisinières ≥5000W
- **26-700**: Protection DDFT zones humides
- **26-724**: Protection CAFCI chambres
- **62-116**: Planchers chauffants

### RSST (Santé et Sécurité du Travail)
- **Article 185**: Protection contre chocs électriques
- **Article 177**: Espaces de travail sécuritaires

### RBQ (Régie du Bâtiment du Québec)
- Permis de travaux
- Licence maître électricien
- Inspections municipales

### CSA (Canadian Standards Association)
- Certification équipements
- Températures extrêmes (-40°C à +40°C)

## Dépannage

### Backend ne démarre pas

```bash
# Vérifier que le port 3000 est libre
lsof -i :3000

# Vérifier logs
tail -f logs/combined.log
```

### WebSocket ne connecte pas

```bash
# Vérifier que le port 3001 est libre
lsof -i :3001

# Redémarrer l'application
```

### OCR ne fonctionne pas

```bash
# Vérifier installation Tesseract
tesseract --version

# Vérifier support français
tesseract --list-langs
```

### FAISS erreur

```bash
# Réinitialiser la base de connaissances
python3 python/knowledge_base.py init
```

## Développement

### Structure de Données

**appState**:
```javascript
{
  currentView: 'dashboard',
  plans: [],
  currentProject: null,
  backendConnected: false,
  wsConnected: false,
  stats: {
    plansAnalyzed: 0,
    bomItems: 0,
    issues: 0,
    compliance: 0
  }
}
```

### Événements Electron

**Main → Renderer**:
- `plan-selected`: Fichier sélectionné via menu
- `new-project`: Créer nouveau projet
- `init-knowledge-base`: Initialiser FAISS
- `check-backend-status`: Vérifier backend

**Renderer → Main** (via electronAPI):
- `selectFile()`: Ouvrir dialogue fichier
- `saveFile()`: Ouvrir dialogue sauvegarde
- `getSystemInfo()`: Info système
- `openExternal(url)`: Ouvrir URL externe

### Événements WebSocket

**Client → Serveur**:
- `user-message`: Message chat
- `analyze-plan`: Analyser plan

**Serveur → Client**:
- `agent-message`: Réponse agent
- `agent-typing`: Agent en train d'écrire
- `plan-analysis-complete`: Analyse terminée
- `analysis-error`: Erreur d'analyse
- `dashboard-update`: Mise à jour données

## Performance

### Optimisations
- Lazy loading des vues
- Limitation activité à 50 items
- Scroll virtuel pour grandes listes
- Cache Socket.IO CDN

### Mémoire
- Backend: ~200-500MB
- Python: ~300-800MB (avec FAISS)
- Electron: ~150-300MB

## Sécurité

### Content Security Policy
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self' 'unsafe-inline';
               style-src 'self' 'unsafe-inline';
               connect-src 'self' http://localhost:* ws://localhost:*">
```

### Context Isolation
- `nodeIntegration: false`
- `contextIsolation: true`
- Preload script pour APIs sécurisées

## Logs

```bash
# Logs application
tail -f logs/combined.log

# Logs erreurs uniquement
tail -f logs/error.log

# Console Electron
# Dans l'app: Affichage → Outils de développement
```

## Contribution

1. Fork le projet
2. Créer branche feature (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push (`git push origin feature/AmazingFeature`)
5. Ouvrir Pull Request

## Licence

Voir LICENSE dans la racine du projet.

## Support

- Email: support@electrical-agents-quebec.ca
- Documentation: https://docs.electrical-agents-quebec.ca
- Issues: https://github.com/qwen-code/quebec-electrical-agents/issues

---

**Version**: 0.1.0
**Dernière mise à jour**: 2025-11-18
**Électrons québécois depuis 2025** ⚡🇨🇦
