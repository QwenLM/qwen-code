# Système d'Agents Électriques Québécois - Vue d'ensemble

## Architecture complète du projet

### 1. Agents Électriques Spécialisés (11 agents)
- Agent de sécurité électrique (conformité RSST)
- Agent de planification de chantier
- Agent de calcul électrique et dimensionnement (selon CEQ)
- Agent de gestion de projet électrique
- Agent de diagnostic électrique
- Agent de suivi qualité et conformité (CEQ/RBQ)
- Agent de gestion des approvisionnements
- Agent de formation et montée en compétence
- Agent de suivi de directive
- Agent de suivi de matériel
- Agent de création de dashboard

### 2. Système d'analyse de plans électriques
- Reconnaissance de matériel électrique dans les plans PDF
- Utilisation d'OCR et de vision par ordinateur (OpenCV, YOLO)
- Détection de symboles électriques selon les normes québécoises
- Extraction automatique de la BOM (Bill of Materials)

### 3. Dashboard interactif avec drag & drop
- Interface utilisateur en React avec Material-UI
- Zone de glisser-déposer pour les plans PDF
- Visualiseur de plans interactif
- Intégration avec les agents électriques
- Système de chat avec les agents dans le dashboard

### 4. Base de connaissances vectorielle (FAISS)
- Système de recherche sémantique basé sur FAISS
- Base de connaissances en normes électriques québécoises
- Intégration avec tous les agents pour consultation contextuelle
- Recherche intelligente dans les normes CEQ, RSST, RBQ

### 5. Communication WebSocket
- Communication en temps réel entre le dashboard et les agents
- Notifications instantanées pour les progrès d'analyse
- Interaction directe avec les agents depuis l'interface
- Mise à jour en temps réel des états et résultats

### 6. Intégration des normes québécoises
- Conformité automatique aux normes CEQ (Code Électrique du Québec)
- Intégration des exigences RSST (Règlement sur la santé et la sécurité du travail)
- Conformité aux standards RBQ (Régie du bâtiment du Québec)
- Validation automatique selon les particularités hivernales québécoises
- Exigences spécifiques (cuisinières ≥5000W, planchers chauffants, etc.)

### 7. Architecture complète
- Backend Node.js/Express avec MongoDB
- Frontend React avec state management
- Système de gestion de fichier sécurisé
- Authentification et autorisation RBAC
- Journalisation et surveillance des performances

### 8. Tests complets
- Tests avec des plans électriques québécois réels
- Validation de la conformité CEQ sur différents types de projets
- Tests d'intégration pour maison unifamiliale, bureau commercial, usine industrielle, complexe d'appartements
- Vérification automatique des exigences normatives

Le système complet permet à un utilisateur de simplement glisser-déposer un plan électrique PDF dans le dashboard, puis tous les agents spécialisés travaillent ensemble pour :
1. Extraire le matériel électrique du plan
2. Vérifier la conformité aux normes québécoises
3. Générer une BOM complète
4. Créer un rapport de conformité détaillé
5. Fournir des recommandations spécifiques
6. Interagir directement avec l'utilisateur via le chat intégré

Tout cela en respectant strictement les normes et pratiques électriques québécoises (CEQ, RSST, RBQ) et en tenant compte des conditions particulières propres au Québec (températures hivernales, types d'installations spécifiques, etc.).