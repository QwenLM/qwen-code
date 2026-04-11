/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Traductions françaises pour Qwen Code CLI

export default {
  // ============================================================================
  // Aide / Composants UI
  // ============================================================================
  '↑ to manage attachments': '↑ pour gérer les pièces jointes',
  '← → select, Delete to remove, ↓ to exit':
    '← → sélectionner, Suppr pour retirer, ↓ pour quitter',
  'Attachments: ': 'Pièces jointes : ',

  'Basics:': 'Bases :',
  'Add context': 'Ajouter du contexte',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    'Utilisez {{symbol}} pour spécifier des fichiers de contexte (ex. {{example}}) pour cibler des fichiers ou dossiers spécifiques.',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Mode shell',
  'YOLO mode': 'Mode YOLO',
  'plan mode': 'mode plan',
  'auto-accept edits': 'acceptation automatique des modifications',
  'Accepting edits': 'Acceptation des modifications',
  '(shift + tab to cycle)': '(maj + tab pour cycler)',
  '(tab to cycle)': '(tab pour cycler)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    'Exécutez des commandes shell via {{symbol}} (ex. {{example1}}) ou utilisez le langage naturel (ex. {{example2}}).',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'démarrer le serveur',
  'Commands:': 'Commandes :',
  'shell command': 'commande shell',
  'Model Context Protocol command (from external servers)':
    'Commande Model Context Protocol (depuis des serveurs externes)',
  'Keyboard Shortcuts:': 'Raccourcis clavier :',
  'Toggle this help display': 'Afficher/masquer cette aide',
  'Toggle shell mode': 'Basculer le mode shell',
  'Open command menu': 'Ouvrir le menu des commandes',
  'Add file context': 'Ajouter un contexte de fichier',
  'Accept suggestion / Autocomplete': 'Accepter la suggestion / Autocomplétion',
  'Reverse search history': "Recherche inversée dans l'historique",
  'Press ? again to close': 'Appuyez à nouveau sur ? pour fermer',
  'for shell mode': 'pour le mode shell',
  'for commands': 'pour les commandes',
  'for file paths': 'pour les chemins de fichiers',
  'to clear input': "pour effacer l'entrée",
  'to cycle approvals': 'pour cycler les approbations',
  'to quit': 'pour quitter',
  'for newline': 'pour une nouvelle ligne',
  'to clear screen': "pour effacer l'écran",
  'to search history': "pour rechercher dans l'historique",
  'to paste images': 'pour coller des images',
  'for external editor': 'pour un éditeur externe',
  'Jump through words in the input': "Sauter de mot en mot dans l'entrée",
  'Close dialogs, cancel requests, or quit application':
    "Fermer les boîtes de dialogue, annuler les requêtes ou quitter l'application",
  'New line': 'Nouvelle ligne',
  'New line (Alt+Enter works for certain linux distros)':
    'Nouvelle ligne (Alt+Entrée fonctionne sur certaines distributions Linux)',
  'Clear the screen': "Effacer l'écran",
  'Open input in external editor': "Ouvrir l'entrée dans un éditeur externe",
  'Send message': 'Envoyer le message',
  'Initializing...': 'Initialisation...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    'Connexion aux serveurs MCP... ({{connected}}/{{total}})',
  'Type your message or @path/to/file':
    'Tapez votre message ou @chemin/vers/fichier',
  '? for shortcuts': '? pour les raccourcis',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "Appuyez sur 'i' pour le mode INSERTION et 'Échap' pour le mode NORMAL.",
  'Cancel operation / Clear input (double press)':
    "Annuler l'opération / Effacer l'entrée (double appui)",
  'Cycle approval modes': "Cycler les modes d'approbation",
  'Cycle through your prompt history': "Parcourir l'historique des invites",
  'For a full list of shortcuts, see {{docPath}}':
    'Pour la liste complète des raccourcis, voir {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': "pour l'aide de Qwen Code",
  'show version info': 'afficher les informations de version',
  'submit a bug report': 'soumettre un rapport de bogue',
  'About Qwen Code': 'À propos de Qwen Code',
  Status: 'Statut',

  // ============================================================================
  // Informations système
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: 'Environnement',
  OS: 'OS',
  Auth: 'Auth',
  'CLI Version': 'Version CLI',
  'Git Commit': 'Commit Git',
  Model: 'Modèle',
  'Fast Model': 'Modèle rapide',
  Sandbox: 'Bac à sable',
  'OS Platform': 'Plateforme OS',
  'OS Arch': 'Architecture OS',
  'OS Release': 'Version OS',
  'Node.js Version': 'Version Node.js',
  'NPM Version': 'Version NPM',
  'Session ID': 'ID de session',
  'Auth Method': "Méthode d'authentification",
  'Base URL': 'URL de base',
  Proxy: 'Proxy',
  'Memory Usage': 'Utilisation mémoire',
  'IDE Client': 'Client IDE',

  // ============================================================================
  // Commandes - Général
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Analyse le projet et crée un fichier QWEN.md personnalisé.',
  'List available Qwen Code tools. Usage: /tools [desc]':
    'Lister les outils Qwen Code disponibles. Utilisation : /tools [desc]',
  'List available skills.': 'Lister les compétences disponibles.',
  'Available Qwen Code CLI tools:': 'Outils Qwen Code CLI disponibles :',
  'No tools available': 'Aucun outil disponible',
  'View or change the approval mode for tool usage':
    "Voir ou modifier le mode d'approbation pour l'utilisation des outils",
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    'Mode d\'approbation invalide "{{arg}}". Modes valides : {{modes}}',
  'Approval mode set to "{{mode}}"':
    'Mode d\'approbation défini sur "{{mode}}"',
  'View or change the language setting':
    'Voir ou modifier le paramètre de langue',
  'change the theme': 'changer le thème',
  'Select Theme': 'Sélectionner un thème',
  Preview: 'Aperçu',
  '(Use Enter to select, Tab to configure scope)':
    '(Utilisez Entrée pour sélectionner, Tab pour configurer la portée)',
  '(Use Enter to apply scope, Tab to go back)':
    '(Utilisez Entrée pour appliquer la portée, Tab pour revenir)',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    'Configuration du thème indisponible en raison de la variable d\'environnement NO_COLOR.',
  'Theme "{{themeName}}" not found.': 'Thème "{{themeName}}" introuvable.',
  'Theme "{{themeName}}" not found in selected scope.':
    'Thème "{{themeName}}" introuvable dans la portée sélectionnée.',
  'Clear conversation history and free up context':
    "Effacer l'historique de conversation et libérer le contexte",
  'Compresses the context by replacing it with a summary.':
    'Compresse le contexte en le remplaçant par un résumé.',
  'open full Qwen Code documentation in your browser':
    'ouvrir la documentation complète de Qwen Code dans votre navigateur',
  'Configuration not available.': 'Configuration non disponible.',
  'change the auth method': "changer la méthode d'authentification",
  'Configure authentication information for login':
    "Configurer les informations d'authentification pour la connexion",
  'Copy the last result or code snippet to clipboard':
    'Copier le dernier résultat ou extrait de code dans le presse-papiers',

  // ============================================================================
  // Commandes - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    'Gérer les sous-agents pour la délégation de tâches spécialisées.',
  'Manage existing subagents (view, edit, delete).':
    'Gérer les sous-agents existants (voir, modifier, supprimer).',
  'Create a new subagent with guided setup.':
    'Créer un nouveau sous-agent avec configuration guidée.',

  // ============================================================================
  // Agents - Boîte de dialogue de gestion
  // ============================================================================
  Agents: 'Agents',
  'Choose Action': 'Choisir une action',
  'Edit {{name}}': 'Modifier {{name}}',
  'Edit Tools: {{name}}': 'Modifier les outils : {{name}}',
  'Edit Color: {{name}}': 'Modifier la couleur : {{name}}',
  'Delete {{name}}': 'Supprimer {{name}}',
  'Unknown Step': 'Étape inconnue',
  'Esc to close': 'Échap pour fermer',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Entrée pour sélectionner, ↑↓ pour naviguer, Échap pour fermer',
  'Esc to go back': 'Échap pour revenir',
  'Enter to confirm, Esc to cancel': 'Entrée pour confirmer, Échap pour annuler',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Entrée pour sélectionner, ↑↓ pour naviguer, Échap pour revenir',
  'Enter to submit, Esc to go back': 'Entrée pour soumettre, Échap pour revenir',
  'Invalid step: {{step}}': 'Étape invalide : {{step}}',
  'No subagents found.': 'Aucun sous-agent trouvé.',
  "Use '/agents create' to create your first subagent.":
    "Utilisez '/agents create' pour créer votre premier sous-agent.",
  '(built-in)': '(intégré)',
  '(overridden by project level agent)':
    '(remplacé par un agent au niveau du projet)',
  'Project Level ({{path}})': 'Niveau projet ({{path}})',
  'User Level ({{path}})': 'Niveau utilisateur ({{path}})',
  'Built-in Agents': 'Agents intégrés',
  'Extension Agents': "Agents d'extension",
  'Using: {{count}} agents': 'Utilisation : {{count}} agents',
  'View Agent': "Voir l'agent",
  'Edit Agent': "Modifier l'agent",
  'Delete Agent': "Supprimer l'agent",
  Back: 'Retour',
  'No agent selected': 'Aucun agent sélectionné',
  'File Path: ': 'Chemin du fichier : ',
  'Tools: ': 'Outils : ',
  'Color: ': 'Couleur : ',
  'Description:': 'Description :',
  'System Prompt:': 'Invite système :',
  'Open in editor': "Ouvrir dans l'éditeur",
  'Edit tools': 'Modifier les outils',
  'Edit color': 'Modifier la couleur',
  '❌ Error:': '❌ Erreur :',
  'Are you sure you want to delete agent "{{name}}"?':
    'Êtes-vous sûr de vouloir supprimer l\'agent "{{name}}" ?',

  // ============================================================================
  // Agents - Assistant de création
  // ============================================================================
  'Project Level (.qwen/agents/)': 'Niveau projet (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': 'Niveau utilisateur (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!': '✅ Sous-agent créé avec succès !',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    'Le sous-agent "{{name}}" a été enregistré au niveau {{level}}.',
  'Name: ': 'Nom : ',
  'Location: ': 'Emplacement : ',
  '❌ Error saving subagent:': '❌ Erreur lors de la sauvegarde du sous-agent :',
  'Warnings:': 'Avertissements :',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    'Le nom "{{name}}" existe déjà au niveau {{level}} - le sous-agent existant sera écrasé',
  'Name "{{name}}" exists at user level - project level will take precedence':
    'Le nom "{{name}}" existe au niveau utilisateur - le niveau projet aura la priorité',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    'Le nom "{{name}}" existe au niveau projet - le sous-agent existant aura la priorité',
  'Description is over {{length}} characters':
    'La description dépasse {{length}} caractères',
  'System prompt is over {{length}} characters':
    "L'invite système dépasse {{length}} caractères",
  'Step {{n}}: Choose Location': 'Étape {{n}} : Choisir l\'emplacement',
  'Step {{n}}: Choose Generation Method':
    'Étape {{n}} : Choisir la méthode de génération',
  'Generate with Qwen Code (Recommended)':
    'Générer avec Qwen Code (Recommandé)',
  'Manual Creation': 'Création manuelle',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    'Décrivez ce que ce sous-agent doit faire et quand il doit être utilisé. (Soyez complet pour de meilleurs résultats)',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    'ex. Réviseur de code expert qui révise le code selon les meilleures pratiques...',
  'Generating subagent configuration...':
    'Génération de la configuration du sous-agent...',
  'Failed to generate subagent: {{error}}':
    'Échec de la génération du sous-agent : {{error}}',
  'Step {{n}}: Describe Your Subagent':
    'Étape {{n}} : Décrire votre sous-agent',
  'Step {{n}}: Enter Subagent Name':
    'Étape {{n}} : Entrer le nom du sous-agent',
  'Step {{n}}: Enter System Prompt':
    "Étape {{n}} : Entrer l'invite système",
  'Step {{n}}: Enter Description': 'Étape {{n}} : Entrer la description',
  'Step {{n}}: Select Tools': 'Étape {{n}} : Sélectionner les outils',
  'All Tools (Default)': 'Tous les outils (par défaut)',
  'All Tools': 'Tous les outils',
  'Read-only Tools': 'Outils en lecture seule',
  'Read & Edit Tools': 'Outils lecture et édition',
  'Read & Edit & Execution Tools': "Outils lecture, édition et exécution",
  'All tools selected, including MCP tools':
    'Tous les outils sélectionnés, y compris les outils MCP',
  'Selected tools:': 'Outils sélectionnés :',
  'Read-only tools:': 'Outils en lecture seule :',
  'Edit tools:': "Outils d'édition :",
  'Execution tools:': "Outils d'exécution :",
  'Step {{n}}: Choose Background Color':
    "Étape {{n}} : Choisir la couleur d'arrière-plan",
  'Step {{n}}: Confirm and Save': 'Étape {{n}} : Confirmer et enregistrer',
  'Esc to cancel': 'Échap pour annuler',
  'Press Enter to save, e to save and edit, Esc to go back':
    'Appuyez sur Entrée pour enregistrer, e pour enregistrer et modifier, Échap pour revenir',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    'Appuyez sur Entrée pour continuer, {{navigation}}Échap pour {{action}}',
  cancel: 'annuler',
  'go back': 'revenir',
  '↑↓ to navigate, ': '↑↓ pour naviguer, ',
  'Enter a clear, unique name for this subagent.':
    'Entrez un nom clair et unique pour ce sous-agent.',
  'e.g., Code Reviewer': 'ex. Réviseur de code',
  'Name cannot be empty.': 'Le nom ne peut pas être vide.',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    'Rédigez l\'invite système qui définit le comportement de ce sous-agent. Soyez complet pour de meilleurs résultats.',
  'e.g., You are an expert code reviewer...':
    'ex. Vous êtes un réviseur de code expert...',
  'System prompt cannot be empty.': "L'invite système ne peut pas être vide.",
  'Describe when and how this subagent should be used.':
    'Décrivez quand et comment ce sous-agent doit être utilisé.',
  'e.g., Reviews code for best practices and potential bugs.':
    'ex. Révise le code pour les meilleures pratiques et les bogues potentiels.',
  'Description cannot be empty.': 'La description ne peut pas être vide.',
  'Failed to launch editor: {{error}}':
    "Échec du lancement de l'éditeur : {{error}}",
  'Failed to save and edit subagent: {{error}}':
    'Échec de la sauvegarde et modification du sous-agent : {{error}}',

  // ============================================================================
  // Extensions - Boîte de dialogue de gestion
  // ============================================================================
  'Manage Extensions': 'Gérer les extensions',
  'Extension Details': "Détails de l'extension",
  'View Extension': "Voir l'extension",
  'Update Extension': "Mettre à jour l'extension",
  'Disable Extension': "Désactiver l'extension",
  'Enable Extension': "Activer l'extension",
  'Uninstall Extension': "Désinstaller l'extension",
  'Select Scope': 'Sélectionner la portée',
  'User Scope': 'Portée utilisateur',
  'Workspace Scope': 'Portée espace de travail',
  'No extensions found.': 'Aucune extension trouvée.',
  Active: 'Actif',
  Disabled: 'Désactivé',
  'Update available': 'Mise à jour disponible',
  'Up to date': 'À jour',
  'Checking...': 'Vérification...',
  'Updating...': 'Mise à jour...',
  Unknown: 'Inconnu',
  Error: 'Erreur',
  'Version:': 'Version :',
  'Status:': 'Statut :',
  'Are you sure you want to uninstall extension "{{name}}"?':
    'Êtes-vous sûr de vouloir désinstaller l\'extension "{{name}}" ?',
  'This action cannot be undone.': 'Cette action est irréversible.',
  'Extension "{{name}}" disabled successfully.':
    'Extension "{{name}}" désactivée avec succès.',
  'Extension "{{name}}" enabled successfully.':
    'Extension "{{name}}" activée avec succès.',
  'Extension "{{name}}" updated successfully.':
    'Extension "{{name}}" mise à jour avec succès.',
  'Failed to update extension "{{name}}": {{error}}':
    'Échec de la mise à jour de l\'extension "{{name}}" : {{error}}',
  'Select the scope for this action:': 'Sélectionnez la portée pour cette action :',
  'User - Applies to all projects': 'Utilisateur - S\'applique à tous les projets',
  'Workspace - Applies to current project only':
    "Espace de travail - S'applique uniquement au projet actuel",
  'Name:': 'Nom :',
  'MCP Servers:': 'Serveurs MCP :',
  'Settings:': 'Paramètres :',
  active: 'actif',
  disabled: 'désactivé',
  'View Details': 'Voir les détails',
  'Update failed:': 'Échec de la mise à jour :',
  'Updating {{name}}...': 'Mise à jour de {{name}}...',
  'Update complete!': 'Mise à jour terminée !',
  'User (global)': 'Utilisateur (global)',
  'Workspace (project-specific)': 'Espace de travail (spécifique au projet)',
  'Disable "{{name}}" - Select Scope':
    'Désactiver "{{name}}" - Sélectionner la portée',
  'Enable "{{name}}" - Select Scope':
    'Activer "{{name}}" - Sélectionner la portée',
  'No extension selected': 'Aucune extension sélectionnée',
  'Press Y/Enter to confirm, N/Esc to cancel':
    'Appuyez sur O/Entrée pour confirmer, N/Échap pour annuler',
  'Y/Enter to confirm, N/Esc to cancel':
    'O/Entrée pour confirmer, N/Échap pour annuler',
  '{{count}} extensions installed': '{{count}} extensions installées',
  "Use '/extensions install' to install your first extension.":
    "Utilisez '/extensions install' pour installer votre première extension.",
  'up to date': 'à jour',
  'update available': 'mise à jour disponible',
  'checking...': 'vérification...',
  'not updatable': 'non mise à jour possible',
  error: 'erreur',

  // ============================================================================
  // Commandes - Général (suite)
  // ============================================================================
  'View and edit Qwen Code settings':
    'Voir et modifier les paramètres de Qwen Code',
  Settings: 'Paramètres',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'Pour voir les changements, Qwen Code doit être redémarré. Appuyez sur r pour quitter et appliquer les changements maintenant.',
  'The command "/{{command}}" is not supported in non-interactive mode.':
    'La commande "/{{command}}" n\'est pas prise en charge en mode non interactif.',

  // ============================================================================
  // Étiquettes des paramètres
  // ============================================================================
  'Vim Mode': 'Mode Vim',
  'Disable Auto Update': 'Désactiver la mise à jour automatique',
  'Attribution: commit': 'Attribution : commit',
  'Terminal Bell Notification': 'Notification sonore du terminal',
  'Enable Usage Statistics': "Activer les statistiques d'utilisation",
  Theme: 'Thème',
  'Preferred Editor': 'Éditeur préféré',
  'Auto-connect to IDE': "Connexion automatique à l'IDE",
  'Enable Prompt Completion': "Activer la complétion d'invite",
  'Debug Keystroke Logging': 'Journalisation des frappes de débogage',
  'Language: UI': "Langue : Interface",
  'Language: Model': 'Langue : Modèle',
  'Output Format': 'Format de sortie',
  'Hide Window Title': 'Masquer le titre de la fenêtre',
  'Show Status in Title': 'Afficher le statut dans le titre',
  'Hide Tips': 'Masquer les conseils',
  'Show Line Numbers in Code': 'Afficher les numéros de ligne dans le code',
  'Show Citations': 'Afficher les citations',
  'Custom Witty Phrases': 'Phrases personnalisées spirituelles',
  'Show Welcome Back Dialog': 'Afficher le dialogue de bienvenue',
  'Enable User Feedback': 'Activer les retours utilisateur',
  'How is Qwen doing this session? (optional)':
    'Comment se passe cette session avec Qwen ? (facultatif)',
  Bad: 'Mauvais',
  Fine: 'Correct',
  Good: 'Bien',
  Dismiss: 'Ignorer',
  'Not Sure Yet': 'Pas encore sûr',
  'Any other key': 'Toute autre touche',
  'Disable Loading Phrases': 'Désactiver les phrases de chargement',
  'Screen Reader Mode': "Mode lecteur d'écran",
  'IDE Mode': 'Mode IDE',
  'Max Session Turns': 'Nombre maximum de tours de session',
  'Skip Next Speaker Check': 'Ignorer la vérification du prochain interlocuteur',
  'Skip Loop Detection': 'Ignorer la détection de boucle',
  'Skip Startup Context': 'Ignorer le contexte de démarrage',
  'Enable OpenAI Logging': 'Activer la journalisation OpenAI',
  'OpenAI Logging Directory': 'Répertoire de journalisation OpenAI',
  Timeout: 'Délai d\'attente',
  'Max Retries': 'Nombre maximum de tentatives',
  'Disable Cache Control': 'Désactiver le contrôle du cache',
  'Memory Discovery Max Dirs': 'Répertoires max pour la découverte mémoire',
  'Load Memory From Include Directories':
    'Charger la mémoire depuis les répertoires inclus',
  'Respect .gitignore': 'Respecter .gitignore',
  'Respect .qwenignore': 'Respecter .qwenignore',
  'Enable Recursive File Search': 'Activer la recherche récursive de fichiers',
  'Disable Fuzzy Search': 'Désactiver la recherche approximative',
  'Interactive Shell (PTY)': 'Shell interactif (PTY)',
  'Show Color': 'Afficher les couleurs',
  'Auto Accept': 'Acceptation automatique',
  'Use Ripgrep': 'Utiliser Ripgrep',
  'Use Builtin Ripgrep': 'Utiliser Ripgrep intégré',
  'Enable Tool Output Truncation': 'Activer la troncature de sortie des outils',
  'Tool Output Truncation Threshold': 'Seuil de troncature de sortie des outils',
  'Tool Output Truncation Lines': 'Lignes de troncature de sortie des outils',
  'Folder Trust': 'Confiance des dossiers',
  'Vision Model Preview': 'Aperçu du modèle de vision',
  'Tool Schema Compliance': 'Conformité au schéma des outils',
  'Auto (detect from system)': 'Auto (détecter depuis le système)',
  Text: 'Texte',
  JSON: 'JSON',
  Plan: 'Plan',
  Default: 'Par défaut',
  'Auto Edit': 'Édition automatique',
  YOLO: 'YOLO',
  'toggle vim mode on/off': 'activer/désactiver le mode Vim',
  'check session stats. Usage: /stats [model|tools]':
    'vérifier les stats de session. Utilisation : /stats [modèle|outils]',
  'Show model-specific usage statistics.':
    "Afficher les statistiques d'utilisation spécifiques au modèle.",
  'Show tool-specific usage statistics.':
    "Afficher les statistiques d'utilisation spécifiques aux outils.",
  'exit the cli': 'quitter le CLI',
  'Open MCP management dialog, or authenticate with OAuth-enabled servers':
    'Ouvrir le dialogue de gestion MCP, ou authentifier avec des serveurs compatibles OAuth',
  'List configured MCP servers and tools, or authenticate with OAuth-enabled servers':
    'Lister les serveurs MCP et outils configurés, ou authentifier avec des serveurs compatibles OAuth',
  'Manage workspace directories': "Gérer les répertoires de l'espace de travail",
  'Add directories to the workspace. Use comma to separate multiple paths':
    "Ajouter des répertoires à l'espace de travail. Utilisez une virgule pour séparer plusieurs chemins",
  'Show all directories in the workspace':
    "Afficher tous les répertoires de l'espace de travail",
  'set external editor preference': "définir la préférence d'éditeur externe",
  'Select Editor': "Sélectionner l'éditeur",
  'Editor Preference': "Préférence d'éditeur",
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    'Ces éditeurs sont actuellement pris en charge. Notez que certains éditeurs ne peuvent pas être utilisés en mode bac à sable.',
  'Your preferred editor is:': 'Votre éditeur préféré est :',
  'Manage extensions': 'Gérer les extensions',
  'Manage installed extensions': 'Gérer les extensions installées',
  'List active extensions': 'Lister les extensions actives',
  'Update extensions. Usage: update <extension-names>|--all':
    'Mettre à jour les extensions. Utilisation : update <noms-extensions>|--all',
  'Disable an extension': 'Désactiver une extension',
  'Enable an extension': 'Activer une extension',
  'Install an extension from a git repo or local path':
    'Installer une extension depuis un dépôt git ou un chemin local',
  'Uninstall an extension': 'Désinstaller une extension',
  'No extensions installed.': 'Aucune extension installée.',
  'Usage: /extensions update <extension-names>|--all':
    'Utilisation : /extensions update <noms-extensions>|--all',
  'Extension "{{name}}" not found.': 'Extension "{{name}}" introuvable.',
  'No extensions to update.': 'Aucune extension à mettre à jour.',
  'Usage: /extensions install <source>':
    'Utilisation : /extensions install <source>',
  'Installing extension from "{{source}}"...':
    'Installation de l\'extension depuis "{{source}}"...',
  'Extension "{{name}}" installed successfully.':
    'Extension "{{name}}" installée avec succès.',
  'Failed to install extension from "{{source}}": {{error}}':
    'Échec de l\'installation de l\'extension depuis "{{source}}" : {{error}}',
  'Usage: /extensions uninstall <extension-name>':
    'Utilisation : /extensions uninstall <nom-extension>',
  'Uninstalling extension "{{name}}"...':
    'Désinstallation de l\'extension "{{name}}"...',
  'Extension "{{name}}" uninstalled successfully.':
    'Extension "{{name}}" désinstallée avec succès.',
  'Failed to uninstall extension "{{name}}": {{error}}':
    'Échec de la désinstallation de l\'extension "{{name}}" : {{error}}',
  'Usage: /extensions {{command}} <extension> [--scope=<user|workspace>]':
    'Utilisation : /extensions {{command}} <extension> [--scope=<user|workspace>]',
  'Unsupported scope "{{scope}}", should be one of "user" or "workspace"':
    'Portée non prise en charge "{{scope}}", doit être "user" ou "workspace"',
  'Extension "{{name}}" disabled for scope "{{scope}}"':
    'Extension "{{name}}" désactivée pour la portée "{{scope}}"',
  'Extension "{{name}}" enabled for scope "{{scope}}"':
    'Extension "{{name}}" activée pour la portée "{{scope}}"',
  'Do you want to continue? [Y/n]: ': 'Voulez-vous continuer ? [O/n] : ',
  'Do you want to continue?': 'Voulez-vous continuer ?',
  'Installing extension "{{name}}".': 'Installation de l\'extension "{{name}}".',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**Les extensions peuvent introduire des comportements inattendus. Assurez-vous d\'avoir examiné la source de l\'extension et de faire confiance à l\'auteur.**',
  'This extension will run the following MCP servers:':
    'Cette extension exécutera les serveurs MCP suivants :',
  local: 'local',
  remote: 'distant',
  'This extension will add the following commands: {{commands}}.':
    'Cette extension ajoutera les commandes suivantes : {{commands}}.',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'Cette extension ajoutera des informations à votre contexte QWEN.md en utilisant {{fileName}}',
  'This extension will exclude the following core tools: {{tools}}':
    'Cette extension exclura les outils principaux suivants : {{tools}}',
  'This extension will install the following skills:':
    'Cette extension installera les compétences suivantes :',
  'This extension will install the following subagents:':
    'Cette extension installera les sous-agents suivants :',
  'Installation cancelled for "{{name}}".':
    'Installation annulée pour "{{name}}".',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    'Vous installez une extension depuis {{originSource}}. Certaines fonctionnalités peuvent ne pas fonctionner parfaitement avec Qwen Code.',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    '--ref et --auto-update ne sont pas applicables aux extensions du marketplace.',
  'Extension "{{name}}" installed successfully and enabled.':
    'Extension "{{name}}" installée et activée avec succès.',
  'Installs an extension from a git repository URL, local path, or claude marketplace (marketplace-url:plugin-name).':
    'Installe une extension depuis une URL de dépôt git, un chemin local ou le marketplace claude (marketplace-url:nom-plugin).',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    'L\'URL GitHub, le chemin local ou la source marketplace (marketplace-url:nom-plugin) de l\'extension à installer.',
  'The git ref to install from.': 'La référence git depuis laquelle installer.',
  'Enable auto-update for this extension.':
    'Activer la mise à jour automatique pour cette extension.',
  'Enable pre-release versions for this extension.':
    'Activer les versions pré-release pour cette extension.',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    "Reconnaître les risques de sécurité liés à l'installation d'une extension et ignorer la confirmation.",
  'The source argument must be provided.':
    "L'argument source doit être fourni.",
  'Extension "{{name}}" successfully uninstalled.':
    'Extension "{{name}}" désinstallée avec succès.',
  'Uninstalls an extension.': 'Désinstalle une extension.',
  'The name or source path of the extension to uninstall.':
    'Le nom ou le chemin source de l\'extension à désinstaller.',
  'Please include the name of the extension to uninstall as a positional argument.':
    "Veuillez inclure le nom de l'extension à désinstaller comme argument positionnel.",
  'Enables an extension.': 'Active une extension.',
  'The name of the extension to enable.': "Le nom de l'extension à activer.",
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    "La portée dans laquelle activer l'extension. Si non définie, sera activée dans toutes les portées.",
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    'Extension "{{name}}" activée avec succès pour la portée "{{scope}}".',
  'Extension "{{name}}" successfully enabled in all scopes.':
    'Extension "{{name}}" activée avec succès dans toutes les portées.',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    'Portée invalide : {{scope}}. Veuillez utiliser l\'une de : {{scopes}}.',
  'Disables an extension.': 'Désactive une extension.',
  'The name of the extension to disable.': "Le nom de l'extension à désactiver.",
  'The scope to disable the extenison in.':
    "La portée dans laquelle désactiver l'extension.",
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    'Extension "{{name}}" désactivée avec succès pour la portée "{{scope}}".',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    'Extension "{{name}}" mise à jour avec succès : {{oldVersion}} → {{newVersion}}.',
  'Unable to install extension "{{name}}" due to missing install metadata':
    'Impossible d\'installer l\'extension "{{name}}" en raison de métadonnées d\'installation manquantes',
  'Extension "{{name}}" is already up to date.':
    'L\'extension "{{name}}" est déjà à jour.',
  'Updates all extensions or a named extension to the latest version.':
    'Met à jour toutes les extensions ou une extension nommée vers la dernière version.',
  'Update all extensions.': 'Mettre à jour toutes les extensions.',
  'Either an extension name or --all must be provided':
    "Un nom d'extension ou --all doit être fourni",
  'Lists installed extensions.': 'Liste les extensions installées.',
  'Path:': 'Chemin :',
  'Source:': 'Source :',
  'Type:': 'Type :',
  'Ref:': 'Réf :',
  'Release tag:': 'Tag de version :',
  'Enabled (User):': 'Activé (Utilisateur) :',
  'Enabled (Workspace):': 'Activé (Espace de travail) :',
  'Context files:': 'Fichiers de contexte :',
  'Skills:': 'Compétences :',
  'Agents:': 'Agents :',
  'MCP servers:': 'Serveurs MCP :',
  'Link extension failed to install.':
    "Échec de l'installation de l'extension liée.",
  'Extension "{{name}}" linked successfully and enabled.':
    'Extension "{{name}}" liée et activée avec succès.',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    "Lie une extension depuis un chemin local. Les modifications apportées au chemin local seront toujours reflétées.",
  'The name of the extension to link.': "Le nom de l'extension à lier.",
  'Set a specific setting for an extension.':
    "Définir un paramètre spécifique pour une extension.",
  'Name of the extension to configure.':
    "Nom de l'extension à configurer.",
  'The setting to configure (name or env var).':
    'Le paramètre à configurer (nom ou variable d\'environnement).',
  'The scope to set the setting in.':
    'La portée dans laquelle définir le paramètre.',
  'List all settings for an extension.':
    "Lister tous les paramètres d'une extension.",
  'Name of the extension.': "Nom de l'extension.",
  'Extension "{{name}}" has no settings to configure.':
    'L\'extension "{{name}}" n\'a aucun paramètre à configurer.',
  'Settings for "{{name}}":': 'Paramètres pour "{{name}}" :',
  '(workspace)': '(espace de travail)',
  '(user)': '(utilisateur)',
  '[not set]': '[non défini]',
  '[value stored in keychain]': '[valeur stockée dans le trousseau]',
  'Value:': 'Valeur :',
  'Manage extension settings.': "Gérer les paramètres des extensions.",
  'You need to specify a command (set or list).':
    'Vous devez spécifier une commande (set ou list).',

  // ============================================================================
  // Choix de plugin / Marketplace
  // ============================================================================
  'No plugins available in this marketplace.':
    'Aucun plugin disponible dans ce marketplace.',
  'Select a plugin to install from marketplace "{{name}}":':
    'Sélectionnez un plugin à installer depuis le marketplace "{{name}}" :',
  'Plugin selection cancelled.': 'Sélection de plugin annulée.',
  'Select a plugin from "{{name}}"': 'Sélectionner un plugin depuis "{{name}}"',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    'Utilisez ↑↓ ou j/k pour naviguer, Entrée pour sélectionner, Échap pour annuler',
  '{{count}} more above': '{{count}} de plus au-dessus',
  '{{count}} more below': '{{count}} de plus en dessous',
  'manage IDE integration': "gérer l'intégration IDE",
  'check status of IDE integration': "vérifier le statut de l'intégration IDE",
  'install required IDE companion for {{ideName}}':
    "installer le compagnon IDE requis pour {{ideName}}",
  'enable IDE integration': "activer l'intégration IDE",
  'disable IDE integration': "désactiver l'intégration IDE",
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    "L'intégration IDE n'est pas prise en charge dans votre environnement actuel. Pour utiliser cette fonctionnalité, exécutez Qwen Code dans l'un des IDEs pris en charge : VS Code ou ses dérivés.",
  'Set up GitHub Actions': 'Configurer GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    'Configurer les raccourcis du terminal pour la saisie multiligne (VS Code, Cursor, Windsurf, Trae)',
  'Please restart your terminal for the changes to take effect.':
    'Veuillez redémarrer votre terminal pour que les modifications prennent effet.',
  'Failed to configure terminal: {{error}}':
    'Échec de la configuration du terminal : {{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    'Impossible de déterminer le chemin de configuration de {{terminalName}} sur Windows : la variable d\'environnement APPDATA n\'est pas définie.',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} keybindings.json existe mais n\'est pas un tableau JSON valide. Veuillez corriger le fichier manuellement ou le supprimer pour permettre la configuration automatique.',
  'File: {{file}}': 'Fichier : {{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    'Échec de l\'analyse de {{terminalName}} keybindings.json. Le fichier contient du JSON invalide. Veuillez corriger le fichier manuellement ou le supprimer pour permettre la configuration automatique.',
  'Error: {{error}}': 'Erreur : {{error}}',
  'Shift+Enter binding already exists':
    'Le raccourci Maj+Entrée existe déjà',
  'Ctrl+Enter binding already exists':
    'Le raccourci Ctrl+Entrée existe déjà',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    'Raccourcis existants détectés. Aucune modification pour éviter les conflits.',
  'Please check and modify manually if needed: {{file}}':
    'Veuillez vérifier et modifier manuellement si nécessaire : {{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    'Raccourcis Maj+Entrée et Ctrl+Entrée ajoutés à {{terminalName}}.',
  'Modified: {{file}}': 'Modifié : {{file}}',
  '{{terminalName}} keybindings already configured.':
    'Raccourcis {{terminalName}} déjà configurés.',
  'Failed to configure {{terminalName}}.':
    'Échec de la configuration de {{terminalName}}.',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    'Votre terminal est déjà configuré pour une expérience optimale avec la saisie multiligne (Maj+Entrée et Ctrl+Entrée).',

  // ============================================================================
  // Commandes - Hooks
  // ============================================================================
  'Manage Qwen Code hooks': 'Gérer les hooks Qwen Code',
  'List all configured hooks': 'Lister tous les hooks configurés',
  'Enable a disabled hook': 'Activer un hook désactivé',
  'Disable an active hook': 'Désactiver un hook actif',
  Hooks: 'Hooks',
  'Loading hooks...': 'Chargement des hooks...',
  'Error loading hooks:': 'Erreur lors du chargement des hooks :',
  'Press Escape to close': 'Appuyez sur Échap pour fermer',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    'Appuyez sur Échap, Ctrl+C ou Ctrl+D pour annuler',
  'Press Space, Enter, or Escape to dismiss':
    'Appuyez sur Espace, Entrée ou Échap pour ignorer',
  'No hook selected': 'Aucun hook sélectionné',
  'No hook events found.': 'Aucun événement de hook trouvé.',
  '{{count}} hook configured': '{{count}} hook configuré',
  '{{count}} hooks configured': '{{count}} hooks configurés',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    'Ce menu est en lecture seule. Pour ajouter ou modifier des hooks, éditez settings.json directement ou demandez à Qwen Code.',
  'Enter to select · Esc to cancel': 'Entrée pour sélectionner · Échap pour annuler',
  'Exit codes:': 'Codes de sortie :',
  'Configured hooks:': 'Hooks configurés :',
  'No hooks configured for this event.':
    'Aucun hook configuré pour cet événement.',
  'To add hooks, edit settings.json directly or ask Qwen.':
    'Pour ajouter des hooks, éditez settings.json directement ou demandez à Qwen.',
  'Enter to select · Esc to go back':
    'Entrée pour sélectionner · Échap pour revenir',
  'Hook details': 'Détails du hook',
  'Event:': 'Événement :',
  'Extension:': 'Extension :',
  'Desc:': 'Description :',
  'No hook config selected': 'Aucune configuration de hook sélectionnée',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    'Pour modifier ou supprimer ce hook, éditez settings.json directement ou demandez à Qwen.',
  'Hook Configuration - Disabled': 'Configuration du hook - Désactivé',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    'Tous les hooks sont actuellement désactivés. Vous en avez {{count}} qui ne s\'exécutent pas.',
  '{{count}} configured hook': '{{count}} hook configuré',
  '{{count}} configured hooks': '{{count}} hooks configurés',
  'When hooks are disabled:': 'Quand les hooks sont désactivés :',
  'No hook commands will execute': 'Aucune commande de hook ne s\'exécutera',
  'StatusLine will not be displayed': 'La barre de statut ne sera pas affichée',
  'Tool operations will proceed without hook validation':
    'Les opérations d\'outils se poursuivront sans validation des hooks',
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    'Pour réactiver les hooks, supprimez "disableAllHooks" de settings.json ou demandez à Qwen Code.',
  Project: 'Projet',
  User: 'Utilisateur',
  System: 'Système',
  Extension: 'Extension',
  'Local Settings': 'Paramètres locaux',
  'User Settings': 'Paramètres utilisateur',
  'System Settings': 'Paramètres système',
  Extensions: 'Extensions',
  '✓ Enabled': '✓ Activé',
  '✗ Disabled': '✗ Désactivé',
  'Before tool execution': "Avant l'exécution de l'outil",
  'After tool execution': "Après l'exécution de l'outil",
  'After tool execution fails': "Après l'échec de l'exécution de l'outil",
  'When notifications are sent': 'Quand des notifications sont envoyées',
  'When the user submits a prompt': "Quand l'utilisateur soumet une invite",
  'When a new session is started': 'Quand une nouvelle session est démarrée',
  'Right before Qwen Code concludes its response':
    'Juste avant que Qwen Code conclue sa réponse',
  'When a subagent (Agent tool call) is started':
    "Quand un sous-agent (appel d'outil Agent) est démarré",
  'Right before a subagent concludes its response':
    'Juste avant qu\'un sous-agent conclue sa réponse',
  'Before conversation compaction': 'Avant la compaction de la conversation',
  'When a session is ending': 'Quand une session se termine',
  'When a permission dialog is displayed':
    "Quand un dialogue de permission est affiché",
  'Input to command is JSON of tool call arguments.':
    "L'entrée de la commande est du JSON des arguments d'appel d'outil.",
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    'L\'entrée de la commande est du JSON avec les champs "inputs" (arguments d\'appel d\'outil) et "response" (réponse de l\'appel d\'outil).',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    'L\'entrée de la commande est du JSON avec tool_name, tool_input, tool_use_id, error, error_type, is_interrupt et is_timeout.',
  'Input to command is JSON with notification message and type.':
    "L'entrée de la commande est du JSON avec le message et le type de notification.",
  'Input to command is JSON with original user prompt text.':
    "L'entrée de la commande est du JSON avec le texte d'invite original de l'utilisateur.",
  'Input to command is JSON with session start source.':
    "L'entrée de la commande est du JSON avec la source de démarrage de session.",
  'Input to command is JSON with session end reason.':
    "L'entrée de la commande est du JSON avec la raison de fin de session.",
  'Input to command is JSON with agent_id and agent_type.':
    "L'entrée de la commande est du JSON avec agent_id et agent_type.",
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    "L'entrée de la commande est du JSON avec agent_id, agent_type et agent_transcript_path.",
  'Input to command is JSON with compaction details.':
    "L'entrée de la commande est du JSON avec les détails de compaction.",
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    "L'entrée de la commande est du JSON avec tool_name, tool_input et tool_use_id. Sortie JSON avec hookSpecificOutput contenant la décision d'autoriser ou de refuser.",
  'stdout/stderr not shown': 'stdout/stderr non affiché',
  'show stderr to model and continue conversation':
    'afficher stderr au modèle et continuer la conversation',
  'show stderr to user only': "afficher stderr à l'utilisateur uniquement",
  'stdout shown in transcript mode (ctrl+o)':
    'stdout affiché en mode transcription (ctrl+o)',
  'show stderr to model immediately': 'afficher stderr au modèle immédiatement',
  'show stderr to user only but continue with tool call':
    "afficher stderr à l'utilisateur uniquement mais continuer l'appel d'outil",
  'block processing, erase original prompt, and show stderr to user only':
    "bloquer le traitement, effacer l'invite originale et afficher stderr à l'utilisateur uniquement",
  'stdout shown to Qwen': 'stdout affiché à Qwen',
  'show stderr to user only (blocking errors ignored)':
    "afficher stderr à l'utilisateur uniquement (erreurs bloquantes ignorées)",
  'command completes successfully': 'la commande se termine avec succès',
  'stdout shown to subagent': 'stdout affiché au sous-agent',
  'show stderr to subagent and continue having it run':
    'afficher stderr au sous-agent et continuer son exécution',
  'stdout appended as custom compact instructions':
    'stdout ajouté comme instructions compactes personnalisées',
  'block compaction': 'bloquer la compaction',
  'show stderr to user only but continue with compaction':
    "afficher stderr à l'utilisateur uniquement mais continuer la compaction",
  'use hook decision if provided': 'utiliser la décision du hook si fournie',
  'Config not loaded.': 'Configuration non chargée.',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'Les hooks ne sont pas activés. Activez les hooks dans les paramètres pour utiliser cette fonctionnalité.',
  'No hooks configured. Add hooks in your settings.json file.':
    'Aucun hook configuré. Ajoutez des hooks dans votre fichier settings.json.',
  'Configured Hooks ({{count}} total)':
    'Hooks configurés ({{count}} au total)',

  // ============================================================================
  // Commandes - Export de session
  // ============================================================================
  'Export current session message history to a file':
    "Exporter l'historique des messages de la session actuelle vers un fichier",
  'Export session to HTML format': 'Exporter la session au format HTML',
  'Export session to JSON format': 'Exporter la session au format JSON',
  'Export session to JSONL format (one message per line)':
    'Exporter la session au format JSONL (un message par ligne)',
  'Export session to markdown format': 'Exporter la session au format markdown',

  // ============================================================================
  // Commandes - Insights
  // ============================================================================
  'generate personalized programming insights from your chat history':
    "générer des insights de programmation personnalisés depuis votre historique de chat",

  // ============================================================================
  // Commandes - Historique de session
  // ============================================================================
  'Resume a previous session': 'Reprendre une session précédente',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    "Restaurer un appel d'outil. Cela réinitialisera la conversation et l'historique des fichiers à l'état où il se trouvait lors de la suggestion de l'appel d'outil",
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    'Impossible de détecter le type de terminal. Terminaux pris en charge : VS Code, Cursor, Windsurf et Trae.',
  'Terminal "{{terminal}}" is not supported yet.':
    'Le terminal "{{terminal}}" n\'est pas encore pris en charge.',

  // ============================================================================
  // Commandes - Langue
  // ============================================================================
  'Invalid language. Available: {{options}}':
    'Langue invalide. Disponibles : {{options}}',
  'Language subcommands do not accept additional arguments.':
    'Les sous-commandes de langue n\'acceptent pas d\'arguments supplémentaires.',
  'Current UI language: {{lang}}': 'Langue de l\'interface actuelle : {{lang}}',
  'Current LLM output language: {{lang}}':
    'Langue de sortie LLM actuelle : {{lang}}',
  'LLM output language not set': 'Langue de sortie LLM non définie',
  'Set UI language': "Définir la langue de l'interface",
  'Set LLM output language': 'Définir la langue de sortie LLM',
  'Usage: /language ui [{{options}}]': 'Utilisation : /language ui [{{options}}]',
  'Usage: /language output <language>':
    'Utilisation : /language output <langue>',
  'Example: /language output 中文': 'Exemple : /language output 中文',
  'Example: /language output English': 'Exemple : /language output English',
  'Example: /language output 日本語': 'Exemple : /language output 日本語',
  'Example: /language output Português': 'Exemple : /language output Português',
  'UI language changed to {{lang}}': "Langue de l'interface changée en {{lang}}",
  'LLM output language set to {{lang}}':
    'Langue de sortie LLM définie sur {{lang}}',
  'LLM output language rule file generated at {{path}}':
    'Fichier de règle de langue de sortie LLM généré dans {{path}}',
  'Please restart the application for the changes to take effect.':
    'Veuillez redémarrer l\'application pour que les modifications prennent effet.',
  'Failed to generate LLM output language rule file: {{error}}':
    'Échec de la génération du fichier de règle de langue de sortie LLM : {{error}}',
  'Invalid command. Available subcommands:':
    'Commande invalide. Sous-commandes disponibles :',
  'Available subcommands:': 'Sous-commandes disponibles :',
  'To request additional UI language packs, please open an issue on GitHub.':
    "Pour demander des packs de langue d'interface supplémentaires, veuillez ouvrir un ticket sur GitHub.",
  'Available options:': 'Options disponibles :',
  'Set UI language to {{name}}': "Définir la langue de l'interface sur {{name}}",

  // ============================================================================
  // Commandes - Mode d'approbation
  // ============================================================================
  'Tool Approval Mode': "Mode d'approbation des outils",
  'Current approval mode: {{mode}}': "Mode d'approbation actuel : {{mode}}",
  'Available approval modes:': "Modes d'approbation disponibles :",
  'Approval mode changed to: {{mode}}': "Mode d'approbation changé en : {{mode}}",
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    "Mode d'approbation changé en : {{mode}} (enregistré dans les paramètres {{scope}}{{location}})",
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    'Utilisation : /approval-mode <mode> [--session|--user|--project]',
  'Scope subcommands do not accept additional arguments.':
    'Les sous-commandes de portée n\'acceptent pas d\'arguments supplémentaires.',
  'Plan mode - Analyze only, do not modify files or execute commands':
    'Mode plan - Analyser uniquement, ne pas modifier les fichiers ni exécuter des commandes',
  'Default mode - Require approval for file edits or shell commands':
    "Mode par défaut - Demander l'approbation pour les modifications de fichiers ou les commandes shell",
  'Auto-edit mode - Automatically approve file edits':
    'Mode édition automatique - Approuver automatiquement les modifications de fichiers',
  'YOLO mode - Automatically approve all tools':
    'Mode YOLO - Approuver automatiquement tous les outils',
  '{{mode}} mode': 'Mode {{mode}}',
  'Settings service is not available; unable to persist the approval mode.':
    "Le service de paramètres n'est pas disponible ; impossible de persister le mode d'approbation.",
  'Failed to save approval mode: {{error}}':
    "Échec de la sauvegarde du mode d'approbation : {{error}}",
  'Failed to change approval mode: {{error}}':
    "Échec du changement du mode d'approbation : {{error}}",
  'Apply to current session only (temporary)':
    'Appliquer uniquement à la session actuelle (temporaire)',
  'Persist for this project/workspace':
    "Persister pour ce projet/espace de travail",
  'Persist for this user on this machine':
    'Persister pour cet utilisateur sur cette machine',
  'Analyze only, do not modify files or execute commands':
    'Analyser uniquement, ne pas modifier les fichiers ni exécuter des commandes',
  'Require approval for file edits or shell commands':
    "Demander l'approbation pour les modifications de fichiers ou les commandes shell",
  'Automatically approve file edits':
    'Approuver automatiquement les modifications de fichiers',
  'Automatically approve all tools': 'Approuver automatiquement tous les outils',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    "Un mode d'approbation d'espace de travail existe et a la priorité. La modification au niveau utilisateur n'aura aucun effet.",
  'Apply To': 'Appliquer à',
  'Workspace Settings': "Paramètres de l'espace de travail",

  // ============================================================================
  // Commandes - Mémoire
  // ============================================================================
  'Commands for interacting with memory.':
    'Commandes pour interagir avec la mémoire.',
  'Show the current memory contents.': 'Afficher le contenu actuel de la mémoire.',
  'Show project-level memory contents.':
    'Afficher le contenu de la mémoire au niveau du projet.',
  'Show global memory contents.':
    'Afficher le contenu de la mémoire globale.',
  'Add content to project-level memory.':
    'Ajouter du contenu à la mémoire au niveau du projet.',
  'Add content to global memory.': 'Ajouter du contenu à la mémoire globale.',
  'Refresh the memory from the source.':
    'Actualiser la mémoire depuis la source.',
  'Usage: /memory add --project <text to remember>':
    'Utilisation : /memory add --project <texte à mémoriser>',
  'Usage: /memory add --global <text to remember>':
    'Utilisation : /memory add --global <texte à mémoriser>',
  'Attempting to save to project memory: "{{text}}"':
    'Tentative de sauvegarde dans la mémoire du projet : "{{text}}"',
  'Attempting to save to global memory: "{{text}}"':
    'Tentative de sauvegarde dans la mémoire globale : "{{text}}"',
  'Current memory content from {{count}} file(s):':
    'Contenu actuel de la mémoire depuis {{count}} fichier(s) :',
  'Memory is currently empty.': 'La mémoire est actuellement vide.',
  'Project memory file not found or is currently empty.':
    'Fichier de mémoire du projet introuvable ou actuellement vide.',
  'Global memory file not found or is currently empty.':
    'Fichier de mémoire globale introuvable ou actuellement vide.',
  'Global memory is currently empty.': 'La mémoire globale est actuellement vide.',
  'Global memory content:\n\n---\n{{content}}\n---':
    'Contenu de la mémoire globale :\n\n---\n{{content}}\n---',
  'Project memory content from {{path}}:\n\n---\n{{content}}\n---':
    'Contenu de la mémoire du projet depuis {{path}} :\n\n---\n{{content}}\n---',
  'Project memory is currently empty.':
    'La mémoire du projet est actuellement vide.',
  'Refreshing memory from source files...':
    'Actualisation de la mémoire depuis les fichiers sources...',
  'Add content to the memory. Use --global for global memory or --project for project memory.':
    'Ajouter du contenu à la mémoire. Utilisez --global pour la mémoire globale ou --project pour la mémoire du projet.',
  'Usage: /memory add [--global|--project] <text to remember>':
    'Utilisation : /memory add [--global|--project] <texte à mémoriser>',
  'Attempting to save to memory {{scope}}: "{{fact}}"':
    'Tentative de sauvegarde dans la mémoire {{scope}} : "{{fact}}"',

  // ============================================================================
  // Commandes - MCP
  // ============================================================================
  'Authenticate with an OAuth-enabled MCP server':
    'Authentifier avec un serveur MCP compatible OAuth',
  'List configured MCP servers and tools':
    'Lister les serveurs MCP et outils configurés',
  'Restarts MCP servers.': 'Redémarre les serveurs MCP.',
  'Open MCP management dialog': 'Ouvrir le dialogue de gestion MCP',
  'Could not retrieve tool registry.':
    'Impossible de récupérer le registre des outils.',
  'No MCP servers configured with OAuth authentication.':
    'Aucun serveur MCP configuré avec l\'authentification OAuth.',
  'MCP servers with OAuth authentication:':
    'Serveurs MCP avec authentification OAuth :',
  'Use /mcp auth <server-name> to authenticate.':
    'Utilisez /mcp auth <nom-serveur> pour vous authentifier.',
  "MCP server '{{name}}' not found.": "Serveur MCP '{{name}}' introuvable.",
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "Authentification réussie et outils actualisés pour '{{name}}'.",
  "Failed to authenticate with MCP server '{{name}}': {{error}}":
    "Échec de l'authentification avec le serveur MCP '{{name}}' : {{error}}",
  "Re-discovering tools from '{{name}}'...":
    "Redécouverte des outils depuis '{{name}}'...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "{{count}} outil(s) découvert(s) depuis '{{name}}'.",
  'Authentication complete. Returning to server details...':
    'Authentification terminée. Retour aux détails du serveur...',
  'Authentication successful.': 'Authentification réussie.',
  'If the browser does not open, copy and paste this URL into your browser:':
    'Si le navigateur ne s\'ouvre pas, copiez et collez cette URL dans votre navigateur :',
  'Make sure to copy the COMPLETE URL - it may wrap across multiple lines.':
    'Assurez-vous de copier l\'URL COMPLÈTE - elle peut s\'étendre sur plusieurs lignes.',

  // ============================================================================
  // Boîte de dialogue de gestion MCP
  // ============================================================================
  'Manage MCP servers': 'Gérer les serveurs MCP',
  'Server Detail': 'Détail du serveur',
  'Disable Server': 'Désactiver le serveur',
  Tools: 'Outils',
  'Tool Detail': "Détail de l'outil",
  'MCP Management': 'Gestion MCP',
  'Loading...': 'Chargement...',
  'Unknown step': 'Étape inconnue',
  'Esc to back': 'Échap pour revenir',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ pour naviguer · Entrée pour sélectionner · Échap pour fermer',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ pour naviguer · Entrée pour sélectionner · Échap pour revenir',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ pour naviguer · Entrée pour confirmer · Échap pour revenir',
  'User Settings (global)': 'Paramètres utilisateur (global)',
  'Workspace Settings (project-specific)':
    'Paramètres espace de travail (spécifique au projet)',
  'Disable server:': 'Désactiver le serveur :',
  'Select where to add the server to the exclude list:':
    "Sélectionnez où ajouter le serveur à la liste d'exclusion :",
  'Press Enter to confirm, Esc to cancel':
    'Appuyez sur Entrée pour confirmer, Échap pour annuler',
  'View tools': 'Voir les outils',
  Reconnect: 'Reconnecter',
  Enable: 'Activer',
  Disable: 'Désactiver',
  Authenticate: 'Authentifier',
  'Re-authenticate': 'Réauthentifier',
  'Clear Authentication': "Effacer l'authentification",
  'Server:': 'Serveur :',
  'Command:': 'Commande :',
  'Working Directory:': 'Répertoire de travail :',
  'Capabilities:': 'Capacités :',
  'No server selected': 'Aucun serveur sélectionné',
  prompts: 'invites',
  '(disabled)': '(désactivé)',
  'Error:': 'Erreur :',
  tool: 'outil',
  tools: 'outils',
  connected: 'connecté',
  connecting: 'connexion en cours',
  disconnected: 'déconnecté',
  'User MCPs': 'MCPs utilisateur',
  'Project MCPs': 'MCPs projet',
  'Extension MCPs': "MCPs d'extension",
  server: 'serveur',
  servers: 'serveurs',
  'Add MCP servers to your settings to get started.':
    'Ajoutez des serveurs MCP à vos paramètres pour commencer.',
  'Run qwen --debug to see error logs':
    'Exécutez qwen --debug pour voir les journaux d\'erreurs',
  'OAuth Authentication': 'Authentification OAuth',
  'Press Enter to start authentication, Esc to go back':
    'Appuyez sur Entrée pour démarrer l\'authentification, Échap pour revenir',
  'Authenticating... Please complete the login in your browser.':
    'Authentification... Veuillez compléter la connexion dans votre navigateur.',
  'Press Enter or Esc to go back': 'Appuyez sur Entrée ou Échap pour revenir',
  'No tools available for this server.':
    'Aucun outil disponible pour ce serveur.',
  destructive: 'destructif',
  'read-only': 'lecture seule',
  'open-world': 'monde ouvert',
  idempotent: 'idempotent',
  'Tools for {{name}}': 'Outils pour {{name}}',
  'Tools for {{serverName}}': 'Outils pour {{serverName}}',
  '{{current}}/{{total}}': '{{current}}/{{total}}',
  required: 'requis',
  Type: 'Type',
  Enum: 'Enum',
  Parameters: 'Paramètres',
  'No tool selected': 'Aucun outil sélectionné',
  Annotations: 'Annotations',
  Title: 'Titre',
  'Read Only': 'Lecture seule',
  Destructive: 'Destructif',
  Idempotent: 'Idempotent',
  'Open World': 'Monde ouvert',
  Server: 'Serveur',
  '{{count}} invalid tools': '{{count}} outils invalides',
  invalid: 'invalide',
  'invalid: {{reason}}': 'invalide : {{reason}}',
  'missing name': 'nom manquant',
  'missing description': 'description manquante',
  '(unnamed)': '(sans nom)',
  'Warning: This tool cannot be called by the LLM':
    'Avertissement : Cet outil ne peut pas être appelé par le LLM',
  Reason: 'Raison',
  'Tools must have both name and description to be used by the LLM.':
    'Les outils doivent avoir un nom et une description pour être utilisés par le LLM.',

  // ============================================================================
  // Commandes - Chat
  // ============================================================================
  'Manage conversation history.': "Gérer l'historique des conversations.",
  'List saved conversation checkpoints':
    'Lister les points de contrôle de conversation sauvegardés',
  'No saved conversation checkpoints found.':
    'Aucun point de contrôle de conversation sauvegardé trouvé.',
  'List of saved conversations:': 'Liste des conversations sauvegardées :',
  'Note: Newest last, oldest first':
    'Note : Du plus récent au plus ancien en dernier, du plus ancien en premier',
  'Save the current conversation as a checkpoint. Usage: /chat save <tag>':
    'Sauvegarder la conversation actuelle comme point de contrôle. Utilisation : /chat save <étiquette>',
  'Missing tag. Usage: /chat save <tag>':
    'Étiquette manquante. Utilisation : /chat save <étiquette>',
  'Delete a conversation checkpoint. Usage: /chat delete <tag>':
    'Supprimer un point de contrôle de conversation. Utilisation : /chat delete <étiquette>',
  'Missing tag. Usage: /chat delete <tag>':
    'Étiquette manquante. Utilisation : /chat delete <étiquette>',
  "Conversation checkpoint '{{tag}}' has been deleted.":
    "Le point de contrôle de conversation '{{tag}}' a été supprimé.",
  "Error: No checkpoint found with tag '{{tag}}'.":
    "Erreur : Aucun point de contrôle trouvé avec l'étiquette '{{tag}}'.",
  'Resume a conversation from a checkpoint. Usage: /chat resume <tag>':
    'Reprendre une conversation depuis un point de contrôle. Utilisation : /chat resume <étiquette>',
  'Missing tag. Usage: /chat resume <tag>':
    'Étiquette manquante. Utilisation : /chat resume <étiquette>',
  'No saved checkpoint found with tag: {{tag}}.':
    'Aucun point de contrôle sauvegardé trouvé avec l\'étiquette : {{tag}}.',
  'A checkpoint with the tag {{tag}} already exists. Do you want to overwrite it?':
    'Un point de contrôle avec l\'étiquette {{tag}} existe déjà. Voulez-vous l\'écraser ?',
  'No chat client available to save conversation.':
    'Aucun client de chat disponible pour sauvegarder la conversation.',
  'Conversation checkpoint saved with tag: {{tag}}.':
    'Point de contrôle de conversation sauvegardé avec l\'étiquette : {{tag}}.',
  'No conversation found to save.':
    'Aucune conversation trouvée à sauvegarder.',
  'No chat client available to share conversation.':
    'Aucun client de chat disponible pour partager la conversation.',
  'Invalid file format. Only .md and .json are supported.':
    'Format de fichier invalide. Seuls .md et .json sont pris en charge.',
  'Error sharing conversation: {{error}}':
    'Erreur lors du partage de la conversation : {{error}}',
  'Conversation shared to {{filePath}}':
    'Conversation partagée vers {{filePath}}',
  'No conversation found to share.':
    'Aucune conversation trouvée à partager.',
  'Share the current conversation to a markdown or json file. Usage: /chat share <file>':
    'Partager la conversation actuelle vers un fichier markdown ou json. Utilisation : /chat share <fichier>',

  // ============================================================================
  // Commandes - Résumé
  // ============================================================================
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    'Générer un résumé du projet et l\'enregistrer dans .qwen/PROJECT_SUMMARY.md',
  'No chat client available to generate summary.':
    'Aucun client de chat disponible pour générer le résumé.',
  'Already generating summary, wait for previous request to complete':
    'Génération de résumé déjà en cours, attendez que la demande précédente se termine',
  'No conversation found to summarize.':
    'Aucune conversation trouvée à résumer.',
  'Failed to generate project context summary: {{error}}':
    'Échec de la génération du résumé du contexte du projet : {{error}}',
  'Saved project summary to {{filePathForDisplay}}.':
    'Résumé du projet enregistré dans {{filePathForDisplay}}.',
  'Saving project summary...': 'Enregistrement du résumé du projet...',
  'Generating project summary...': 'Génération du résumé du projet...',
  'Failed to generate summary - no text content received from LLM response':
    'Échec de la génération du résumé - aucun contenu texte reçu de la réponse LLM',

  // ============================================================================
  // Commandes - Modèle
  // ============================================================================
  'Switch the model for this session (--fast for suggestion model)':
    'Changer le modèle pour cette session (--fast pour le modèle de suggestion)',
  'Set a lighter model for prompt suggestions and speculative execution':
    'Définir un modèle plus léger pour les suggestions d\'invite et l\'exécution spéculative',
  'Content generator configuration not available.':
    'Configuration du générateur de contenu non disponible.',
  'Authentication type not available.':
    "Type d'authentification non disponible.",
  'No models available for the current authentication type ({{authType}}).':
    'Aucun modèle disponible pour le type d\'authentification actuel ({{authType}}).',

  // ============================================================================
  // Commandes - Effacer
  // ============================================================================
  'Starting a new session, resetting chat, and clearing terminal.':
    'Démarrage d\'une nouvelle session, réinitialisation du chat et effacement du terminal.',
  'Starting a new session and clearing.':
    'Démarrage d\'une nouvelle session et effacement.',

  // ============================================================================
  // Commandes - Compresser
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    'Compression déjà en cours, attendez que la demande précédente se termine',
  'Failed to compress chat history.':
    "Échec de la compression de l'historique du chat.",
  'Failed to compress chat history: {{error}}':
    "Échec de la compression de l'historique du chat : {{error}}",
  'Compressing chat history': "Compression de l'historique du chat",
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    "L'historique du chat a été compressé de {{originalTokens}} à {{newTokens}} tokens.",
  'Compression was not beneficial for this history size.':
    'La compression n\'était pas bénéfique pour cette taille d\'historique.',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    'La compression de l\'historique du chat n\'a pas réduit la taille. Cela peut indiquer des problèmes avec l\'invite de compression.',
  'Could not compress chat history due to a token counting error.':
    'Impossible de compresser l\'historique du chat en raison d\'une erreur de comptage de tokens.',
  'Chat history is already compressed.':
    "L'historique du chat est déjà compressé.",

  // ============================================================================
  // Commandes - Répertoire
  // ============================================================================
  'Configuration is not available.': 'Configuration non disponible.',
  'Please provide at least one path to add.':
    'Veuillez fournir au moins un chemin à ajouter.',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    'La commande /directory add n\'est pas prise en charge dans les profils de bac à sable restrictifs. Utilisez plutôt --include-directories lors du démarrage de la session.',
  "Error adding '{{path}}': {{error}}":
    "Erreur lors de l'ajout de '{{path}}' : {{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    'Fichiers QWEN.md ajoutés avec succès depuis les répertoires suivants s\'ils existent :\n- {{directories}}',
  'Error refreshing memory: {{error}}':
    'Erreur lors de l\'actualisation de la mémoire : {{error}}',
  'Successfully added directories:\n- {{directories}}':
    'Répertoires ajoutés avec succès :\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    "Répertoires actuels de l'espace de travail :\n{{directories}}",

  // ============================================================================
  // Commandes - Documentation
  // ============================================================================
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    'Veuillez ouvrir l\'URL suivante dans votre navigateur pour voir la documentation :\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    'Ouverture de la documentation dans votre navigateur : {{url}}',

  // ============================================================================
  // Boîtes de dialogue - Confirmation d'outil
  // ============================================================================
  'Do you want to proceed?': 'Voulez-vous continuer ?',
  'Yes, allow once': 'Oui, autoriser une fois',
  'Allow always': 'Toujours autoriser',
  Yes: 'Oui',
  No: 'Non',
  'No (esc)': 'Non (échap)',
  'Yes, allow always for this session':
    'Oui, toujours autoriser pour cette session',
  'Modify in progress:': 'Modification en cours :',
  'Save and close external editor to continue':
    "Enregistrez et fermez l'éditeur externe pour continuer",
  'Apply this change?': 'Appliquer cette modification ?',
  'Yes, allow always': 'Oui, toujours autoriser',
  'Modify with external editor': "Modifier avec l'éditeur externe",
  'No, suggest changes (esc)': 'Non, suggérer des modifications (échap)',
  "Allow execution of: '{{command}}'?":
    "Autoriser l'exécution de : '{{command}}' ?",
  'Yes, allow always ...': 'Oui, toujours autoriser ...',
  'Always allow in this project': 'Toujours autoriser dans ce projet',
  'Always allow {{action}} in this project':
    'Toujours autoriser {{action}} dans ce projet',
  'Always allow for this user': 'Toujours autoriser pour cet utilisateur',
  'Always allow {{action}} for this user':
    'Toujours autoriser {{action}} pour cet utilisateur',
  'Yes, restore previous mode ({{mode}})':
    'Oui, restaurer le mode précédent ({{mode}})',
  'Yes, and auto-accept edits': 'Oui, et accepter automatiquement les modifications',
  'Yes, and manually approve edits':
    'Oui, et approuver manuellement les modifications',
  'No, keep planning (esc)': 'Non, continuer la planification (échap)',
  'URLs to fetch:': 'URLs à récupérer :',
  'MCP Server: {{server}}': 'Serveur MCP : {{server}}',
  'Tool: {{tool}}': 'Outil : {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'Autoriser l\'exécution de l\'outil MCP "{{tool}}" depuis le serveur "{{server}}" ?',
  'Yes, always allow tool "{{tool}}" from server "{{server}}"':
    'Oui, toujours autoriser l\'outil "{{tool}}" depuis le serveur "{{server}}"',
  'Yes, always allow all tools from server "{{server}}"':
    'Oui, toujours autoriser tous les outils depuis le serveur "{{server}}"',

  // ============================================================================
  // Boîtes de dialogue - Confirmation shell
  // ============================================================================
  'Shell Command Execution': 'Exécution de commande shell',
  'A custom command wants to run the following shell commands:':
    'Une commande personnalisée veut exécuter les commandes shell suivantes :',

  // ============================================================================
  // Boîtes de dialogue - Quota Pro
  // ============================================================================
  'Pro quota limit reached for {{model}}.':
    'Limite de quota Pro atteinte pour {{model}}.',
  'Change auth (executes the /auth command)':
    "Changer l'authentification (exécute la commande /auth)",
  'Continue with {{model}}': 'Continuer avec {{model}}',

  // ============================================================================
  // Boîtes de dialogue - Bienvenue
  // ============================================================================
  'Current Plan:': 'Plan actuel :',
  'Progress: {{done}}/{{total}} tasks completed':
    'Progression : {{done}}/{{total}} tâches terminées',
  ', {{inProgress}} in progress': ', {{inProgress}} en cours',
  'Pending Tasks:': 'Tâches en attente :',
  'What would you like to do?': 'Que souhaitez-vous faire ?',
  'Choose how to proceed with your session:':
    'Choisissez comment poursuivre votre session :',
  'Start new chat session': 'Démarrer une nouvelle session de chat',
  'Continue previous conversation': 'Continuer la conversation précédente',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 Bon retour ! (Dernière mise à jour : {{timeAgo}})',
  '🎯 Overall Goal:': '🎯 Objectif global :',

  // ============================================================================
  // Boîtes de dialogue - Authentification
  // ============================================================================
  'Get started': 'Commencer',
  'Select Authentication Method': "Sélectionner la méthode d'authentification",
  'OpenAI API key is required to use OpenAI authentication.':
    "Une clé API OpenAI est requise pour utiliser l'authentification OpenAI.",
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    'Vous devez sélectionner une méthode d\'authentification pour continuer. Appuyez à nouveau sur Ctrl+C pour quitter.',
  'Terms of Services and Privacy Notice':
    'Conditions d\'utilisation et avis de confidentialité',
  'Qwen OAuth': 'Qwen OAuth',
  'Free \u00B7 Up to 1,000 requests/day \u00B7 Qwen latest models':
    'Gratuit · Jusqu\'à 1 000 requêtes/jour · Derniers modèles Qwen',
  'Login with QwenChat account to use daily free quota.':
    'Connectez-vous avec un compte QwenChat pour utiliser le quota gratuit quotidien.',
  'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models':
    'Payant · Jusqu\'à 6 000 requêtes/5h · Tous les modèles Alibaba Cloud Coding Plan',
  'Alibaba Cloud Coding Plan': 'Plan de codage Alibaba Cloud',
  'Bring your own API key': 'Apportez votre propre clé API',
  'API-KEY': 'CLÉ-API',
  'Use coding plan credentials or your own api-keys/providers.':
    'Utilisez les identifiants du plan de codage ou vos propres clés API/fournisseurs.',
  OpenAI: 'OpenAI',
  'Failed to login. Message: {{message}}':
    'Échec de la connexion. Message : {{message}}',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    "L'authentification est imposée à {{enforcedType}}, mais vous utilisez actuellement {{currentType}}.",
  'Qwen OAuth authentication timed out. Please try again.':
    "L'authentification Qwen OAuth a expiré. Veuillez réessayer.",
  'Qwen OAuth authentication cancelled.':
    "Authentification Qwen OAuth annulée.",
  'Qwen OAuth Authentication': 'Authentification Qwen OAuth',
  'Please visit this URL to authorize:':
    'Veuillez visiter cette URL pour autoriser :',
  'Or scan the QR code below:': 'Ou scannez le QR code ci-dessous :',
  'Waiting for authorization': "En attente d'autorisation",
  'Time remaining:': 'Temps restant :',
  '(Press ESC or CTRL+C to cancel)':
    '(Appuyez sur ÉCHAP ou CTRL+C pour annuler)',
  'Qwen OAuth Authentication Timeout': "Délai d'authentification Qwen OAuth",
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'Token OAuth expiré (plus de {{seconds}} secondes). Veuillez sélectionner à nouveau la méthode d\'authentification.',
  'Press any key to return to authentication type selection.':
    "Appuyez sur n'importe quelle touche pour revenir à la sélection du type d'authentification.",
  'Waiting for Qwen OAuth authentication...':
    "En attente de l'authentification Qwen OAuth...",
  'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.':
    'Remarque : Votre clé API existante dans settings.json ne sera pas effacée lors de l\'utilisation de Qwen OAuth. Vous pouvez revenir à l\'authentification OpenAI plus tard si nécessaire.',
  'Note: Your existing API key will not be cleared when using Qwen OAuth.':
    'Remarque : Votre clé API existante ne sera pas effacée lors de l\'utilisation de Qwen OAuth.',
  'Authentication timed out. Please try again.':
    "L'authentification a expiré. Veuillez réessayer.",
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    "En attente d'authentification... (Appuyez sur ÉCHAP ou CTRL+C pour annuler)",
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    "Clé API manquante pour l'authentification compatible OpenAI. Définissez settings.security.auth.apiKey ou la variable d'environnement {{envKeyHint}}.",
  '{{envKeyHint}} environment variable not found.':
    "Variable d'environnement {{envKeyHint}} introuvable.",
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    "Variable d'environnement {{envKeyHint}} introuvable. Veuillez la définir dans votre fichier .env ou les variables d'environnement.",
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    "Variable d'environnement {{envKeyHint}} introuvable (ou définissez settings.security.auth.apiKey). Veuillez la définir dans votre fichier .env ou les variables d'environnement.",
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    "Clé API manquante pour l'authentification compatible OpenAI. Définissez la variable d'environnement {{envKeyHint}}.",
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'Le fournisseur Anthropic manque le baseUrl requis dans modelProviders[].baseUrl.',
  'ANTHROPIC_BASE_URL environment variable not found.':
    "Variable d'environnement ANTHROPIC_BASE_URL introuvable.",
  'Invalid auth method selected.': "Méthode d'authentification invalide sélectionnée.",
  'Failed to authenticate. Message: {{message}}':
    "Échec de l'authentification. Message : {{message}}",
  'Authenticated successfully with {{authType}} credentials.':
    'Authentification réussie avec les identifiants {{authType}}.',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    'Valeur QWEN_DEFAULT_AUTH_TYPE invalide : "{{value}}". Valeurs valides : {{validValues}}',
  'OpenAI Configuration Required': 'Configuration OpenAI requise',
  'Please enter your OpenAI configuration. You can get an API key from':
    'Veuillez entrer votre configuration OpenAI. Vous pouvez obtenir une clé API depuis',
  'API Key:': 'Clé API :',
  'Invalid credentials: {{errorMessage}}':
    'Identifiants invalides : {{errorMessage}}',
  'Failed to validate credentials': 'Échec de la validation des identifiants',
  'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel':
    'Appuyez sur Entrée pour continuer, Tab/↑↓ pour naviguer, Échap pour annuler',

  // ============================================================================
  // Boîtes de dialogue - Modèle
  // ============================================================================
  'Select Model': 'Sélectionner un modèle',
  '(Press Esc to close)': '(Appuyez sur Échap pour fermer)',
  'Current (effective) configuration': 'Configuration actuelle (effective)',
  AuthType: "Type d'auth",
  'API Key': 'Clé API',
  unset: 'non défini',
  '(default)': '(par défaut)',
  '(set)': '(défini)',
  '(not set)': '(non défini)',
  Modality: 'Modalité',
  'Context Window': 'Fenêtre de contexte',
  text: 'texte',
  'text-only': 'texte uniquement',
  image: 'image',
  pdf: 'pdf',
  audio: 'audio',
  video: 'vidéo',
  'not set': 'non défini',
  none: 'aucun',
  unknown: 'inconnu',
  "Failed to switch model to '{{modelId}}'.\n\n{{error}}":
    "Échec du changement de modèle vers '{{modelId}}'.\n\n{{error}}",
  'Qwen 3.6 Plus — efficient hybrid model with leading coding performance':
    'Qwen 3.6 Plus — modèle hybride efficace avec des performances de codage de pointe',
  'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)':
    'Le dernier modèle Qwen Vision d\'Alibaba Cloud ModelStudio (version : qwen3-vl-plus-2025-09-23)',

  // ============================================================================
  // Boîtes de dialogue - Permissions
  // ============================================================================
  'Manage folder trust settings': 'Gérer les paramètres de confiance des dossiers',
  'Manage permission rules': 'Gérer les règles de permission',
  Allow: 'Autoriser',
  Ask: 'Demander',
  Deny: 'Refuser',
  Workspace: 'Espace de travail',
  "Qwen Code won't ask before using allowed tools.":
    "Qwen Code ne demandera pas avant d'utiliser les outils autorisés.",
  'Qwen Code will ask before using these tools.':
    "Qwen Code demandera avant d'utiliser ces outils.",
  'Qwen Code is not allowed to use denied tools.':
    "Qwen Code n'est pas autorisé à utiliser les outils refusés.",
  'Manage trusted directories for this workspace.':
    "Gérer les répertoires de confiance pour cet espace de travail.",
  'Any use of the {{tool}} tool': "Toute utilisation de l'outil {{tool}}",
  "{{tool}} commands matching '{{pattern}}'":
    "Commandes {{tool}} correspondant à '{{pattern}}'",
  'From user settings': 'Depuis les paramètres utilisateur',
  'From project settings': 'Depuis les paramètres du projet',
  'From session': 'Depuis la session',
  'Project settings (local)': 'Paramètres du projet (local)',
  'Saved in .qwen/settings.local.json':
    'Enregistré dans .qwen/settings.local.json',
  'Project settings': 'Paramètres du projet',
  'Checked in at .qwen/settings.json':
    'Validé dans .qwen/settings.json',
  'User settings': 'Paramètres utilisateur',
  'Saved in at ~/.qwen/settings.json':
    'Enregistré dans ~/.qwen/settings.json',
  'Add a new rule…': 'Ajouter une nouvelle règle…',
  'Add {{type}} permission rule': 'Ajouter une règle de permission {{type}}',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    'Les règles de permission sont un nom d\'outil, suivi optionnellement d\'un spécificateur entre parenthèses.',
  'e.g.,': 'ex.,',
  or: 'ou',
  'Enter permission rule…': 'Entrer une règle de permission…',
  'Enter to submit · Esc to cancel':
    'Entrée pour soumettre · Échap pour annuler',
  'Where should this rule be saved?':
    'Où cette règle doit-elle être enregistrée ?',
  'Enter to confirm · Esc to cancel':
    'Entrée pour confirmer · Échap pour annuler',
  'Delete {{type}} rule?': 'Supprimer la règle {{type}} ?',
  'Are you sure you want to delete this permission rule?':
    'Êtes-vous sûr de vouloir supprimer cette règle de permission ?',
  'Permissions:': 'Permissions :',
  '(←/→ or tab to cycle)': '(←/→ ou tab pour cycler)',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    'Appuyez sur ↑↓ pour naviguer · Entrée pour sélectionner · Tapez pour rechercher · Échap pour annuler',
  'Search…': 'Rechercher…',
  'Use /trust to manage folder trust settings for this workspace.':
    'Utilisez /trust pour gérer les paramètres de confiance des dossiers pour cet espace de travail.',
  'Add directory…': 'Ajouter un répertoire…',
  'Add directory to workspace': "Ajouter un répertoire à l'espace de travail",
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    "Qwen Code peut lire les fichiers dans l'espace de travail et effectuer des modifications lorsque l'acceptation automatique est activée.",
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    "Qwen Code pourra lire les fichiers dans ce répertoire et effectuer des modifications lorsque l'acceptation automatique est activée.",
  'Enter the path to the directory:': 'Entrez le chemin vers le répertoire :',
  'Enter directory path…': 'Entrez le chemin du répertoire…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab pour compléter · Entrée pour ajouter · Échap pour annuler',
  'Remove directory?': 'Supprimer le répertoire ?',
  'Are you sure you want to remove this directory from the workspace?':
    "Êtes-vous sûr de vouloir supprimer ce répertoire de l'espace de travail ?",
  '  (Original working directory)': '  (Répertoire de travail d\'origine)',
  '  (from settings)': '  (depuis les paramètres)',
  'Directory does not exist.': "Le répertoire n'existe pas.",
  'Path is not a directory.': "Le chemin n'est pas un répertoire.",
  'This directory is already in the workspace.':
    "Ce répertoire est déjà dans l'espace de travail.",
  'Already covered by existing directory: {{dir}}':
    'Déjà couvert par le répertoire existant : {{dir}}',

  // ============================================================================
  // Barre de statut
  // ============================================================================
  'Using:': 'Utilisation :',
  '{{count}} open file': '{{count}} fichier ouvert',
  '{{count}} open files': '{{count}} fichiers ouverts',
  '(ctrl+g to view)': '(ctrl+g pour afficher)',
  '{{count}} {{name}} file': '{{count}} fichier {{name}}',
  '{{count}} {{name}} files': '{{count}} fichiers {{name}}',
  '{{count}} MCP server': '{{count}} serveur MCP',
  '{{count}} MCP servers': '{{count}} serveurs MCP',
  '{{count}} Blocked': '{{count}} bloqué(s)',
  '(ctrl+t to view)': '(ctrl+t pour afficher)',
  '(ctrl+t to toggle)': '(ctrl+t pour basculer)',
  'Press Ctrl+C again to exit.': 'Appuyez à nouveau sur Ctrl+C pour quitter.',
  'Press Ctrl+D again to exit.': 'Appuyez à nouveau sur Ctrl+D pour quitter.',
  'Press Esc again to clear.': 'Appuyez à nouveau sur Échap pour effacer.',

  // ============================================================================
  // Statut MCP
  // ============================================================================
  'No MCP servers configured.': 'Aucun serveur MCP configuré.',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ Les serveurs MCP démarrent ({{count}} en initialisation)...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    'Remarque : Le premier démarrage peut prendre plus de temps. La disponibilité des outils se mettra à jour automatiquement.',
  'Configured MCP servers:': 'Serveurs MCP configurés :',
  Ready: 'Prêt',
  'Starting... (first startup may take longer)':
    'Démarrage... (le premier démarrage peut prendre plus de temps)',
  Disconnected: 'Déconnecté',
  '{{count}} tool': '{{count}} outil',
  '{{count}} tools': '{{count}} outils',
  '{{count}} prompt': '{{count}} invite',
  '{{count}} prompts': '{{count}} invites',
  '(from {{extensionName}})': '(depuis {{extensionName}})',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth expiré',
  'OAuth not authenticated': 'OAuth non authentifié',
  'tools and prompts will appear when ready':
    'les outils et invites apparaîtront quand prêts',
  '{{count}} tools cached': '{{count}} outils mis en cache',
  'Tools:': 'Outils :',
  'Parameters:': 'Paramètres :',
  'Prompts:': 'Invites :',
  Blocked: 'Bloqué',
  '💡 Tips:': '💡 Conseils :',
  Use: 'Utilisez',
  'to show server and tool descriptions':
    'pour afficher les descriptions des serveurs et des outils',
  'to show tool parameter schemas':
    'pour afficher les schémas de paramètres des outils',
  'to hide descriptions': 'pour masquer les descriptions',
  'to authenticate with OAuth-enabled servers':
    'pour authentifier avec des serveurs compatibles OAuth',
  Press: 'Appuyez sur',
  'to toggle tool descriptions on/off':
    'pour activer/désactiver les descriptions des outils',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "Démarrage de l'authentification OAuth pour le serveur MCP '{{name}}'...",
  'Restarting MCP servers...': 'Redémarrage des serveurs MCP...',

  // ============================================================================
  // Conseils de démarrage
  // ============================================================================
  'Tips:': 'Conseils :',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    'Utilisez /compress quand la conversation devient longue pour résumer l\'historique et libérer le contexte.',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    'Commencez une nouvelle idée avec /clear ou /new ; la session précédente reste disponible dans l\'historique.',
  'Use /bug to submit issues to the maintainers when something goes off.':
    'Utilisez /bug pour soumettre des problèmes aux mainteneurs quand quelque chose ne va pas.',
  'Switch auth type quickly with /auth.':
    'Changez rapidement le type d\'authentification avec /auth.',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    'Vous pouvez exécuter n\'importe quelle commande shell depuis Qwen Code en utilisant ! (ex. !ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    'Tapez / pour ouvrir le menu des commandes ; Tab autocompléte les commandes slash et les invites sauvegardées.',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    'Vous pouvez reprendre une conversation précédente en exécutant qwen --continue ou qwen --resume.',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'Vous pouvez changer rapidement le mode de permission avec Maj+Tab ou /approval-mode.',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    'Vous pouvez changer rapidement le mode de permission avec Tab ou /approval-mode.',
  'Try /insight to generate personalized insights from your chat history.':
    'Essayez /insight pour générer des insights personnalisés depuis votre historique de chat.',

  // ============================================================================
  // Écran de sortie / Stats
  // ============================================================================
  'Agent powering down. Goodbye!': 'Agent en cours d\'arrêt. Au revoir !',
  'To continue this session, run': 'Pour continuer cette session, exécutez',
  'Interaction Summary': "Résumé de l'interaction",
  'Session ID:': 'ID de session :',
  'Tool Calls:': "Appels d'outils :",
  'Success Rate:': 'Taux de succès :',
  'User Agreement:': "Accord de l'utilisateur :",
  reviewed: 'révisé',
  'Code Changes:': 'Modifications du code :',
  Performance: 'Performance',
  'Wall Time:': 'Temps réel :',
  'Agent Active:': 'Agent actif :',
  'API Time:': 'Temps API :',
  'Tool Time:': "Temps d'outil :",
  'Session Stats': 'Stats de session',
  'Model Usage': 'Utilisation du modèle',
  Reqs: 'Req.',
  'Input Tokens': "Tokens d'entrée",
  'Output Tokens': 'Tokens de sortie',
  'Savings Highlight:': 'Économies notables :',
  'of input tokens were served from the cache, reducing costs.':
    "des tokens d'entrée ont été servis depuis le cache, réduisant les coûts.",
  'Tip: For a full token breakdown, run `/stats model`.':
    'Conseil : Pour une décomposition complète des tokens, exécutez `/stats model`.',
  'Model Stats For Nerds': 'Stats du modèle pour les geeks',
  'Tool Stats For Nerds': "Stats des outils pour les geeks",
  Metric: 'Métrique',
  API: 'API',
  Requests: 'Requêtes',
  Errors: 'Erreurs',
  'Avg Latency': 'Latence moyenne',
  Tokens: 'Tokens',
  Total: 'Total',
  Prompt: 'Invite',
  Cached: 'En cache',
  Thoughts: 'Réflexions',
  Tool: 'Outil',
  Output: 'Sortie',
  'No API calls have been made in this session.':
    "Aucun appel API n'a été effectué dans cette session.",
  'Tool Name': "Nom de l'outil",
  Calls: 'Appels',
  'Success Rate': 'Taux de succès',
  'Avg Duration': 'Durée moyenne',
  'User Decision Summary': "Résumé des décisions de l'utilisateur",
  'Total Reviewed Suggestions:': 'Total des suggestions révisées :',
  ' » Accepted:': ' » Acceptées :',
  ' » Rejected:': ' » Rejetées :',
  ' » Modified:': ' » Modifiées :',
  ' Overall Agreement Rate:': " Taux d'accord global :",
  'No tool calls have been made in this session.':
    "Aucun appel d'outil n'a été effectué dans cette session.",
  'Session start time is unavailable, cannot calculate stats.':
    'L\'heure de début de session est indisponible, impossible de calculer les stats.',

  // ============================================================================
  // Migration de format de commande
  // ============================================================================
  'Command Format Migration': 'Migration du format de commande',
  'Found {{count}} TOML command file:': 'Trouvé {{count}} fichier de commande TOML :',
  'Found {{count}} TOML command files:':
    'Trouvé {{count}} fichiers de commande TOML :',
  '... and {{count}} more': '... et {{count}} de plus',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'Le format TOML est obsolète. Souhaitez-vous les migrer vers le format Markdown ?',
  '(Backups will be created and original files will be preserved)':
    '(Des sauvegardes seront créées et les fichiers originaux seront conservés)',

  // ============================================================================
  // Phrases de chargement
  // ============================================================================
  'Waiting for user confirmation...':
    "En attente de la confirmation de l'utilisateur...",
  '(esc to cancel, {{time}})': '(échap pour annuler, {{time}})',

  // ============================================================================
  // Phrases de chargement amusantes
  // ============================================================================
  WITTY_LOADING_PHRASES: [
    "Je me sens chanceux",
    "Livraison d'excellence...",
    "Repeignant les empattements...",
    "Navigation dans le moisissure numérique...",
    "Consultation des esprits numériques...",
    "Réticuler les splines...",
    "Réchauffement des hamsters IA...",
    "Consultation de la conque magique...",
    "Génération d'une réplique spirituelle...",
    "Polissage des algorithmes...",
    "Ne précipitez pas la perfection (ni mon code)...",
    "Brassage de nouveaux octets...",
    "Comptage des électrons...",
    "Engagement des processeurs cognitifs...",
    "Vérification des erreurs de syntaxe dans l'univers...",
    "Un instant, optimisation de l'humour...",
    "Mélange des chutes de répliques...",
    "Démêlage des réseaux de neurones...",
    "Compilation de la brillance...",
    "Chargement de wit.exe...",
    "Invocation du nuage de sagesse...",
    "Préparation d'une réponse spirituelle...",
    "Juste une seconde, je débogue la réalité...",
    "Confusion des options...",
    "Accord des fréquences cosmiques...",
    "Création d'une réponse digne de votre patience...",
    "Compilation des 0 et des 1...",
    "Résolution des dépendances... et des crises existentielles...",
    "Défragmentation des mémoires... RAM et personnelles...",
    "Redémarrage du module humoristique...",
    "Mise en cache de l'essentiel (surtout les mèmes de chats)...",
    "Optimisation pour une vitesse ludicrous",
    "Échange de bits... ne le dites pas aux octets...",
    "Nettoyage de la mémoire... je reviens...",
    "Assemblage des internets...",
    "Conversion de café en code...",
    "Mise à jour de la syntaxe de la réalité...",
    "Recâblage des synapses...",
    "Recherche d'un point-virgule égaré...",
    "Graissage des rouages de la machine...",
    "Préchauffage des serveurs...",
    "Calibrage du condensateur de flux...",
    "Engagement de l'entraînement de l'improbabilité...",
    "Canalisation de la Force...",
    "Alignement des étoiles pour une réponse optimale...",
    "Qu'il en soit ainsi pour nous tous...",
    "Chargement de la prochaine grande idée...",
    "Juste un moment, je suis dans la zone...",
    "Préparation à vous éblouir de brillance...",
    "Juste un instant, je peaufine mon esprit...",
    "Attendez, je crée un chef-d'œuvre...",
    "Juste une seconde, je débogue l'univers...",
    "Juste un moment, j'aligne les pixels...",
    "Juste un instant, j'optimise l'humour...",
    "Juste un moment, j'accorde les algorithmes...",
    "Vitesse warp enclenchée...",
    "Extraction de plus de cristaux de Dilithium...",
    "Pas de panique...",
    "Suivre le lapin blanc...",
    "La vérité est là... quelque part...",
    "Souffler sur la cartouche...",
    "Chargement... Faites un tonneau !",
    "En attente du respawn...",
    "Finir la course de Kessel en moins de 12 parsecs...",
    "Le gâteau n'est pas un mensonge, il charge juste encore...",
    "Bidouillage de l'écran de création de personnage...",
    "Juste un moment, je cherche le bon mème...",
    "Appuyer sur 'A' pour continuer...",
    "Rassemblement de chats numériques...",
    "Polissage des pixels...",
    "Recherche d'un jeu de mots d'écran de chargement approprié...",
    "Vous distraire avec cette phrase spirituelle...",
    "Presque là... probablement...",
    "Nos hamsters travaillent aussi vite qu'ils peuvent...",
    "Donnant une tape dans le dos à Cloudy...",
    "Caressant le chat...",
    "Rickrolling mon patron...",
    "Je ne vais jamais vous abandonner, je ne vais jamais vous laisser tomber...",
    "Claquant la basse...",
    "Goûtant les snozberries...",
    "Je vais jusqu'au bout, je vais à toute vitesse...",
    "Est-ce la vraie vie ? Est-ce juste une fantaisie ?...",
    "J'ai un bon pressentiment à ce sujet...",
    "Poking l'ours...",
    "Faire des recherches sur les derniers mèmes...",
    "Trouver comment rendre ça plus spirituel...",
    "Hmm... laissez-moi réfléchir...",
    "Comment appelle-t-on un poisson sans yeux ? Un posson...",
    "Pourquoi l'ordinateur est-il allé en thérapie ? Il avait trop d'octets...",
    "Pourquoi les programmeurs n'aiment pas la nature ? Elle a trop de bugs...",
    "Pourquoi les programmeurs préfèrent le mode sombre ? Parce que la lumière attire les bugs...",
    "Pourquoi le développeur est-il fauché ? Parce qu'il a utilisé tout son cache...",
    "Que peut-on faire avec un crayon cassé ? Rien, c'est inutile...",
    "Application de la maintenance percussive...",
    "Recherche de la bonne orientation USB...",
    "S'assurer que la fumée magique reste à l'intérieur des câbles...",
    "Essai de quitter Vim...",
    "Mise en marche de la roue du hamster...",
    "Ce n'est pas un bug, c'est une fonctionnalité non documentée...",
    "Engage.",
    "Je reviendrai... avec une réponse.",
    "Mon autre processus est un TARDIS...",
    "Communion avec l'esprit machine...",
    "Laisser les pensées mariner...",
    "Je viens de me souvenir où j'ai mis mes clés...",
    "Contemplation de l'orbe...",
    "J'ai vu des choses que vous ne croiriez pas... comme un utilisateur qui lit les messages de chargement.",
    "Initiation du regard pensif...",
    "Quel est le goûter préféré d'un ordinateur ? Les microchips.",
    "Pourquoi les développeurs Java portent-ils des lunettes ? Parce qu'ils ne C# pas.",
    "Chargement du laser... pew pew !",
    "Division par zéro... je plaisante !",
    "Recherche d'un superviseur... je veux dire, traitement.",
    "Faire du bip boop.",
    "Buffering... parce que même les IAs ont besoin d'un moment.",
    "Enchevêtrement de particules quantiques pour une réponse plus rapide...",
    "Polissage du chrome... sur les algorithmes.",
    "N'êtes-vous pas diverti ? (On y travaille !)",
    "Invocation des lutins de code... pour aider, bien sûr.",
    "En attente de la tonalité du modem...",
    "Recalibrage du sens de l'humour.",
    "Mon autre écran de chargement est encore plus drôle.",
    "Je suis presque sûr qu'il y a un chat qui marche sur le clavier quelque part...",
    "Amélioration... Amélioration... Toujours en chargement.",
    "Ce n'est pas un bug, c'est une caractéristique... de cet écran de chargement.",
    "Avez-vous essayé de l'éteindre et de le rallumer ? (L'écran de chargement, pas moi.)",
    "Construction de pylônes supplémentaires...",
  ],

  // ============================================================================
  // Paramètres d'extension - Saisie
  // ============================================================================
  'Enter value...': 'Entrer une valeur...',
  'Enter sensitive value...': 'Entrer une valeur sensible...',
  'Press Enter to submit, Escape to cancel':
    'Appuyez sur Entrée pour soumettre, Échap pour annuler',

  // ============================================================================
  // Outil de migration de commandes
  // ============================================================================
  'Markdown file already exists: {{filename}}':
    'Le fichier Markdown existe déjà : {{filename}}',
  'TOML Command Format Deprecation Notice':
    'Avis d\'obsolescence du format de commande TOML',
  'Found {{count}} command file(s) in TOML format:':
    'Trouvé {{count}} fichier(s) de commande au format TOML :',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    'Le format TOML pour les commandes est en cours d\'abandon au profit du format Markdown.',
  'Markdown format is more readable and easier to edit.':
    'Le format Markdown est plus lisible et plus facile à modifier.',
  'You can migrate these files automatically using:':
    'Vous pouvez migrer ces fichiers automatiquement en utilisant :',
  'Or manually convert each file:': 'Ou convertir chaque fichier manuellement :',
  'TOML: prompt = "..." / description = "..."':
    'TOML : prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content':
    'Markdown : YAML frontmatter + contenu',
  'The migration tool will:': 'L\'outil de migration va :',
  'Convert TOML files to Markdown': 'Convertir les fichiers TOML en Markdown',
  'Create backups of original files':
    'Créer des sauvegardes des fichiers originaux',
  'Preserve all command functionality':
    'Préserver toutes les fonctionnalités des commandes',
  'TOML format will continue to work for now, but migration is recommended.':
    'Le format TOML continuera à fonctionner pour l\'instant, mais la migration est recommandée.',

  // ============================================================================
  // Extensions - Commande Explore
  // ============================================================================
  'Open extensions page in your browser':
    'Ouvrir la page des extensions dans votre navigateur',
  'Unknown extensions source: {{source}}.':
    'Source d\'extensions inconnue : {{source}}.',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    'Ouvrirait la page des extensions dans votre navigateur : {{url}} (ignoré en environnement de test)',
  'View available extensions at {{url}}':
    'Voir les extensions disponibles sur {{url}}',
  'Opening extensions page in your browser: {{url}}':
    'Ouverture de la page des extensions dans votre navigateur : {{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    'Échec de l\'ouverture du navigateur. Consultez la galerie d\'extensions sur {{url}}',

  // ============================================================================
  // Réessai / Limite de débit
  // ============================================================================
  'Rate limit error: {{reason}}': 'Erreur de limite de débit : {{reason}}',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    'Nouvelle tentative dans {{seconds}} secondes… (tentative {{attempt}}/{{maxRetries}})',
  'Press Ctrl+Y to retry': 'Appuyez sur Ctrl+Y pour réessayer',
  'No failed request to retry.':
    'Aucune requête échouée à réessayer.',
  'to retry last request': 'pour réessayer la dernière requête',

  // ============================================================================
  // Authentification du plan de codage
  // ============================================================================
  'API key cannot be empty.': 'La clé API ne peut pas être vide.',
  'You can get your Coding Plan API key here':
    'Vous pouvez obtenir votre clé API Coding Plan ici',
  'API key is stored in settings.env. You can migrate it to a .env file for better security.':
    'La clé API est stockée dans settings.env. Vous pouvez la migrer vers un fichier .env pour une meilleure sécurité.',
  'New model configurations are available for Alibaba Cloud Coding Plan. Update now?':
    'De nouvelles configurations de modèle sont disponibles pour Alibaba Cloud Coding Plan. Mettre à jour maintenant ?',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Configuration Coding Plan mise à jour avec succès. Les nouveaux modèles sont maintenant disponibles.',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    'Clé API Coding Plan introuvable. Veuillez vous réauthentifier avec Coding Plan.',
  'Failed to update Coding Plan configuration: {{message}}':
    'Échec de la mise à jour de la configuration Coding Plan : {{message}}',

  // ============================================================================
  // Configuration de clé API personnalisée
  // ============================================================================
  'You can configure your API key and models in settings.json':
    'Vous pouvez configurer votre clé API et vos modèles dans settings.json',
  'Refer to the documentation for setup instructions':
    'Consultez la documentation pour les instructions de configuration',

  // ============================================================================
  // Boîte de dialogue Auth - Titres et étiquettes
  // ============================================================================
  'Coding Plan': 'Plan de codage',
  "Paste your api key of ModelStudio Coding Plan and you're all set!":
    "Collez votre clé API de ModelStudio Coding Plan et c'est parti !",
  Custom: 'Personnalisé',
  'More instructions about configuring `modelProviders` manually.':
    'Plus d\'instructions sur la configuration manuelle de `modelProviders`.',
  'Select API-KEY configuration mode:':
    'Sélectionner le mode de configuration API-KEY :',
  '(Press Escape to go back)': '(Appuyez sur Échap pour revenir)',
  '(Press Enter to submit, Escape to cancel)':
    '(Appuyez sur Entrée pour soumettre, Échap pour annuler)',
  'Select Region for Coding Plan': 'Sélectionner la région pour Coding Plan',
  'Choose based on where your account is registered':
    "Choisissez en fonction de l'endroit où votre compte est enregistré",
  'Enter Coding Plan API Key': 'Entrer la clé API Coding Plan',

  // ============================================================================
  // Mises à jour internationales Coding Plan
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    'De nouvelles configurations de modèle sont disponibles pour {{region}}. Mettre à jour maintenant ?',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    'Configuration {{region}} mise à jour avec succès. Modèle changé en "{{model}}".',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json (backed up).':
    'Authentification réussie avec {{region}}. Clé API et configurations de modèle enregistrées dans settings.json (sauvegardé).',

  // ============================================================================
  // Composant d'utilisation du contexte
  // ============================================================================
  'Context Usage': 'Utilisation du contexte',
  'No API response yet. Send a message to see actual usage.':
    'Pas encore de réponse API. Envoyez un message pour voir l\'utilisation réelle.',
  'Estimated pre-conversation overhead':
    'Surcharge estimée avant la conversation',
  'Context window': 'Fenêtre de contexte',
  tokens: 'tokens',
  Used: 'Utilisé',
  Free: 'Libre',
  'Autocompact buffer': 'Tampon de compaction automatique',
  'Usage by category': 'Utilisation par catégorie',
  'System prompt': 'Invite système',
  'Built-in tools': 'Outils intégrés',
  'MCP tools': 'Outils MCP',
  'Memory files': 'Fichiers mémoire',
  Skills: 'Compétences',
  Messages: 'Messages',
  'Show context window usage breakdown.':
    'Afficher la répartition de l\'utilisation de la fenêtre de contexte.',
  'Run /context detail for per-item breakdown.':
    'Exécutez /context detail pour une répartition par élément.',
  'body loaded': 'corps chargé',
  memory: 'mémoire',
  '{{region}} configuration updated successfully.':
    'Configuration {{region}} mise à jour avec succès.',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    'Authentification réussie avec {{region}}. Clé API et configurations de modèle enregistrées dans settings.json.',
  'Tip: Use /model to switch between available Coding Plan models.':
    'Conseil : Utilisez /model pour basculer entre les modèles Coding Plan disponibles.',

  // ============================================================================
  // Outil de question à l'utilisateur
  // ============================================================================
  'Please answer the following question(s):':
    'Veuillez répondre à la (aux) question(s) suivante(s) :',
  'Cannot ask user questions in non-interactive mode. Please run in interactive mode to use this tool.':
    'Impossible de poser des questions à l\'utilisateur en mode non interactif. Veuillez exécuter en mode interactif pour utiliser cet outil.',
  'User declined to answer the questions.':
    "L'utilisateur a refusé de répondre aux questions.",
  'User has provided the following answers:':
    "L'utilisateur a fourni les réponses suivantes :",
  'Failed to process user answers:':
    "Échec du traitement des réponses de l'utilisateur :",
  'Type something...': 'Tapez quelque chose...',
  Submit: 'Soumettre',
  'Submit answers': 'Soumettre les réponses',
  Cancel: 'Annuler',
  'Your answers:': 'Vos réponses :',
  '(not answered)': '(sans réponse)',
  'Ready to submit your answers?': 'Prêt à soumettre vos réponses ?',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓ : Naviguer | ←/→ : Changer d\'onglet | Entrée : Sélectionner',
  '↑/↓: Navigate | ←/→: Switch tabs | Space/Enter: Toggle | Esc: Cancel':
    '↑/↓ : Naviguer | ←/→ : Changer d\'onglet | Espace/Entrée : Basculer | Échap : Annuler',
  '↑/↓: Navigate | Space/Enter: Toggle | Esc: Cancel':
    '↑/↓ : Naviguer | Espace/Entrée : Basculer | Échap : Annuler',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓ : Naviguer | Entrée : Sélectionner | Échap : Annuler',

  // ============================================================================
  // Commandes - Auth
  // ============================================================================
  'Configure Qwen authentication information with Qwen-OAuth or Alibaba Cloud Coding Plan':
    'Configurer les informations d\'authentification Qwen avec Qwen-OAuth ou Alibaba Cloud Coding Plan',
  'Authenticate using Qwen OAuth': 'Authentifier avec Qwen OAuth',
  'Authenticate using Alibaba Cloud Coding Plan':
    'Authentifier avec Alibaba Cloud Coding Plan',
  'Region for Coding Plan (china/global)':
    'Région pour Coding Plan (china/global)',
  'API key for Coding Plan': 'Clé API pour Coding Plan',
  'Show current authentication status':
    "Afficher le statut d'authentification actuel",
  'Authentication completed successfully.':
    'Authentification terminée avec succès.',
  'Starting Qwen OAuth authentication...':
    'Démarrage de l\'authentification Qwen OAuth...',
  'Successfully authenticated with Qwen OAuth.':
    'Authentification réussie avec Qwen OAuth.',
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'Échec de l\'authentification avec Qwen OAuth : {{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    'Traitement de l\'authentification Alibaba Cloud Coding Plan...',
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    'Authentification réussie avec Alibaba Cloud Coding Plan.',
  'Failed to authenticate with Coding Plan: {{error}}':
    'Échec de l\'authentification avec Coding Plan : {{error}}',
  '中国 (China)': '中国 (Chine)',
  '阿里云百炼 (aliyun.com)': '阿里云百炼 (aliyun.com)',
  Global: 'Global',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': 'Sélectionner la région pour Coding Plan :',
  'Enter your Coding Plan API key: ': 'Entrez votre clé API Coding Plan : ',
  'Select authentication method:': "Sélectionner la méthode d'authentification :",
  '\n=== Authentication Status ===\n': '\n=== Statut d\'authentification ===\n',
  '⚠️  No authentication method configured.\n':
    '⚠️  Aucune méthode d\'authentification configurée.\n',
  'Run one of the following commands to get started:\n':
    'Exécutez l\'une des commandes suivantes pour commencer :\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (free tier)':
    '  qwen auth qwen-oauth     - Authentifier avec Qwen OAuth (niveau gratuit)',
  '  qwen auth coding-plan      - Authenticate with Alibaba Cloud Coding Plan\n':
    '  qwen auth coding-plan      - Authentifier avec Alibaba Cloud Coding Plan\n',
  'Or simply run:': 'Ou simplement exécutez :',
  '  qwen auth                - Interactive authentication setup\n':
    '  qwen auth                - Configuration d\'authentification interactive\n',
  '✓ Authentication Method: Qwen OAuth':
    '✓ Méthode d\'authentification : Qwen OAuth',
  '  Type: Free tier': '  Type : Niveau gratuit',
  '  Limit: Up to 1,000 requests/day':
    '  Limite : Jusqu\'à 1 000 requêtes/jour',
  '  Models: Qwen latest models\n': '  Modèles : Derniers modèles Qwen\n',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    '✓ Méthode d\'authentification : Alibaba Cloud Coding Plan',
  '中国 (China) - 阿里云百炼': '中国 (Chine) - 阿里云百炼',
  'Global - Alibaba Cloud': 'Global - Alibaba Cloud',
  '  Region: {{region}}': '  Région : {{region}}',
  '  Current Model: {{model}}': '  Modèle actuel : {{model}}',
  '  Config Version: {{version}}': '  Version de config : {{version}}',
  '  Status: API key configured\n':
    '  Statut : Clé API configurée\n',
  '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    '⚠️  Méthode d\'authentification : Alibaba Cloud Coding Plan (Incomplète)',
  '  Issue: API key not found in environment or settings\n':
    '  Problème : Clé API introuvable dans l\'environnement ou les paramètres\n',
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  Exécutez `qwen auth coding-plan` pour reconfigurer.\n',
  '✓ Authentication Method: {{type}}':
    '✓ Méthode d\'authentification : {{type}}',
  '  Status: Configured\n': '  Statut : Configuré\n',
  'Failed to check authentication status: {{error}}':
    'Échec de la vérification du statut d\'authentification : {{error}}',
  'Select an option:': 'Sélectionner une option :',
  'Raw mode not available. Please run in an interactive terminal.':
    'Mode brut non disponible. Veuillez exécuter dans un terminal interactif.',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(Utilisez les flèches ↑ ↓ pour naviguer, Entrée pour sélectionner, Ctrl+C pour quitter)\n',
  compact: 'compact',
  'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).':
    'Masquer la sortie des outils et la réflexion pour une vue plus nette (basculer avec Ctrl+O).',
  'Press Ctrl+O to show full tool output':
    'Appuyez sur Ctrl+O pour afficher la sortie complète des outils',

  'Switch to plan mode or exit plan mode':
    'Passer en mode plan ou quitter le mode plan',
  'Exited plan mode. Previous approval mode restored.':
    'Mode plan quitté. Mode d\'approbation précédent restauré.',
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    'Mode plan activé. L\'agent analysera et planifiera sans exécuter d\'outils.',
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    'Déjà en mode plan. Utilisez "/plan exit" pour quitter le mode plan.',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    'Pas en mode plan. Utilisez "/plan" pour entrer en mode plan d\'abord.',

  "Set up Qwen Code's status line UI":
    "Configurer l'interface de la barre de statut de Qwen Code",
};
