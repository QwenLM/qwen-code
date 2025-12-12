# Guide de Démarrage Rapide 🚀

## Système d'Agents Électriques Québécois

### Installation Rapide

```bash
# 1. Aller dans le dossier
cd packages/quebec-electrical-agents

# 2. Installer dépendances Node.js
npm install

# 3. Installer dépendances Python
pip install -r python/requirements.txt

# 4. Installer Tesseract OCR
# Ubuntu/Debian:
sudo apt-get install tesseract-ocr tesseract-ocr-fra

# macOS:
brew install tesseract tesseract-lang

# 5. Créer fichier .env
cp .env.example .env

# 6. Initialiser base de connaissances FAISS
python3 python/knowledge_base.py init
```

### Démarrage Application Electron (Recommandé)

```bash
# Démarrer backend + Electron en une commande
npm run electron:dev
```

**C'est tout!** L'application s'ouvre automatiquement avec:
- Backend Node.js qui tourne en terminal (port 3000)
- WebSocket serveur (port 3001)
- Interface Electron

### Utilisation

1. **L'application Electron s'ouvre**
2. **Glissez-déposez un plan PDF** dans la zone centrale
3. **L'analyse démarre automatiquement**:
   - OCR extrait le texte
   - Vision détecte les équipements
   - Agents vérifient conformité CEQ/RBQ
   - BOM est générée automatiquement
4. **Consultez les résultats**:
   - Onglet "BOM" : Liste complète du matériel
   - Onglet "Conformité" : Audit CEQ/RBQ/RSST
   - Onglet "Chat Agent" : Posez vos questions

### Fonctionnalités Principales

#### 📊 Dashboard
- Statistiques en temps réel
- Plans analysés
- Items BOM détectés
- Taux de conformité
- Activité récente

#### 📄 Analyse de Plans
- **Drag & Drop** de plans PDF/PNG/JPG
- Détection automatique:
  - Cuisinières ≥5000W (CEQ 6-304)
  - Protection DDFT zones humides (CEQ 26-700)
  - Protection CAFCI chambres (CEQ 26-724)
  - Planchers chauffants (CEQ 62-116)

#### 📋 Génération BOM
- Liste complète du matériel
- Vérification certifications CSA/UL
- Catégories organisées
- Estimation des coûts
- Spécifications techniques

#### ✅ Conformité
- Audit CEQ (Code Électrique du Québec)
- Audit RBQ (Régie du Bâtiment)
- Audit RSST (Santé et Sécurité)
- Audit CSA (Standards Canadiens)
- Identification déficiences critiques

#### 💬 Chat avec Agent IA
- Questions sur normes québécoises
- Recherche dans base FAISS
- Réponses basées sur CEQ/RBQ/RSST
- Exemples de questions:
  - "Quel circuit pour une cuisinière de 6000W?"
  - "Où installer des DDFT?"
  - "Quelles sont les exigences pour planchers chauffants?"

### Architecture

```
┌─────────────────────┐
│  Electron Desktop   │  ← Vous êtes ici
│   (Interface GUI)   │
└──────────┬──────────┘
           │ HTTP/WebSocket
           ↓
┌─────────────────────┐
│  Backend Node.js    │  ← Tourne en terminal
│  Express + Socket.IO│
└──────────┬──────────┘
           │ spawn
           ↓
┌─────────────────────┐
│   Python Services   │
│  OCR + Vision + FAISS│
└─────────────────────┘
```

### Les 11 Agents IA

1. **Safety Agent** - Conformité RSST
2. **Site Planner** - Planification chantier RBQ
3. **Calculator** - Calculs CEQ
4. **Project Manager** - Gestion projet
5. **Diagnostician** - Tests et diagnostic
6. **Compliance QC** - Audit CEQ/RBQ/RSST/CSA
7. **Supply Manager** - BOM et matériel
8. **Training Coordinator** - Formation RSST
9. **Directive Tracker** - Veille réglementaire
10. **Material Tracker** - Traçabilité matériel
11. **Dashboard Creator** - Dashboards personnalisés

### Workflow Complet

```
1. Drag & Drop Plan PDF
   ↓
2. Upload HTTP API
   ↓
3. Analyse Python (OCR + Vision)
   - pytesseract : Extraction texte
   - OpenCV : Détection symboles
   - Patterns : Équipements québécois
   ↓
4. Coordination Agents
   - Calculator : Calcul charge
   - Supply Manager : Génération BOM
   - Safety Agent : Vérif RSST
   - Compliance : Audit CEQ/RBQ
   ↓
5. WebSocket → Electron
   - Résultats en temps réel
   - Stats mises à jour
   - BOM affichée
   - Conformité vérifiée
   ↓
6. Interface Utilisateur
   - Consultez BOM
   - Vérifiez conformité
   - Chattez avec agent
   - Exportez rapports
```

### Exemples d'Utilisation

#### Analyser un Plan Résidentiel

1. Ouvrez l'application Electron
2. Glissez votre plan PDF dans la zone dropzone
3. Attendez l'analyse (30s - 2min selon taille)
4. Consultez:
   - **BOM** : Tout le matériel nécessaire
   - **Conformité** : Vérifications CEQ/RBQ
   - **Stats** : Résumé du projet

#### Poser une Question sur Normes

1. Allez dans l'onglet "Chat Agent"
2. Tapez votre question, par exemple:
   - "Quel ampérage pour cuisinière 12000W?"
   - "Où installer CAFCI?"
   - "Exigences planchers chauffants?"
3. L'agent répond avec références CEQ/RBQ/RSST

#### Vérifier Conformité d'un Projet

1. Uploadez le plan
2. Allez dans "Conformité"
3. Consultez:
   - ✓ Standards conformes
   - ✗ Déficiences identifiées
   - Actions correctives requises

### Normes Québécoises Supportées

#### CEQ (Code Électrique du Québec)
- ✅ Section 6-304 : Cuisinières ≥5000W
- ✅ Section 26-700 : DDFT zones humides
- ✅ Section 26-724 : CAFCI chambres
- ✅ Section 62-116 : Planchers chauffants
- ✅ Section 10-700 : Mise à la terre
- ✅ Section 8-200 : Calcul de charge

#### RSST
- ✅ Article 185 : Protection chocs électriques
- ✅ Article 177 : Espaces de travail
- ✅ Articles 185-187 : Cadenassage

#### RBQ
- ✅ Permis de travaux
- ✅ Licence maître électricien
- ✅ Inspections municipales
- ✅ Formation continue

#### CSA
- ✅ Certification équipements
- ✅ Températures extrêmes (-40°C)
- ✅ Protection IP65

### Menu de l'Application

**Fichier**
- Ouvrir Plan PDF... (`Ctrl+O`)
- Nouveau Projet (`Ctrl+N`)
- Quitter (`Ctrl+Q`)

**Agents**
- Initialiser Base de Connaissances
- Statut Backend

**Aide**
- Documentation CEQ → https://www.rbq.gouv.qc.ca/
- Normes RSST → https://www.legisquebec.gouv.qc.ca/
- À propos

### Dépannage Rapide

#### Backend ne démarre pas
```bash
# Vérifier ports
lsof -i :3000
lsof -i :3001

# Redémarrer
pkill -f "tsx.*server.ts"
npm run electron:dev
```

#### WebSocket ne connecte pas
- Vérifier indicateur "WebSocket" dans header (doit être vert)
- Redémarrer l'application
- Vérifier logs backend en terminal

#### Analyse bloquée
- Vérifier que Tesseract est installé: `tesseract --version`
- Vérifier logs Python en terminal
- Taille fichier < 50MB
- Format: PDF, PNG, JPG seulement

#### FAISS erreur
```bash
# Réinitialiser
python3 python/knowledge_base.py init
```

### Build Production

```bash
# Build application distribuable
npm run electron:build

# Crée dans dist/:
# - Windows: .exe
# - macOS: .dmg
# - Linux: .AppImage, .deb
```

### Logs

```bash
# Logs application
tail -f logs/combined.log

# Logs erreurs
tail -f logs/error.log
```

### Performance

**Analyse de plan**:
- PDF 1-2 pages : ~30-60 secondes
- PDF 10 pages : ~2-5 minutes
- Image PNG : ~20-40 secondes

**Ressources**:
- Backend : ~200-500 MB RAM
- Python : ~300-800 MB RAM (avec FAISS)
- Electron : ~150-300 MB RAM

### Prochaines Étapes

1. ✅ **Analysez vos premiers plans**
2. ✅ **Explorez la BOM générée**
3. ✅ **Vérifiez la conformité**
4. ✅ **Chattez avec l'agent IA**
5. ✅ **Exportez vos rapports**

### Support

- 📧 Email: support@electrical-agents-quebec.ca
- 📚 Docs: https://docs.electrical-agents-quebec.ca
- 🐛 Issues: https://github.com/qwen-code/quebec-electrical-agents

---

**Bon travail!** ⚡🇨🇦

*Système créé par Qwen Code pour l'industrie électrique québécoise*
*Conforme CEQ • RBQ • RSST • CSA*
