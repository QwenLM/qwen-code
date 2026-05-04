/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Traduccions en català per al CLI de Qwen Code per Jordi Mas i Hernàndez <jmas@softcatala.org>

export default {
  // ============================================================================
  // Ajuda / Components de la interfície
  // ============================================================================
  '↑ to manage attachments': '↑ per gestionar els adjunts',
  '← → select, Delete to remove, ↓ to exit':
    '← → seleccionar, Supr per eliminar, ↓ per sortir',
  'Attachments: ': 'Adjunts: ',

  'Basics:': 'Bàsic:',
  'Add context': 'Afegir context',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    'Useu {{symbol}} per especificar fitxers de context (p. ex., {{example}}) per seleccionar fitxers o carpetes específics.',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Mode shell',
  'YOLO mode': 'Mode YOLO',
  'plan mode': 'mode de planificació',
  'auto-accept edits': 'acceptació automàtica de canvis',
  'Accepting edits': 'Acceptant canvis',
  '(shift + tab to cycle)': '(maj + tab per canviar)',
  '(tab to cycle)': '(tab per canviar)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    'Executeu ordres shell amb {{symbol}} (p. ex., {{example1}}) o useu el llenguatge natural (p. ex., {{example2}}).',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'iniciar el servidor',
  'Commands:': 'Ordres:',
  'shell command': 'ordre shell',
  'Model Context Protocol command (from external servers)':
    'Ordre del protocol de context del model (des de servidors externs)',
  'Keyboard Shortcuts:': 'Dreceres de teclat:',
  'Toggle this help display': 'Mostrar/amagar aquesta ajuda',
  'Toggle shell mode': 'Canviar el mode shell',
  'Open command menu': "Obrir el menú d'ordres",
  'Add file context': 'Afegir context de fitxer',
  'Accept suggestion / Autocomplete': 'Acceptar suggeriment / Autocompleció',
  'Reverse search history': "Cerca inversa a l'historial",
  'Press ? again to close': 'Premeu ? de nou per tancar',
  'for shell mode': 'per al mode shell',
  'for commands': 'per a les ordres',
  'for file paths': 'per als camins de fitxers',
  'to clear input': "per esborrar l'entrada",
  'to cycle approvals': 'per canviar les aprovacions',
  'to quit': 'per sortir',
  'for newline': 'per a nova línia',
  'to clear screen': 'per netejar la pantalla',
  'to search history': "per cercar a l'historial",
  'to paste images': 'per enganxar imatges',
  'for external editor': 'per a editor extern',
  'to toggle compact mode': 'per canviar el mode compacte',
  'Jump through words in the input': "Saltar entre paraules a l'entrada",
  'Close dialogs, cancel requests, or quit application':
    "Tancar diàlegs, cancel·lar peticions o sortir de l'aplicació",
  'New line': 'Nova línia',
  'New line (Alt+Enter works for certain linux distros)':
    'Nova línia (Alt+Retorn funciona en certes distribucions de Linux)',
  'Clear the screen': 'Netejar la pantalla',
  'Open input in external editor': "Obrir l'entrada en un editor extern",
  'Send message': 'Enviar missatge',
  'Initializing...': 'Inicialitzant...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    'Connectant als servidors MCP... ({{connected}}/{{total}})',
  'Type your message or @path/to/file':
    'Escriviu el vostre missatge o @camí/al/fitxer',
  '? for shortcuts': '? per a dreceres',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "Premeu 'i' per al mode INSERCIÓ i 'Esc' per al mode NORMAL.",
  'Cancel operation / Clear input (double press)':
    'Cancel·lar operació / Esborrar entrada (doble premuda)',
  'Cycle approval modes': "Canviar els modes d'aprovació",
  'Cycle through your prompt history': "Navegar per l'historial de missatges",
  'For a full list of shortcuts, see {{docPath}}':
    'Per a una llista completa de dreceres, vegeu {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': 'per a ajuda sobre Qwen Code',
  'show version info': 'mostrar informació de la versió',
  'submit a bug report': "enviar un informe d'error",
  'About Qwen Code': 'Sobre Qwen Code',
  Status: 'Estat',

  // ============================================================================
  // Informació del sistema
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: "Entorn d'execució",
  OS: 'SO',
  Auth: 'Autenticació',
  'CLI Version': 'Versió del CLI',
  'Git Commit': 'Commit de Git',
  Model: 'Model',
  'Fast Model': 'Model ràpid',
  Sandbox: 'Entorn aïllat',
  'OS Platform': 'Plataforma del SO',
  'OS Arch': 'Arquitectura del SO',
  'OS Release': 'Versió del SO',
  'Node.js Version': 'Versió de Node.js',
  'NPM Version': 'Versió de NPM',
  'Session ID': 'ID de sessió',
  'Auth Method': "Mètode d'autenticació",
  'Base URL': 'URL base',
  Proxy: 'Proxy',
  'Memory Usage': 'Ús de memòria',
  'IDE Client': 'Client IDE',

  // ============================================================================
  // Ordres - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Analitza el projecte i crea un fitxer QWEN.md personalitzat.',
  'List available Qwen Code tools. Usage: /tools [desc]':
    'Llistar les eines disponibles de Qwen Code. Ús: /tools [desc]',
  'List available skills.': 'Llistar les habilitats disponibles.',
  'Available Qwen Code CLI tools:': 'Eines del CLI de Qwen Code disponibles:',
  'No tools available': 'No hi ha eines disponibles',
  'View or change the approval mode for tool usage':
    "Veure o canviar el mode d'aprovació per a l'ús d'eines",
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    'Mode d\'aprovació no vàlid "{{arg}}". Modes vàlids: {{modes}}',
  'Approval mode set to "{{mode}}"': 'Mode d\'aprovació establert a "{{mode}}"',
  'View or change the language setting':
    "Veure o canviar la configuració d'idioma",
  'change the theme': 'canviar el tema',
  'Select Theme': 'Seleccionar tema',
  Preview: 'Previsualització',
  '(Use Enter to select, Tab to configure scope)':
    "(Useu Retorn per seleccionar, Tab per configurar l'àmbit)",
  '(Use Enter to apply scope, Tab to go back)':
    "(Useu Retorn per aplicar l'àmbit, Tab per tornar enrere)",
  'Theme configuration unavailable due to NO_COLOR env variable.':
    "La configuració del tema no està disponible degut a la variable d'entorn NO_COLOR.",
  'Theme "{{themeName}}" not found.': 'Tema "{{themeName}}" no trobat.',
  'Theme "{{themeName}}" not found in selected scope.':
    'Tema "{{themeName}}" no trobat en l\'àmbit seleccionat.',
  'Clear conversation history and free up context':
    "Esborrar l'historial de la conversa i alliberar context",
  'Compresses the context by replacing it with a summary.':
    'Comprimeix el context substituint-lo per un resum.',
  'open full Qwen Code documentation in your browser':
    'obrir la documentació completa de Qwen Code al navegador',
  'Configuration not available.': 'Configuració no disponible.',
  'change the auth method': "canviar el mètode d'autenticació",
  'Configure authentication information for login':
    "Configurar la informació d'autenticació per a iniciar sessió",
  'Copy the last result or code snippet to clipboard':
    "Copiar l'últim resultat o fragment de codi al porta-retalls",

  // ============================================================================
  // Ordres - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    'Gestionar subagents per a la delegació de tasques especialitzades.',
  'Manage existing subagents (view, edit, delete).':
    'Gestionar subagents existents (veure, editar, eliminar).',
  'Create a new subagent with guided setup.':
    'Crear un nou subagent amb configuració guiada.',

  // ============================================================================
  // Agents - Diàleg de gestió
  // ============================================================================
  Agents: 'Agents',
  'Choose Action': 'Triar acció',
  'Edit {{name}}': 'Editar {{name}}',
  'Edit Tools: {{name}}': 'Editar eines: {{name}}',
  'Edit Color: {{name}}': 'Editar color: {{name}}',
  'Delete {{name}}': 'Eliminar {{name}}',
  'Unknown Step': 'Pas desconegut',
  'Esc to close': 'Esc per tancar',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Retorn per seleccionar, ↑↓ per navegar, Esc per tancar',
  'Esc to go back': 'Esc per tornar enrere',
  'Enter to confirm, Esc to cancel': 'Retorn per confirmar, Esc per cancel·lar',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Retorn per seleccionar, ↑↓ per navegar, Esc per tornar enrere',
  'Enter to submit, Esc to go back': 'Retorn per enviar, Esc per tornar enrere',
  'Invalid step: {{step}}': 'Pas no vàlid: {{step}}',
  'No subagents found.': "No s'han trobat subagents.",
  "Use '/agents create' to create your first subagent.":
    "Useu '/agents create' per crear el vostre primer subagent.",
  '(built-in)': '(integrat)',
  '(overridden by project level agent)':
    '(sobreescrit per un agent de nivell de projecte)',
  'Project Level ({{path}})': 'Nivell de projecte ({{path}})',
  'User Level ({{path}})': "Nivell d'usuari ({{path}})",
  'Built-in Agents': 'Agents integrats',
  'Extension Agents': "Agents d'extensió",
  'Using: {{count}} agents': 'En ús: {{count}} agents',
  'View Agent': 'Veure agent',
  'Edit Agent': 'Editar agent',
  'Delete Agent': 'Eliminar agent',
  Back: 'Enrere',
  'No agent selected': 'Cap agent seleccionat',
  'File Path: ': 'Camí del fitxer: ',
  'Tools: ': 'Eines: ',
  'Color: ': 'Color: ',
  'Description:': 'Descripció:',
  'System Prompt:': 'Missatge del sistema:',
  'Open in editor': "Obrir a l'editor",
  'Edit tools': 'Editar eines',
  'Edit color': 'Editar color',
  '❌ Error:': '❌ Error:',
  'Are you sure you want to delete agent "{{name}}"?':
    'Esteu segur que voleu eliminar l\'agent "{{name}}"?',

  // ============================================================================
  // Agents - Assistent de creació
  // ============================================================================
  'Project Level (.qwen/agents/)': 'Nivell de projecte (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': "Nivell d'usuari (~/.qwen/agents/)",
  '✅ Subagent Created Successfully!': '✅ Subagent creat correctament!',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    'El subagent "{{name}}" s\'ha desat al nivell {{level}}.',
  'Name: ': 'Nom: ',
  'Location: ': 'Ubicació: ',
  '❌ Error saving subagent:': '❌ Error en desar el subagent:',
  'Warnings:': 'Advertències:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    'El nom "{{name}}" ja existeix al nivell {{level}} - sobreescriurà el subagent existent',
  'Name "{{name}}" exists at user level - project level will take precedence':
    'El nom "{{name}}" existeix al nivell d\'usuari - el nivell de projecte tindrà prioritat',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    'El nom "{{name}}" existeix al nivell de projecte - el subagent existent tindrà prioritat',
  'Description is over {{length}} characters':
    'La descripció supera els {{length}} caràcters',
  'System prompt is over {{length}} characters':
    'El missatge del sistema supera els {{length}} caràcters',
  'Step {{n}}: Choose Location': 'Pas {{n}}: Triar ubicació',
  'Step {{n}}: Choose Generation Method':
    'Pas {{n}}: Triar mètode de generació',
  'Generate with Qwen Code (Recommended)': 'Generar amb Qwen Code (Recomanat)',
  'Manual Creation': 'Creació manual',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    "Descriviu què ha de fer aquest subagent i quan s'ha d'usar. (Sigueu exhaustiu per obtenir els millors resultats)",
  'e.g., Expert code reviewer that reviews code based on best practices...':
    'p. ex., Revisor de codi expert que revisa el codi seguint les millors pràctiques...',
  'Generating subagent configuration...':
    'Generant la configuració del subagent...',
  'Failed to generate subagent: {{error}}':
    'Error en generar el subagent: {{error}}',
  'Step {{n}}: Describe Your Subagent':
    'Pas {{n}}: Descriure el vostre subagent',
  'Step {{n}}: Enter Subagent Name': 'Pas {{n}}: Introduir el nom del subagent',
  'Step {{n}}: Enter System Prompt':
    'Pas {{n}}: Introduir el missatge del sistema',
  'Step {{n}}: Enter Description': 'Pas {{n}}: Introduir la descripció',
  'Step {{n}}: Select Tools': 'Pas {{n}}: Seleccionar eines',
  'All Tools (Default)': 'Totes les eines (per defecte)',
  'All Tools': 'Totes les eines',
  'Read-only Tools': 'Eines de només lectura',
  'Read & Edit Tools': 'Eines de lectura i edició',
  'Read & Edit & Execution Tools': 'Eines de lectura, edició i execució',
  'All tools selected, including MCP tools':
    'Totes les eines seleccionades, incloses les eines MCP',
  'Selected tools:': 'Eines seleccionades:',
  'Read-only tools:': 'Eines de només lectura:',
  'Edit tools:': "Eines d'edició:",
  'Execution tools:': "Eines d'execució:",
  'Step {{n}}: Choose Background Color': 'Pas {{n}}: Triar el color de fons',
  'Step {{n}}: Confirm and Save': 'Pas {{n}}: Confirmar i desar',
  'Esc to cancel': 'Esc per cancel·lar',
  'Press Enter to save, e to save and edit, Esc to go back':
    'Premeu Retorn per desar, e per desar i editar, Esc per tornar enrere',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    'Premeu Retorn per continuar, {{navigation}}Esc per {{action}}',
  cancel: 'cancel·lar',
  'go back': 'tornar enrere',
  '↑↓ to navigate, ': '↑↓ per navegar, ',
  'Enter a clear, unique name for this subagent.':
    'Introduïu un nom clar i únic per a aquest subagent.',
  'e.g., Code Reviewer': 'p. ex., Revisor de codi',
  'Name cannot be empty.': 'El nom no pot estar buit.',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    "Escriviu el missatge del sistema que defineix el comportament d'aquest subagent. Sigueu exhaustiu per obtenir els millors resultats.",
  'e.g., You are an expert code reviewer...':
    'p. ex., Sou un revisor de codi expert...',
  'System prompt cannot be empty.':
    'El missatge del sistema no pot estar buit.',
  'Describe when and how this subagent should be used.':
    "Descriviu quan i com s'ha d'usar aquest subagent.",
  'e.g., Reviews code for best practices and potential bugs.':
    'p. ex., Revisa el codi seguint les millors pràctiques i detectant errors potencials.',
  'Description cannot be empty.': 'La descripció no pot estar buida.',
  'Failed to launch editor: {{error}}': "Error en iniciar l'editor: {{error}}",
  'Failed to save and edit subagent: {{error}}':
    'Error en desar i editar el subagent: {{error}}',

  // ============================================================================
  // Extensions - Diàleg de gestió
  // ============================================================================
  'Manage Extensions': 'Gestionar extensions',
  'Extension Details': "Detalls de l'extensió",
  'View Extension': "Veure l'extensió",
  'Update Extension': "Actualitzar l'extensió",
  'Disable Extension': "Desactivar l'extensió",
  'Enable Extension': "Activar l'extensió",
  'Uninstall Extension': "Desinstal·lar l'extensió",
  'Select Scope': "Seleccionar l'àmbit",
  'User Scope': "Àmbit d'usuari",
  'Workspace Scope': "Àmbit de l'espai de treball",
  'No extensions found.': "No s'han trobat extensions.",
  Active: 'Activa',
  Disabled: 'Desactivada',
  'Update available': 'Actualització disponible',
  'Up to date': 'Al dia',
  'Checking...': 'Comprovant...',
  'Updating...': 'Actualitzant...',
  Unknown: 'Desconegut',
  Error: 'Error',
  'Version:': 'Versió:',
  'Status:': 'Estat:',
  'Are you sure you want to uninstall extension "{{name}}"?':
    'Esteu segur que voleu desinstal·lar l\'extensió "{{name}}"?',
  'This action cannot be undone.': 'Aquesta acció no es pot desfer.',
  'Extension "{{name}}" disabled successfully.':
    'L\'extensió "{{name}}" s\'ha desactivat correctament.',
  'Extension "{{name}}" enabled successfully.':
    'L\'extensió "{{name}}" s\'ha activat correctament.',
  'Extension "{{name}}" updated successfully.':
    'L\'extensió "{{name}}" s\'ha actualitzat correctament.',
  'Failed to update extension "{{name}}": {{error}}':
    'Error en actualitzar l\'extensió "{{name}}": {{error}}',
  'Select the scope for this action:':
    "Seleccioneu l'àmbit per a aquesta acció:",
  'User - Applies to all projects': "Usuari - S'aplica a tots els projectes",
  'Workspace - Applies to current project only':
    "Espai de treball - S'aplica només al projecte actual",
  'Name:': 'Nom:',
  'MCP Servers:': 'Servidors MCP:',
  'Settings:': 'Configuració:',
  active: 'activa',
  disabled: 'desactivada',
  'View Details': 'Veure detalls',
  'Update failed:': "Error en l'actualització:",
  'Updating {{name}}...': 'Actualitzant {{name}}...',
  'Update complete!': 'Actualització completada!',
  'User (global)': 'Usuari (global)',
  'Workspace (project-specific)': 'Espai de treball (específic del projecte)',
  'Disable "{{name}}" - Select Scope':
    'Desactivar "{{name}}" - Seleccionar àmbit',
  'Enable "{{name}}" - Select Scope': 'Activar "{{name}}" - Seleccionar àmbit',
  'No extension selected': 'Cap extensió seleccionada',
  'Press Y/Enter to confirm, N/Esc to cancel':
    'Premeu Y/Retorn per confirmar, N/Esc per cancel·lar',
  'Y/Enter to confirm, N/Esc to cancel':
    'Y/Retorn per confirmar, N/Esc per cancel·lar',
  '{{count}} extensions installed': '{{count}} extensions instal·lades',
  "Use '/extensions install' to install your first extension.":
    "Useu '/extensions install' per instal·lar la vostra primera extensió.",
  'up to date': 'al dia',
  'update available': 'actualització disponible',
  'checking...': 'comprovant...',
  'not updatable': 'no actualitzable',
  error: 'error',

  // ============================================================================
  // Ordres - General (continuació)
  // ============================================================================
  'View and edit Qwen Code settings':
    'Veure i editar la configuració de Qwen Code',
  Settings: 'Configuració',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'Per veure els canvis, cal reiniciar Qwen Code. Premeu r per sortir i aplicar els canvis ara.',
  'The command "/{{command}}" is not supported in non-interactive mode.':
    'L\'ordre "/{{command}}" no és compatible en mode no interactiu.',

  // ============================================================================
  // Etiquetes de configuració
  // ============================================================================
  'Vim Mode': 'Mode Vim',
  'Disable Auto Update': 'Desactivar actualització automàtica',
  'Attribution: commit': 'Atribució: commit',
  'Terminal Bell Notification': 'Notificació de campana del terminal',
  'Enable Usage Statistics': "Activar estadístiques d'ús",
  Theme: 'Tema',
  'Preferred Editor': 'Editor preferit',
  'Auto-connect to IDE': 'Connexió automàtica a IDE',
  'Enable Prompt Completion': 'Activar la compleció de missatges',
  'Debug Keystroke Logging': 'Registre de tecles per a depuració',
  'Language: UI': 'Idioma: Interfície',
  'Language: Model': 'Idioma: Model',
  'Output Format': 'Format de sortida',
  'Hide Window Title': 'Amagar el títol de la finestra',
  'Show Status in Title': "Mostrar l'estat al títol",
  'Hide Tips': 'Amagar consells',
  'Show Line Numbers in Code': 'Mostrar números de línia al codi',
  'Show Citations': 'Mostrar cites',
  'Custom Witty Phrases': 'Frases enginyoses personalitzades',
  'Show Welcome Back Dialog': 'Mostrar el diàleg de benvinguda',
  'Enable User Feedback': 'Activar les valoracions dels usuaris',
  'How is Qwen doing this session? (optional)':
    'Com va Qwen en aquesta sessió? (opcional)',
  Bad: 'Malament',
  Fine: 'Bé',
  Good: 'Molt bé',
  Dismiss: 'Descartar',
  'Not Sure Yet': 'Encara no estic segur',
  'Any other key': 'Qualsevol altra tecla',
  'Disable Loading Phrases': 'Desactivar frases de càrrega',
  'Screen Reader Mode': 'Mode de lector de pantalla',
  'IDE Mode': 'Mode IDE',
  'Max Session Turns': 'Torns màxims de sessió',
  'Skip Next Speaker Check': 'Ometre la comprovació del proper parlant',
  'Skip Loop Detection': 'Ometre la detecció de bucles',
  'Skip Startup Context': "Ometre el context d'inici",
  'Enable OpenAI Logging': "Activar el registre d'OpenAI",
  'OpenAI Logging Directory': "Directori de registres d'OpenAI",
  Timeout: "Temps d'espera",
  'Max Retries': 'Reintents màxims',
  'Disable Cache Control': 'Desactivar el control de memòria cau',
  'Memory Discovery Max Dirs': 'Directoris màxims de descoberta de memòria',
  'Load Memory From Include Directories':
    'Carregar memòria des dels directoris inclosos',
  'Respect .gitignore': 'Respectar .gitignore',
  'Respect .qwenignore': 'Respectar .qwenignore',
  'Enable Recursive File Search': 'Activar la cerca recursiva de fitxers',
  'Disable Fuzzy Search': 'Desactivar la cerca difusa',
  'Interactive Shell (PTY)': 'Shell interactiva (PTY)',
  'Show Color': 'Mostrar color',
  'Auto Accept': 'Acceptació automàtica',
  'Use Ripgrep': 'Usar Ripgrep',
  'Use Builtin Ripgrep': 'Usar Ripgrep integrat',
  'Enable Tool Output Truncation':
    "Activar el truncament de la sortida d'eines",
  'Tool Output Truncation Threshold':
    "Llindar de truncament de la sortida d'eines",
  'Tool Output Truncation Lines': "Línies de truncament de la sortida d'eines",
  'Folder Trust': 'Confiança de carpeta',
  'Vision Model Preview': 'Previsualització del model de visió',
  'Tool Schema Compliance': "Compliment de l'esquema d'eines",
  'Auto (detect from system)': 'Automàtic (detectar del sistema)',
  'Auto (detect terminal theme)': 'Automàtic (detectar el tema del terminal)',
  Auto: 'Automàtic',
  Text: 'Text',
  JSON: 'JSON',
  Plan: 'Planificació',
  Default: 'Per defecte',
  'Auto Edit': 'Edició automàtica',
  YOLO: 'YOLO',
  'toggle vim mode on/off': 'activar/desactivar el mode Vim',
  'check session stats. Usage: /stats [model|tools]':
    'comprovar les estadístiques de la sessió. Ús: /stats [model|tools]',
  'Show model-specific usage statistics.':
    "Mostrar les estadístiques d'ús específiques del model.",
  'Show tool-specific usage statistics.':
    "Mostrar les estadístiques d'ús específiques de les eines.",
  'exit the cli': 'sortir del CLI',
  'Open MCP management dialog, or authenticate with OAuth-enabled servers':
    'Obrir el diàleg de gestió MCP o autenticar-se amb servidors OAuth',
  'List configured MCP servers and tools, or authenticate with OAuth-enabled servers':
    'Llistar els servidors MCP configurats i les seves eines, o autenticar-se amb servidors OAuth',
  'Manage workspace directories':
    "Gestionar els directoris de l'espai de treball",
  'Add directories to the workspace. Use comma to separate multiple paths':
    "Afegir directoris a l'espai de treball. Useu comes per separar múltiples camins",
  'Show all directories in the workspace':
    "Mostrar tots els directoris de l'espai de treball",
  'set external editor preference': "establir la preferència d'editor extern",
  'Select Editor': 'Seleccionar editor',
  'Editor Preference': "Preferència d'editor",
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    'Aquests editors estan suportats. Cal tenir en compte que alguns editors no es poden usar en mode aïllat.',
  'Your preferred editor is:': 'El vostre editor preferit és:',
  'Manage extensions': 'Gestionar extensions',
  'Manage installed extensions': 'Gestionar les extensions instal·lades',
  'List active extensions': 'Llistar les extensions actives',
  'Update extensions. Usage: update <extension-names>|--all':
    "Actualitzar extensions. Ús: update <noms-d'extensions>|--all",
  'Disable an extension': 'Desactivar una extensió',
  'Enable an extension': 'Activar una extensió',
  'Install an extension from a git repo or local path':
    "Instal·lar una extensió des d'un repositori git o camí local",
  'Uninstall an extension': 'Desinstal·lar una extensió',
  'No extensions installed.': 'No hi ha extensions instal·lades.',
  'Usage: /extensions update <extension-names>|--all':
    "Ús: /extensions update <noms-d'extensions>|--all",
  'Extension "{{name}}" not found.': 'Extensió "{{name}}" no trobada.',
  'No extensions to update.': 'No hi ha extensions per actualitzar.',
  'Usage: /extensions install <source>': 'Ús: /extensions install <font>',
  'Installing extension from "{{source}}"...':
    'Instal·lant extensió des de "{{source}}"...',
  'Extension "{{name}}" installed successfully.':
    'L\'extensió "{{name}}" s\'ha instal·lat correctament.',
  'Failed to install extension from "{{source}}": {{error}}':
    'Error en instal·lar l\'extensió des de "{{source}}": {{error}}',
  'Usage: /extensions uninstall <extension-name>':
    "Ús: /extensions uninstall <nom-de-l'extensió>",
  'Uninstalling extension "{{name}}"...':
    'Desinstal·lant l\'extensió "{{name}}"...',
  'Extension "{{name}}" uninstalled successfully.':
    'L\'extensió "{{name}}" s\'ha desinstal·lat correctament.',
  'Failed to uninstall extension "{{name}}": {{error}}':
    'Error en desinstal·lar l\'extensió "{{name}}": {{error}}',
  'Usage: /extensions {{command}} <extension> [--scope=<user|workspace>]':
    'Ús: /extensions {{command}} <extensió> [--scope=<user|workspace>]',
  'Unsupported scope "{{scope}}", should be one of "user" or "workspace"':
    'Àmbit no suportat "{{scope}}", ha de ser "user" o "workspace"',
  'Extension "{{name}}" disabled for scope "{{scope}}"':
    'L\'extensió "{{name}}" desactivada per a l\'àmbit "{{scope}}"',
  'Extension "{{name}}" enabled for scope "{{scope}}"':
    'L\'extensió "{{name}}" activada per a l\'àmbit "{{scope}}"',
  'Do you want to continue? [Y/n]: ': 'Voleu continuar? [S/n]: ',
  'Do you want to continue?': 'Voleu continuar?',
  'Installing extension "{{name}}".': 'Instal·lant l\'extensió "{{name}}".',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    "**Les extensions poden introduir comportaments inesperats. Assegureu-vos d'haver investigat la font de l'extensió i de confiar en l'autor.**",
  'This extension will run the following MCP servers:':
    'Aquesta extensió executarà els servidors MCP següents:',
  local: 'local',
  remote: 'remot',
  'This extension will add the following commands: {{commands}}.':
    'Aquesta extensió afegirà les ordres següents: {{commands}}.',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'Aquesta extensió afegirà informació al vostre context QWEN.md usant {{fileName}}',
  'This extension will exclude the following core tools: {{tools}}':
    'Aquesta extensió exclourà les eines principals següents: {{tools}}',
  'This extension will install the following skills:':
    'Aquesta extensió instal·larà les habilitats següents:',
  'This extension will install the following subagents:':
    'Aquesta extensió instal·larà els subagents següents:',
  'Installation cancelled for "{{name}}".':
    'Instal·lació cancel·lada per a "{{name}}".',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    'Esteu instal·lant una extensió des de {{originSource}}. Algunes funcions poden no funcionar perfectament amb Qwen Code.',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    "--ref i --auto-update no s'apliquen a les extensions del mercat.",
  'Extension "{{name}}" installed successfully and enabled.':
    'L\'extensió "{{name}}" s\'ha instal·lat i activat correctament.',
  'Installs an extension from a git repository URL, local path, or claude marketplace (marketplace-url:plugin-name).':
    "Instal·la una extensió des d'una URL de repositori git, un camí local o el mercat (marketplace-url:nom-del-connector).",
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    "La URL de GitHub, el camí local o la font del mercat (marketplace-url:nom-del-connector) de l'extensió a instal·lar.",
  'The git ref to install from.':
    'La referència git des de la qual instal·lar.',
  'Enable auto-update for this extension.':
    "Activar l'actualització automàtica per a aquesta extensió.",
  'Enable pre-release versions for this extension.':
    'Activar les versions preliminars per a aquesta extensió.',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    "Acceptar els riscos de seguretat d'instal·lar una extensió i ometre el missatge de confirmació.",
  'The source argument must be provided.': "Cal proporcionar l'argument font.",
  'Extension "{{name}}" successfully uninstalled.':
    'L\'extensió "{{name}}" s\'ha desinstal·lat correctament.',
  'Uninstalls an extension.': 'Desinstal·la una extensió.',
  'The name or source path of the extension to uninstall.':
    "El nom o camí font de l'extensió a desinstal·lar.",
  'Please include the name of the extension to uninstall as a positional argument.':
    "Incloeu el nom de l'extensió a desinstal·lar com a argument posicional.",
  'Enables an extension.': 'Activa una extensió.',
  'The name of the extension to enable.': "El nom de l'extensió a activar.",
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    "L'àmbit en el qual activar l'extensió. Si no s'estableix, s'activarà en tots els àmbits.",
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    'L\'extensió "{{name}}" s\'ha activat correctament per a l\'àmbit "{{scope}}".',
  'Extension "{{name}}" successfully enabled in all scopes.':
    'L\'extensió "{{name}}" s\'ha activat correctament en tots els àmbits.',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    'Àmbit no vàlid: {{scope}}. Useu un dels següents: {{scopes}}.',
  'Disables an extension.': 'Desactiva una extensió.',
  'The name of the extension to disable.': "El nom de l'extensió a desactivar.",
  'The scope to disable the extenison in.':
    "L'àmbit en el qual desactivar l'extensió.",
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    'L\'extensió "{{name}}" s\'ha desactivat correctament per a l\'àmbit "{{scope}}".',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    'L\'extensió "{{name}}" s\'ha actualitzat correctament: {{oldVersion}} → {{newVersion}}.',
  'Unable to install extension "{{name}}" due to missing install metadata':
    'No es pot instal·lar l\'extensió "{{name}}" per manca de metadades d\'instal·lació',
  'Extension "{{name}}" is already up to date.':
    'L\'extensió "{{name}}" ja és al dia.',
  'Updates all extensions or a named extension to the latest version.':
    "Actualitza totes les extensions o una extensió específica a l'última versió.",
  'Update all extensions.': 'Actualitzar totes les extensions.',
  'The name of the extension to update.': "El nom de l'extensió a actualitzar.",
  'Either an extension name or --all must be provided':
    "Cal proporcionar un nom d'extensió o --all",
  'Lists installed extensions.': 'Llista les extensions instal·lades.',
  'Path:': 'Camí:',
  'Source:': 'Font:',
  'Type:': 'Tipus:',
  'Ref:': 'Ref:',
  'Release tag:': 'Etiqueta de versió:',
  'Enabled (User):': 'Activada (Usuari):',
  'Enabled (Workspace):': 'Activada (Espai de treball):',
  'Context files:': 'Fitxers de context:',
  'Skills:': 'Habilitats:',
  'Agents:': 'Agents:',
  'MCP servers:': 'Servidors MCP:',
  'Link extension failed to install.':
    "No s'ha pogut instal·lar l'extensió d'enllaç.",
  'Extension "{{name}}" linked successfully and enabled.':
    'L\'extensió "{{name}}" s\'ha enllaçat i activat correctament.',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    "Enllaça una extensió des d'un camí local. Els canvis al camí local sempre es reflectiran.",
  'The name of the extension to link.': "El nom de l'extensió a enllaçar.",
  'Set a specific setting for an extension.':
    'Establir una configuració específica per a una extensió.',
  'Name of the extension to configure.': "Nom de l'extensió a configurar.",
  'The setting to configure (name or env var).':
    "La configuració a establir (nom o variable d'entorn).",
  'The scope to set the setting in.': "L'àmbit on establir la configuració.",
  'List all settings for an extension.':
    "Llistar tota la configuració d'una extensió.",
  'Name of the extension.': "Nom de l'extensió.",
  'Extension "{{name}}" has no settings to configure.':
    'L\'extensió "{{name}}" no té cap configuració.',
  'Settings for "{{name}}":': 'Configuració per a "{{name}}":',
  '(workspace)': '(espai de treball)',
  '(user)': '(usuari)',
  '[not set]': '[no establert]',
  '[value stored in keychain]': '[valor emmagatzemat al clauer]',
  'Value:': 'Valor:',
  'Manage extension settings.': 'Gestionar la configuració de les extensions.',
  'You need to specify a command (set or list).':
    'Cal especificar una ordre (set o list).',

  // ============================================================================
  // Selecció de connector / Mercat
  // ============================================================================
  'No plugins available in this marketplace.':
    'No hi ha connectors disponibles en aquest mercat.',
  'Select a plugin to install from marketplace "{{name}}":':
    'Seleccioneu un connector per instal·lar des del mercat "{{name}}":',
  'Plugin selection cancelled.': 'Selecció de connector cancel·lada.',
  'Select a plugin from "{{name}}"': 'Seleccionar un connector de "{{name}}"',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    'Useu ↑↓ o j/k per navegar, Retorn per seleccionar, Esc per cancel·lar',
  '{{count}} more above': '{{count}} més amunt',
  '{{count}} more below': '{{count}} més avall',
  'manage IDE integration': "gestionar la integració de l'IDE",
  'check status of IDE integration':
    "comprovar l'estat de la integració de l'IDE",
  'install required IDE companion for {{ideName}}':
    'instal·lar el complement IDE necessari per a {{ideName}}',
  'enable IDE integration': "activar la integració de l'IDE",
  'disable IDE integration': "desactivar la integració de l'IDE",
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    "La integració de l'IDE no és compatible en el vostre entorn actual. Per usar aquesta funció, executeu Qwen Code en un dels IDEs compatibles: VS Code o bifurcacions de VS Code.",
  'Set up GitHub Actions': 'Configurar GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    'Configurar les dreceres del terminal per a entrada multilínia (VS Code, Cursor, Windsurf, Trae)',
  'Please restart your terminal for the changes to take effect.':
    'Reinicieu el terminal perquè els canvis tinguin efecte.',
  'Failed to configure terminal: {{error}}':
    'Error en configurar el terminal: {{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    "No s'ha pogut determinar el camí de configuració de {{terminalName}} a Windows: la variable d'entorn APPDATA no està establerta.",
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} keybindings.json existeix però no és un array JSON vàlid. Corregiu el fitxer manualment o elimineu-lo per permetre la configuració automàtica.',
  'File: {{file}}': 'Fitxer: {{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    'Error en analitzar {{terminalName}} keybindings.json. El fitxer conté JSON no vàlid. Corregiu el fitxer manualment o elimineu-lo per permetre la configuració automàtica.',
  'Error: {{error}}': 'Error: {{error}}',
  'Shift+Enter binding already exists': 'La drecera Shift+Retorn ja existeix',
  'Ctrl+Enter binding already exists': 'La drecera Ctrl+Retorn ja existeix',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    "S'han detectat dreceres existents. No es modificaran per evitar conflictes.",
  'Please check and modify manually if needed: {{file}}':
    'Comproveu i modifiqueu manualment si cal: {{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    "S'han afegit les dreceres Shift+Retorn i Ctrl+Retorn a {{terminalName}}.",
  'Modified: {{file}}': 'Modificat: {{file}}',
  '{{terminalName}} keybindings already configured.':
    'Les dreceres de {{terminalName}} ja estan configurades.',
  'Failed to configure {{terminalName}}.':
    'Error en configurar {{terminalName}}.',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    'El vostre terminal ja està configurat per a una experiència òptima amb entrada multilínia (Shift+Retorn i Ctrl+Retorn).',

  // ============================================================================
  // Ordres - Hooks
  // ============================================================================
  'Manage Qwen Code hooks': 'Gestionar els hooks de Qwen Code',
  'List all configured hooks': 'Llistar tots els hooks configurats',
  'Enable a disabled hook': 'Activar un hook desactivat',
  'Disable an active hook': 'Desactivar un hook actiu',
  Hooks: 'Hooks',
  'Loading hooks...': 'Carregant hooks...',
  'Error loading hooks:': 'Error en carregar els hooks:',
  'Press Escape to close': 'Premeu Esc per tancar',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    'Premeu Esc, Ctrl+C o Ctrl+D per cancel·lar',
  'Press Space, Enter, or Escape to dismiss':
    'Premeu Espai, Retorn o Esc per descartar',
  'No hook selected': 'Cap hook seleccionat',
  'No hook events found.': "No s'han trobat esdeveniments de hook.",
  '{{count}} hook configured': '{{count}} hook configurat',
  '{{count}} hooks configured': '{{count}} hooks configurats',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    'Aquest menú és de només lectura. Per afegir o modificar hooks, editeu settings.json directament o demaneu-ho a Qwen Code.',
  'Enter to select · Esc to cancel':
    'Retorn per seleccionar · Esc per cancel·lar',
  'Exit codes:': 'Codis de sortida:',
  'Configured hooks:': 'Hooks configurats:',
  'No hooks configured for this event.':
    'No hi ha hooks configurats per a aquest esdeveniment.',
  'To add hooks, edit settings.json directly or ask Qwen.':
    'Per afegir hooks, editeu settings.json directament o demaneu-ho a Qwen.',
  'Enter to select · Esc to go back':
    'Retorn per seleccionar · Esc per tornar enrere',
  'Hook details': 'Detalls del hook',
  'Event:': 'Esdeveniment:',
  'Extension:': 'Extensió:',
  'Desc:': 'Desc:',
  'No hook config selected': 'Cap configuració de hook seleccionada',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    'Per modificar o eliminar aquest hook, editeu settings.json directament o demaneu ajuda a Qwen.',
  'Hook Configuration - Disabled': 'Configuració de hooks - Desactivats',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    'Tots els hooks estan desactivats. En teniu {{count}} que no estan en execució.',
  '{{count}} configured hook': '{{count}} hook configurat',
  '{{count}} configured hooks': '{{count}} hooks configurats',
  'When hooks are disabled:': 'Quan els hooks estan desactivats:',
  'No hook commands will execute': "Cap ordre de hook s'executarà",
  'StatusLine will not be displayed': "La barra d'estat no es mostrarà",
  'Tool operations will proceed without hook validation':
    "Les operacions d'eines continuaran sense validació de hook",
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    'Per tornar a activar els hooks, elimineu "disableAllHooks" de settings.json o demaneu-ho a Qwen Code.',
  Project: 'Projecte',
  User: 'Usuari',
  System: 'Sistema',
  Extension: 'Extensió',
  'Local Settings': 'Configuració local',
  'User Settings': "Configuració d'usuari",
  'System Settings': 'Configuració del sistema',
  Extensions: 'Extensions',
  'Session (temporary)': 'Sessió (temporal)',
  '✓ Enabled': '✓ Activat',
  '✗ Disabled': '✗ Desactivat',
  'Before tool execution': "Abans de l'execució de l'eina",
  'After tool execution': "Després de l'execució de l'eina",
  'After tool execution fails': "Quan falla l'execució de l'eina",
  'When notifications are sent': "Quan s'envien notificacions",
  'When the user submits a prompt': "Quan l'usuari envia un missatge",
  'When a new session is started': "Quan s'inicia una nova sessió",
  'Right before Qwen Code concludes its response':
    'Immediatament abans que Qwen Code conclou la seva resposta',
  'When a subagent (Agent tool call) is started':
    "Quan s'inicia un subagent (crida a l'eina Agent)",
  'Right before a subagent concludes its response':
    'Immediatament abans que un subagent conclou la seva resposta',
  'Before conversation compaction': 'Abans de la compactació de la conversa',
  'When a session is ending': "Quan una sessió s'està acabant",
  'When a permission dialog is displayed':
    'Quan es mostra un diàleg de permisos',
  'Input to command is JSON of tool call arguments.':
    "L'entrada a l'ordre és JSON dels arguments de la crida a l'eina.",
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    'L\'entrada a l\'ordre és JSON amb els camps "inputs" (arguments de la crida a l\'eina) i "response" (resposta de la crida a l\'eina).',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    "L'entrada a l'ordre és JSON amb tool_name, tool_input, tool_use_id, error, error_type, is_interrupt i is_timeout.",
  'Input to command is JSON with notification message and type.':
    "L'entrada a l'ordre és JSON amb el missatge de notificació i el tipus.",
  'Input to command is JSON with original user prompt text.':
    "L'entrada a l'ordre és JSON amb el text original del missatge de l'usuari.",
  'Input to command is JSON with session start source.':
    "L'entrada a l'ordre és JSON amb la font d'inici de sessió.",
  'Input to command is JSON with session end reason.':
    "L'entrada a l'ordre és JSON amb el motiu de fi de sessió.",
  'Input to command is JSON with agent_id and agent_type.':
    "L'entrada a l'ordre és JSON amb agent_id i agent_type.",
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    "L'entrada a l'ordre és JSON amb agent_id, agent_type i agent_transcript_path.",
  'Input to command is JSON with compaction details.':
    "L'entrada a l'ordre és JSON amb els detalls de compactació.",
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    "L'entrada a l'ordre és JSON amb tool_name, tool_input i tool_use_id. La sortida JSON amb hookSpecificOutput conté la decisió de permetre o denegar.",
  'stdout/stderr not shown': 'stdout/stderr no es mostra',
  'show stderr to model and continue conversation':
    'mostrar stderr al model i continuar la conversa',
  'show stderr to user only': "mostrar stderr només a l'usuari",
  'stdout shown in transcript mode (ctrl+o)':
    'stdout mostrat en mode transcripció (ctrl+o)',
  'show stderr to model immediately': 'mostrar stderr al model immediatament',
  'show stderr to user only but continue with tool call':
    "mostrar stderr només a l'usuari però continuar amb la crida a l'eina",
  'block processing, erase original prompt, and show stderr to user only':
    "blocar el processament, esborrar el missatge original i mostrar stderr només a l'usuari",
  'stdout shown to Qwen': 'stdout mostrat a Qwen',
  'show stderr to user only (blocking errors ignored)':
    "mostrar stderr només a l'usuari (errors de bloqueig ignorats)",
  'command completes successfully': "l'ordre es completa correctament",
  'stdout shown to subagent': 'stdout mostrat al subagent',
  'show stderr to subagent and continue having it run':
    'mostrar stderr al subagent i continuar la seva execució',
  'stdout appended as custom compact instructions':
    'stdout afegit com a instruccions compactes personalitzades',
  'block compaction': 'blocar la compactació',
  'show stderr to user only but continue with compaction':
    "mostrar stderr només a l'usuari però continuar amb la compactació",
  'use hook decision if provided': 'usar la decisió del hook si es proporciona',
  'Config not loaded.': 'Configuració no carregada.',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'Els hooks no estan activats. Activeu els hooks a la configuració per usar aquesta funció.',
  'No hooks configured. Add hooks in your settings.json file.':
    'No hi ha hooks configurats. Afegiu hooks al vostre fitxer settings.json.',
  'Configured Hooks ({{count}} total)':
    'Hooks configurats ({{count}} en total)',

  // ============================================================================
  // Ordres - Exportació de sessió
  // ============================================================================
  'Export current session message history to a file':
    "Exportar l'historial de missatges de la sessió actual a un fitxer",
  'Export session to HTML format': 'Exportar la sessió en format HTML',
  'Export session to JSON format': 'Exportar la sessió en format JSON',
  'Export session to JSONL format (one message per line)':
    'Exportar la sessió en format JSONL (un missatge per línia)',
  'Export session to markdown format': 'Exportar la sessió en format markdown',

  // ============================================================================
  // Ordres - Idees
  // ============================================================================
  'generate personalized programming insights from your chat history':
    'generar idees de programació personalitzades a partir del vostre historial de xat',

  // ============================================================================
  // Ordres - Historial de sessió
  // ============================================================================
  'Resume a previous session': 'Reprendre una sessió anterior',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    "Restaurar una crida a una eina. Això restablirà la conversa i l'historial de fitxers a l'estat en què es trobaven quan es va suggerir la crida a l'eina",
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    "No s'ha pogut detectar el tipus de terminal. Terminals compatibles: VS Code, Cursor, Windsurf i Trae.",
  'Terminal "{{terminal}}" is not supported yet.':
    'El terminal "{{terminal}}" no és compatible encara.',

  // ============================================================================
  // Ordres - Idioma
  // ============================================================================
  'Invalid language. Available: {{options}}':
    'Idioma no vàlid. Disponibles: {{options}}',
  'Language subcommands do not accept additional arguments.':
    "Les subordres d'idioma no accepten arguments addicionals.",
  'Current UI language: {{lang}}': 'Idioma actual de la interfície: {{lang}}',
  'Current LLM output language: {{lang}}':
    'Idioma actual de la sortida del model: {{lang}}',
  'LLM output language not set': 'Idioma de sortida del model no establert',
  'Set UI language': "Establir l'idioma de la interfície",
  'Set LLM output language': "Establir l'idioma de sortida del model",
  'Usage: /language ui [{{options}}]': 'Ús: /language ui [{{options}}]',
  'Usage: /language output <language>': 'Ús: /language output <idioma>',
  'Example: /language output 中文': 'Exemple: /language output 中文',
  'Example: /language output English': 'Exemple: /language output English',
  'Example: /language output 日本語': 'Exemple: /language output 日本語',
  'Example: /language output Português': 'Exemple: /language output Português',
  'UI language changed to {{lang}}':
    'Idioma de la interfície canviat a {{lang}}',
  'LLM output language set to {{lang}}':
    'Idioma de sortida del model establert a {{lang}}',
  'LLM output language rule file generated at {{path}}':
    "Fitxer de regles d'idioma de sortida del model generat a {{path}}",
  'Please restart the application for the changes to take effect.':
    "Reinicieu l'aplicació perquè els canvis tinguin efecte.",
  'Failed to generate LLM output language rule file: {{error}}':
    "Error en generar el fitxer de regles d'idioma de sortida del model: {{error}}",
  'Invalid command. Available subcommands:':
    'Ordre no vàlida. Subordres disponibles:',
  'Available subcommands:': 'Subordres disponibles:',
  'To request additional UI language packs, please open an issue on GitHub.':
    "Per sol·licitar paquets d'idioma addicionals per a la interfície, obriu una incidència a GitHub.",
  'Available options:': 'Opcions disponibles:',
  'Set UI language to {{name}}':
    "Establir l'idioma de la interfície a {{name}}",

  // ============================================================================
  // Ordres - Mode d'aprovació
  // ============================================================================
  'Tool Approval Mode': "Mode d'aprovació d'eines",
  'Current approval mode: {{mode}}': "Mode d'aprovació actual: {{mode}}",
  'Available approval modes:': "Modes d'aprovació disponibles:",
  'Approval mode changed to: {{mode}}': "Mode d'aprovació canviat a: {{mode}}",
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    "Mode d'aprovació canviat a: {{mode}} (desat a la configuració {{scope}}{{location}})",
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    'Ús: /approval-mode <mode> [--session|--user|--project]',
  'Scope subcommands do not accept additional arguments.':
    "Les subordres d'àmbit no accepten arguments addicionals.",
  'Plan mode - Analyze only, do not modify files or execute commands':
    'Mode de planificació - Analitzar només, sense modificar fitxers ni executar ordres',
  'Default mode - Require approval for file edits or shell commands':
    'Mode per defecte - Requerir aprovació per a edicions de fitxers o ordres shell',
  'Auto-edit mode - Automatically approve file edits':
    "Mode d'edició automàtica - Aprovar automàticament les edicions de fitxers",
  'YOLO mode - Automatically approve all tools':
    'Mode YOLO - Aprovar automàticament totes les eines',
  '{{mode}} mode': 'Mode {{mode}}',
  'Settings service is not available; unable to persist the approval mode.':
    "El servei de configuració no està disponible; no es pot persistir el mode d'aprovació.",
  'Failed to save approval mode: {{error}}':
    "Error en desar el mode d'aprovació: {{error}}",
  'Failed to change approval mode: {{error}}':
    "Error en canviar el mode d'aprovació: {{error}}",
  'Apply to current session only (temporary)':
    'Aplicar només a la sessió actual (temporal)',
  'Persist for this project/workspace':
    'Persistir per a aquest projecte/espai de treball',
  'Persist for this user on this machine':
    'Persistir per a aquest usuari en aquesta màquina',
  'Analyze only, do not modify files or execute commands':
    'Analitzar només, sense modificar fitxers ni executar ordres',
  'Require approval for file edits or shell commands':
    'Requerir aprovació per a edicions de fitxers o ordres shell',
  'Automatically approve file edits':
    'Aprovar automàticament les edicions de fitxers',
  'Automatically approve all tools': 'Aprovar automàticament totes les eines',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    "Existeix un mode d'aprovació de l'espai de treball i té prioritat. El canvi a nivell d'usuari no tindrà cap efecte.",
  'Apply To': 'Aplicar a',
  'Workspace Settings': "Configuració de l'espai de treball",

  // ============================================================================
  // Ordres - Memòria
  // ============================================================================
  'Commands for interacting with memory.':
    'Ordres per interactuar amb la memòria.',
  'Show the current memory contents.':
    'Mostrar el contingut actual de la memòria.',
  'Show project-level memory contents.':
    'Mostrar el contingut de la memòria a nivell de projecte.',
  'Show global memory contents.': 'Mostrar el contingut de la memòria global.',
  'Add content to project-level memory.':
    'Afegir contingut a la memòria a nivell de projecte.',
  'Add content to global memory.': 'Afegir contingut a la memòria global.',
  'Refresh the memory from the source.':
    'Actualitzar la memòria des de la font.',
  'Usage: /memory add --project <text to remember>':
    'Ús: /memory add --project <text a recordar>',
  'Usage: /memory add --global <text to remember>':
    'Ús: /memory add --global <text a recordar>',
  'Attempting to save to project memory: "{{text}}"':
    'Intentant desar a la memòria del projecte: "{{text}}"',
  'Attempting to save to global memory: "{{text}}"':
    'Intentant desar a la memòria global: "{{text}}"',
  'Current memory content from {{count}} file(s):':
    'Contingut actual de la memòria de {{count}} fitxer(s):',
  'Memory is currently empty.': 'La memòria és buida actualment.',
  'Project memory file not found or is currently empty.':
    "El fitxer de memòria del projecte no s'ha trobat o és buit.",
  'Global memory file not found or is currently empty.':
    "El fitxer de memòria global no s'ha trobat o és buit.",
  'Global memory is currently empty.': 'La memòria global és buida actualment.',
  'Global memory content:\n\n---\n{{content}}\n---':
    'Contingut de la memòria global:\n\n---\n{{content}}\n---',
  'Project memory content from {{path}}:\n\n---\n{{content}}\n---':
    'Contingut de la memòria del projecte des de {{path}}:\n\n---\n{{content}}\n---',
  'Project memory is currently empty.': 'La memòria del projecte és buida.',
  'Refreshing memory from source files...':
    'Actualitzant la memòria des dels fitxers font...',
  'Add content to the memory. Use --global for global memory or --project for project memory.':
    'Afegir contingut a la memòria. Useu --global per a la memòria global o --project per a la memòria del projecte.',
  'Usage: /memory add [--global|--project] <text to remember>':
    'Ús: /memory add [--global|--project] <text a recordar>',
  'Attempting to save to memory {{scope}}: "{{fact}}"':
    'Intentant desar a la memòria {{scope}}: "{{fact}}"',
  'Open auto-memory folder': 'Obrir la carpeta de memòria automàtica',
  'Auto-memory: {{status}}': 'Memòria automàtica: {{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run':
    'Auto-dream: {{status}} · {{lastDream}} · /dream per executar',
  never: 'mai',
  on: 'activada',
  off: 'desactivada',
  '✦ dreaming': '✦ somniant',
  'Remove matching entries from managed auto-memory.':
    'Eliminar les entrades coincidents de la memòria automàtica gestionada.',
  'Usage: /forget <memory text to remove>':
    'Ús: /forget <text de memòria a eliminar>',
  'No managed auto-memory entries matched: {{query}}':
    'Cap entrada de memòria automàtica gestionada coincideix: {{query}}',
  'Show managed auto-memory status.':
    "Mostrar l'estat de la memòria automàtica gestionada.",
  'Run managed auto-memory extraction for the current session.':
    "Executar l'extracció de memòria automàtica gestionada per a la sessió actual.",
  'Managed auto-memory root: {{root}}':
    'Arrel de la memòria automàtica gestionada: {{root}}',
  'Managed auto-memory topics:': 'Temes de la memòria automàtica gestionada:',
  'No extraction cursor found yet.':
    "Encara no s'ha trobat cap cursor d'extracció.",
  'Cursor: session={{sessionId}}, offset={{offset}}, updated={{updatedAt}}':
    'Cursor: session={{sessionId}}, offset={{offset}}, updated={{updatedAt}}',
  'No chat client available to extract memory.':
    'No hi ha cap client de xat disponible per extreure memòria.',
  'Managed auto-memory extraction is already running.':
    "L'extracció de memòria automàtica gestionada ja s'està executant.",
  'Managed auto-memory extraction found no new durable memories.':
    "L'extracció de memòria automàtica gestionada no ha trobat noves memòries durables.",
  'Consolidate managed auto-memory topic files.':
    'Consolidar els fitxers de temes de memòria automàtica gestionada.',
  'Managed auto-memory dream found nothing to improve.':
    "L'auto-dream de memòria gestionada no ha trobat res a millorar.",
  'Deduplicated entries: {{count}}': 'Entrades desduplicades: {{count}}',
  'Save a durable memory using the save_memory tool.':
    "Desar una memòria durable usant l'eina save_memory.",
  'Usage: /remember [--global|--project] <text to remember>':
    'Ús: /remember [--global|--project] <text a recordar>',

  // ============================================================================
  // Ordres - MCP
  // ============================================================================
  'Authenticate with an OAuth-enabled MCP server':
    'Autenticar-se amb un servidor MCP amb OAuth',
  'List configured MCP servers and tools':
    'Llistar els servidors MCP configurats i les seves eines',
  'Restarts MCP servers.': 'Reinicia els servidors MCP.',
  'Open MCP management dialog': 'Obrir el diàleg de gestió MCP',
  'Could not retrieve tool registry.':
    "No s'ha pogut recuperar el registre d'eines.",
  'No MCP servers configured with OAuth authentication.':
    'No hi ha servidors MCP configurats amb autenticació OAuth.',
  'MCP servers with OAuth authentication:':
    'Servidors MCP amb autenticació OAuth:',
  'Use /mcp auth <server-name> to authenticate.':
    'Useu /mcp auth <nom-del-servidor> per autenticar-vos.',
  "MCP server '{{name}}' not found.":
    "El servidor MCP '{{name}}' no s'ha trobat.",
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "S'ha autenticat correctament i s'han actualitzat les eines per a '{{name}}'.",
  "Failed to authenticate with MCP server '{{name}}': {{error}}":
    "Error en autenticar-se amb el servidor MCP '{{name}}': {{error}}",
  "Re-discovering tools from '{{name}}'...":
    "Redescobrint les eines de '{{name}}'...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "S'han descobert {{count}} eina(es) de '{{name}}'.",
  'Authentication complete. Returning to server details...':
    'Autenticació completada. Tornant als detalls del servidor...',
  'Authentication successful.': 'Autenticació correcta.',
  'If the browser does not open, copy and paste this URL into your browser:':
    "Si el navegador no s'obre, copieu i enganxeu aquesta URL al vostre navegador:",
  'Make sure to copy the COMPLETE URL - it may wrap across multiple lines.':
    'Assegureu-vos de copiar la URL COMPLETA - pot ocupar múltiples línies.',

  // ============================================================================
  // Diàleg de gestió MCP
  // ============================================================================
  'Manage MCP servers': 'Gestionar els servidors MCP',
  'Server Detail': 'Detalls del servidor',
  'Disable Server': 'Desactivar el servidor',
  Tools: 'Eines',
  'Tool Detail': "Detalls de l'eina",
  'MCP Management': 'Gestió MCP',
  'Loading...': 'Carregant...',
  'Unknown step': 'Pas desconegut',
  'Esc to back': 'Esc per tornar',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ per navegar · Retorn per seleccionar · Esc per tancar',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ per navegar · Retorn per seleccionar · Esc per tornar',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ per navegar · Retorn per confirmar · Esc per tornar',
  'User Settings (global)': "Configuració d'usuari (global)",
  'Workspace Settings (project-specific)':
    "Configuració de l'espai de treball (específica del projecte)",
  'Disable server:': 'Desactivar el servidor:',
  'Select where to add the server to the exclude list:':
    "Seleccioneu on afegir el servidor a la llista d'exclusió:",
  'Press Enter to confirm, Esc to cancel':
    'Premeu Retorn per confirmar, Esc per cancel·lar',
  'View tools': 'Veure eines',
  Reconnect: 'Reconnectar',
  Enable: 'Activar',
  Disable: 'Desactivar',
  Authenticate: 'Autenticar',
  'Re-authenticate': 'Tornar a autenticar',
  'Clear Authentication': "Esborrar l'autenticació",
  'Server:': 'Servidor:',
  'Command:': 'Ordre:',
  'Working Directory:': 'Directori de treball:',
  'Capabilities:': 'Capacitats:',
  'No server selected': 'Cap servidor seleccionat',
  prompts: 'missatges',
  '(disabled)': '(desactivat)',
  'Error:': 'Error:',
  tool: 'eina',
  tools: 'eines',
  connected: 'connectat',
  connecting: 'connectant',
  disconnected: 'desconnectat',
  'User MCPs': "MCPs de l'usuari",
  'Project MCPs': 'MCPs del projecte',
  'Extension MCPs': 'MCPs de les extensions',
  server: 'servidor',
  servers: 'servidors',
  'Add MCP servers to your settings to get started.':
    'Afegiu servidors MCP a la configuració per començar.',
  'Run qwen --debug to see error logs':
    "Executeu qwen --debug per veure els registres d'errors",
  'OAuth Authentication': 'Autenticació OAuth',
  'Press Enter to start authentication, Esc to go back':
    "Premeu Retorn per iniciar l'autenticació, Esc per tornar enrere",
  'Authenticating... Please complete the login in your browser.':
    "Autenticant... Completeu l'inici de sessió al vostre navegador.",
  'Press c to copy the authorization URL to your clipboard.':
    "Premeu c per copiar la URL d'autorització al porta-retalls.",
  'Copy request sent to your terminal. If paste is empty, copy the URL above manually.':
    'Sol·licitud de còpia enviada al vostre terminal. Si el que enganxeu és buit, copieu la URL anterior manualment.',
  'Cannot write to terminal — copy the URL above manually.':
    'No es pot escriure al terminal — copieu la URL anterior manualment.',
  'Press Enter or Esc to go back': 'Premeu Retorn o Esc per tornar enrere',
  'No tools available for this server.':
    'No hi ha eines disponibles per a aquest servidor.',
  destructive: 'destructiu',
  'read-only': 'només lectura',
  'open-world': 'món obert',
  idempotent: 'idempotent',
  'Tools for {{name}}': 'Eines per a {{name}}',
  'Tools for {{serverName}}': 'Eines per a {{serverName}}',
  '{{current}}/{{total}}': '{{current}}/{{total}}',
  required: 'obligatori',
  Type: 'Tipus',
  Enum: 'Enumeració',
  Parameters: 'Paràmetres',
  'No tool selected': 'Cap eina seleccionada',
  Annotations: 'Anotacions',
  Title: 'Títol',
  'Read Only': 'Només lectura',
  Destructive: 'Destructiu',
  Idempotent: 'Idempotent',
  'Open World': 'Món obert',
  Server: 'Servidor',
  '{{count}} invalid tools': '{{count}} eines no vàlides',
  invalid: 'no vàlid',
  'invalid: {{reason}}': 'no vàlid: {{reason}}',
  'missing name': 'nom absent',
  'missing description': 'descripció absent',
  '(unnamed)': '(sense nom)',
  'Warning: This tool cannot be called by the LLM':
    'Advertència: el model no pot cridar aquesta eina',
  Reason: 'Motiu',
  'Tools must have both name and description to be used by the LLM.':
    'Les eines han de tenir nom i descripció per poder ser usades pel model.',

  // ============================================================================
  // Ordres - Xat
  // ============================================================================
  'Manage conversation history.': "Gestionar l'historial de la conversa.",
  'List saved conversation checkpoints':
    'Llistar els punts de control desats de la conversa',
  'No saved conversation checkpoints found.':
    "No s'han trobat punts de control de conversa desats.",
  'List of saved conversations:': 'Llista de converses desades:',
  'Note: Newest last, oldest first':
    'Nota: Les més recents al final, les més antigues al principi',
  'Save the current conversation as a checkpoint. Usage: /chat save <tag>':
    'Desar la conversa actual com a punt de control. Ús: /chat save <etiqueta>',
  'Missing tag. Usage: /chat save <tag>':
    'Etiqueta absent. Ús: /chat save <etiqueta>',
  'Delete a conversation checkpoint. Usage: /chat delete <tag>':
    'Eliminar un punt de control de conversa. Ús: /chat delete <etiqueta>',
  'Missing tag. Usage: /chat delete <tag>':
    'Etiqueta absent. Ús: /chat delete <etiqueta>',
  "Conversation checkpoint '{{tag}}' has been deleted.":
    "El punt de control de conversa '{{tag}}' s'ha eliminat.",
  "Error: No checkpoint found with tag '{{tag}}'.":
    "Error: No s'ha trobat cap punt de control amb l'etiqueta '{{tag}}'.",
  'Resume a conversation from a checkpoint. Usage: /chat resume <tag>':
    "Reprendre una conversa des d'un punt de control. Ús: /chat resume <etiqueta>",
  'Missing tag. Usage: /chat resume <tag>':
    'Etiqueta absent. Ús: /chat resume <etiqueta>',
  'No saved checkpoint found with tag: {{tag}}.':
    "No s'ha trobat cap punt de control desat amb l'etiqueta: {{tag}}.",
  'A checkpoint with the tag {{tag}} already exists. Do you want to overwrite it?':
    "Ja existeix un punt de control amb l'etiqueta {{tag}}. Voleu sobreescriure'l?",
  'No chat client available to save conversation.':
    'No hi ha cap client de xat disponible per desar la conversa.',
  'Conversation checkpoint saved with tag: {{tag}}.':
    "Punt de control de conversa desat amb l'etiqueta: {{tag}}.",
  'No conversation found to save.': "No s'ha trobat cap conversa per desar.",
  'No chat client available to share conversation.':
    'No hi ha cap client de xat disponible per compartir la conversa.',
  'Invalid file format. Only .md and .json are supported.':
    'Format de fitxer no vàlid. Només es suporten .md i .json.',
  'Error sharing conversation: {{error}}':
    'Error en compartir la conversa: {{error}}',
  'Conversation shared to {{filePath}}': 'Conversa compartida a {{filePath}}',
  'No conversation found to share.':
    "No s'ha trobat cap conversa per compartir.",
  'Share the current conversation to a markdown or json file. Usage: /chat share <file>':
    'Compartir la conversa actual a un fitxer markdown o json. Ús: /chat share <fitxer>',

  // ============================================================================
  // Ordres - Resum
  // ============================================================================
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    'Generar un resum del projecte i desar-lo a .qwen/PROJECT_SUMMARY.md',
  'No chat client available to generate summary.':
    'No hi ha cap client de xat disponible per generar el resum.',
  'Already generating summary, wait for previous request to complete':
    "Ja s'està generant el resum, espereu que acabi la sol·licitud anterior",
  'No conversation found to summarize.':
    "No s'ha trobat cap conversa per resumir.",
  'Failed to generate project context summary: {{error}}':
    'Error en generar el resum del context del projecte: {{error}}',
  'Saved project summary to {{filePathForDisplay}}.':
    'Resum del projecte desat a {{filePathForDisplay}}.',
  'Saving project summary...': 'Desant el resum del projecte...',
  'Generating project summary...': 'Generant el resum del projecte...',
  'Failed to generate summary - no text content received from LLM response':
    "Error en generar el resum - no s'ha rebut contingut de text de la resposta del model",

  // ============================================================================
  // Ordres - Model
  // ============================================================================
  'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).':
    'Canviar el model per a aquesta sessió (--fast per al model de suggeriments)',
  'Set a lighter model for prompt suggestions and speculative execution':
    'Establir un model més lleuger per a suggeriments de missatges i execució especulativa',
  'Content generator configuration not available.':
    'Configuració del generador de contingut no disponible.',
  'Authentication type not available.': "Tipus d'autenticació no disponible.",
  'No models available for the current authentication type ({{authType}}).':
    "No hi ha models disponibles per al tipus d'autenticació actual ({{authType}}).",
  // Needs translation
  ' (not in model registry)': ' (not in model registry)',

  // ============================================================================
  // Ordres - Netejar
  // ============================================================================
  'Starting a new session, resetting chat, and clearing terminal.':
    'Iniciant una nova sessió, restablint el xat i netejant el terminal.',
  'Starting a new session and clearing.':
    'Iniciant una nova sessió i netejant.',

  // ============================================================================
  // Ordres - Comprimir
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    "Ja s'està comprimint, espereu que acabi la sol·licitud anterior",
  'Failed to compress chat history.': "Error en comprimir l'historial del xat.",
  'Failed to compress chat history: {{error}}':
    "Error en comprimir l'historial del xat: {{error}}",
  'Compressing chat history': "Comprimint l'historial del xat",
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    "L'historial del xat s'ha comprimit de {{originalTokens}} a {{newTokens}} tokens.",
  'Compression was not beneficial for this history size.':
    "La compressió no ha estat beneficiosa per a aquesta mida d'historial.",
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    "La compressió de l'historial del xat no ha reduït la mida. Això pot indicar problemes amb el missatge de compressió.",
  'Could not compress chat history due to a token counting error.':
    "No s'ha pogut comprimir l'historial del xat per un error de recompte de tokens.",
  'Chat history is already compressed.':
    "L'historial del xat ja està comprimit.",

  // ============================================================================
  // Ordres - Directori
  // ============================================================================
  'Configuration is not available.': 'Configuració no disponible.',
  'Please provide at least one path to add.':
    'Proporcioneu almenys un camí per afegir.',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    "L'ordre /directory add no és compatible en perfils d'entorn aïllat restrictius. En el seu lloc, useu --include-directories en iniciar la sessió.",
  "Error adding '{{path}}': {{error}}": "Error en afegir '{{path}}': {{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    "S'han afegit correctament els fitxers QWEN.md dels directoris següents si n'hi ha:\n- {{directories}}",
  'Error refreshing memory: {{error}}':
    'Error en actualitzar la memòria: {{error}}',
  'Successfully added directories:\n- {{directories}}':
    "S'han afegit correctament els directoris:\n- {{directories}}",
  'Current workspace directories:\n{{directories}}':
    "Directoris actuals de l'espai de treball:\n{{directories}}",

  // ============================================================================
  // Ordres - Documentació
  // ============================================================================
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    'Obriu la URL següent al vostre navegador per veure la documentació:\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    'Obrint la documentació al vostre navegador: {{url}}',

  // ============================================================================
  // Diàlegs - Confirmació d'eines
  // ============================================================================
  'Do you want to proceed?': 'Voleu continuar?',
  'Yes, allow once': 'Sí, permetre una vegada',
  'Allow always': 'Permetre sempre',
  Yes: 'Sí',
  No: 'No',
  'No (esc)': 'No (esc)',
  'Yes, allow always for this session':
    'Sí, permetre sempre per a aquesta sessió',
  'Modify in progress:': 'Modificació en curs:',
  'Save and close external editor to continue':
    "Deseu i tanqueu l'editor extern per continuar",
  'Apply this change?': 'Aplicar aquest canvi?',
  'Yes, allow always': 'Sí, permetre sempre',
  'Modify with external editor': 'Modificar amb editor extern',
  'No, suggest changes (esc)': 'No, suggerir canvis (esc)',
  "Allow execution of: '{{command}}'?":
    "Permetre l'execució de: '{{command}}'?",
  'Yes, allow always ...': 'Sí, permetre sempre...',
  'Always allow in this project': 'Permetre sempre en aquest projecte',
  'Always allow {{action}} in this project':
    'Permetre sempre {{action}} en aquest projecte',
  'Always allow for this user': 'Permetre sempre per a aquest usuari',
  'Always allow {{action}} for this user':
    'Permetre sempre {{action}} per a aquest usuari',
  'Yes, restore previous mode ({{mode}})':
    'Sí, restaurar el mode anterior ({{mode}})',
  'Yes, and auto-accept edits': 'Sí, i acceptar els canvis automàticament',
  'Yes, and manually approve edits': 'Sí, i aprovar els canvis manualment',
  'No, keep planning (esc)': 'No, seguir planificant (esc)',
  'URLs to fetch:': 'URLs a recuperar:',
  'MCP Server: {{server}}': 'Servidor MCP: {{server}}',
  'Tool: {{tool}}': 'Eina: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'Permetre l\'execució de l\'eina MCP "{{tool}}" del servidor "{{server}}"?',
  'Yes, always allow tool "{{tool}}" from server "{{server}}"':
    'Sí, permetre sempre l\'eina "{{tool}}" del servidor "{{server}}"',
  'Yes, always allow all tools from server "{{server}}"':
    'Sí, permetre sempre totes les eines del servidor "{{server}}"',

  // ============================================================================
  // Diàlegs - Confirmació de shell
  // ============================================================================
  'Shell Command Execution': "Execució d'ordres shell",
  'A custom command wants to run the following shell commands:':
    'Una ordre personalitzada vol executar les ordres shell següents:',

  // ============================================================================
  // Diàlegs - Quota Pro
  // ============================================================================
  'Pro quota limit reached for {{model}}.':
    "S'ha assolit el límit de quota Pro per a {{model}}.",
  'Change auth (executes the /auth command)':
    "Canviar autenticació (executa l'ordre /auth)",
  'Continue with {{model}}': 'Continuar amb {{model}}',

  // ============================================================================
  // Diàlegs - Benvinguda
  // ============================================================================
  'Current Plan:': 'Pla actual:',
  'Progress: {{done}}/{{total}} tasks completed':
    'Progrés: {{done}}/{{total}} tasques completades',
  ', {{inProgress}} in progress': ', {{inProgress}} en curs',
  'Pending Tasks:': 'Tasques pendents:',
  'What would you like to do?': 'Què voleu fer?',
  'Choose how to proceed with your session:':
    'Trieu com voleu continuar la vostra sessió:',
  'Start new chat session': 'Iniciar una nova sessió de xat',
  'Continue previous conversation': 'Continuar la conversa anterior',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 Benvingut de nou! (Darrera actualització: {{timeAgo}})',
  '🎯 Overall Goal:': '🎯 Objectiu general:',

  // ============================================================================
  // Diàlegs - Autenticació
  // ============================================================================
  'Get started': 'Comencem',
  'Select Authentication Method': "Seleccioneu el mètode d'autenticació",
  'OpenAI API key is required to use OpenAI authentication.':
    "Cal una clau API d'OpenAI per usar l'autenticació d'OpenAI.",
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    "Cal seleccionar un mètode d'autenticació per continuar. Premeu Ctrl+C de nou per sortir.",
  'Terms of Services and Privacy Notice':
    'Termes de servei i avís de privacitat',
  'Qwen OAuth': 'Qwen OAuth',
  'Discontinued — switch to Coding Plan or API Key':
    'Descontinuat — canvieu a Coding Plan o clau API',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch provider.':
    'El nivell gratuït de Qwen OAuth es va descontinuar el 15-04-2026. Executeu /auth per canviar de proveïdor.',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.':
    'El nivell gratuït de Qwen OAuth es va descontinuar el 15-04-2026. Seleccioneu Coding Plan o clau API en el seu lloc.',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.':
    "El nivell gratuït de Qwen OAuth es va descontinuar el 15-04-2026. Seleccioneu un model d'un altre proveïdor o executeu /auth per canviar.",
  '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n':
    '\n⚠ El nivell gratuït de Qwen OAuth es va descontinuar el 15-04-2026. Seleccioneu una altra opció.\n',
  'Paid · Up to 6,000 requests/5 hrs · All Alibaba Cloud Coding Plan Models':
    "De pagament · Fins a 6.000 sol·licituds/5 h · Tots els models del Coding Plan d'Alibaba Cloud",
  'Alibaba Cloud Coding Plan': "Coding Plan d'Alibaba Cloud",
  'Bring your own API key': 'Porteu la vostra pròpia clau API',
  'API-KEY': 'API-KEY',
  'Use coding plan credentials or your own api-keys/providers.':
    'Useu les credencials del coding plan o les vostres pròpies claus API/proveïdors.',
  OpenAI: 'OpenAI',
  'Failed to login. Message: {{message}}':
    'Error en iniciar sessió. Missatge: {{message}}',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    "L'autenticació ha de ser {{enforcedType}}, però actualment esteu usant {{currentType}}.",
  'Qwen OAuth authentication timed out. Please try again.':
    "L'autenticació Qwen OAuth ha expirat. Torneu-ho a intentar.",
  'Qwen OAuth authentication cancelled.':
    "L'autenticació Qwen OAuth s'ha cancel·lat.",
  'Qwen OAuth Authentication': 'Autenticació Qwen OAuth',
  'Please visit this URL to authorize:': 'Visiteu aquesta URL per autoritzar:',
  'Or scan the QR code below:': 'O escanegeu el codi QR de sota:',
  'Waiting for authorization': "Esperant l'autorització",
  'Time remaining:': 'Temps restant:',
  '(Press ESC or CTRL+C to cancel)': '(Premeu ESC o CTRL+C per cancel·lar)',
  'Qwen OAuth Authentication Timeout':
    "Temps d'espera de l'autenticació Qwen OAuth esgotat",
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    "El token OAuth ha expirat (més de {{seconds}} segons). Seleccioneu el mètode d'autenticació de nou.",
  'Press any key to return to authentication type selection.':
    "Premeu qualsevol tecla per tornar a la selecció del tipus d'autenticació.",
  'Waiting for Qwen OAuth authentication...':
    "Esperant l'autenticació Qwen OAuth...",
  'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.':
    "Nota: La vostra clau API existent a settings.json no s'esborrarà en usar Qwen OAuth. Podeu tornar a l'autenticació d'OpenAI més endavant si cal.",
  'Note: Your existing API key will not be cleared when using Qwen OAuth.':
    "Nota: La vostra clau API existent no s'esborrarà en usar Qwen OAuth.",
  'Authentication timed out. Please try again.':
    "L'autenticació ha expirat. Torneu-ho a intentar.",
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    "Esperant l'autenticació... (Premeu ESC o CTRL+C per cancel·lar)",
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    "Manca la clau API per a l'autenticació compatible amb OpenAI. Establiu settings.security.auth.apiKey o la variable d'entorn {{envKeyHint}}.",
  '{{envKeyHint}} environment variable not found.':
    "La variable d'entorn {{envKeyHint}} no s'ha trobat.",
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    "La variable d'entorn {{envKeyHint}} no s'ha trobat. Establiu-la al fitxer .env o a les variables d'entorn.",
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    "La variable d'entorn {{envKeyHint}} no s'ha trobat (o establiu settings.security.auth.apiKey). Establiu-la al fitxer .env o a les variables d'entorn.",
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    "Manca la clau API per a l'autenticació compatible amb OpenAI. Establiu la variable d'entorn {{envKeyHint}}.",
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'El proveïdor Anthropic no té la baseUrl obligatòria a modelProviders[].baseUrl.',
  'ANTHROPIC_BASE_URL environment variable not found.':
    "La variable d'entorn ANTHROPIC_BASE_URL no s'ha trobat.",
  'Invalid auth method selected.':
    "S'ha seleccionat un mètode d'autenticació no vàlid.",
  'Failed to authenticate. Message: {{message}}':
    'Error en autenticar-se. Missatge: {{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    "S'ha autenticat correctament amb les credencials {{authType}}.",
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    'Valor de QWEN_DEFAULT_AUTH_TYPE no vàlid: "{{value}}". Els valors vàlids són: {{validValues}}',
  'OpenAI Configuration Required': "Configuració d'OpenAI necessària",
  'Please enter your OpenAI configuration. You can get an API key from':
    "Introduïu la vostra configuració d'OpenAI. Podeu obtenir una clau API de",
  'API Key:': 'Clau API:',
  'Invalid credentials: {{errorMessage}}':
    'Credencials no vàlides: {{errorMessage}}',
  'Failed to validate credentials': 'Error en validar les credencials',
  'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel':
    'Premeu Retorn per continuar, Tab/↑↓ per navegar, Esc per cancel·lar',

  // ============================================================================
  // Diàlegs - Model
  // ============================================================================
  'Select Model': 'Seleccioneu el model',
  '(Press Esc to close)': '(Premeu Esc per tancar)',
  'Current (effective) configuration': 'Configuració actual (efectiva)',
  AuthType: "Tipus d'autenticació",
  'API Key': 'Clau API',
  unset: 'no establert',
  '(default)': '(per defecte)',
  '(set)': '(establert)',
  '(not set)': '(no establert)',
  Modality: 'Modalitat',
  'Context Window': 'Fin. de context',
  text: 'text',
  'text-only': 'només text',
  image: 'imatge',
  pdf: 'pdf',
  audio: 'àudio',
  video: 'vídeo',
  'not set': 'no establert',
  none: 'cap',
  unknown: 'desconegut',
  "Failed to switch model to '{{modelId}}'.\n\n{{error}}":
    "Error en canviar al model '{{modelId}}'.\n\n{{error}}",
  'Qwen 3.6 Plus — efficient hybrid model with leading coding performance':
    'Qwen 3.6 Plus — model híbrid eficient amb un rendiment de codificació líder',
  'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)':
    "L'últim model de visió Qwen d'Alibaba Cloud ModelStudio (versió: qwen3-vl-plus-2025-09-23)",

  // ============================================================================
  // Diàlegs - Permisos
  // ============================================================================
  'Manage folder trust settings':
    'Gestionar la configuració de confiança de carpetes',
  'Manage permission rules': 'Gestionar les regles de permisos',
  Allow: 'Permetre',
  Ask: 'Preguntar',
  Deny: 'Denegar',
  Workspace: 'Espai de treball',
  "Qwen Code won't ask before using allowed tools.":
    "Qwen Code no preguntarà abans d'usar les eines permeses.",
  'Qwen Code will ask before using these tools.':
    "Qwen Code preguntarà abans d'usar aquestes eines.",
  'Qwen Code is not allowed to use denied tools.':
    'Qwen Code no té permís per usar les eines denegades.',
  'Manage trusted directories for this workspace.':
    "Gestionar els directoris de confiança d'aquest espai de treball.",
  'Any use of the {{tool}} tool': "Qualsevol ús de l'eina {{tool}}",
  "{{tool}} commands matching '{{pattern}}'":
    "Ordres de {{tool}} que coincideixen amb '{{pattern}}'",
  'From user settings': "Des de la configuració d'usuari",
  'From project settings': 'Des de la configuració del projecte',
  'From session': 'Des de la sessió',
  'Project settings (local)': 'Configuració del projecte (local)',
  'Saved in .qwen/settings.local.json': 'Desat a .qwen/settings.local.json',
  'Project settings': 'Configuració del projecte',
  'Checked in at .qwen/settings.json': 'Registrat a .qwen/settings.json',
  'User settings': "Configuració d'usuari",
  'Saved in at ~/.qwen/settings.json': 'Desat a ~/.qwen/settings.json',
  'Add a new rule…': 'Afegir una nova regla…',
  'Add {{type}} permission rule': 'Afegir una regla de permís {{type}}',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    "Les regles de permisos són un nom d'eina, seguit opcionalment d'un especificador entre parèntesis.",
  'e.g.,': 'p. ex.,',
  or: 'o',
  'Enter permission rule…': 'Introduïu la regla de permís…',
  'Enter to submit · Esc to cancel': 'Retorn per enviar · Esc per cancel·lar',
  'Where should this rule be saved?': "On s'ha de desar aquesta regla?",
  'Enter to confirm · Esc to cancel':
    'Retorn per confirmar · Esc per cancel·lar',
  'Delete {{type}} rule?': 'Eliminar la regla {{type}}?',
  'Are you sure you want to delete this permission rule?':
    'Esteu segur que voleu eliminar aquesta regla de permisos?',
  'Permissions:': 'Permisos:',
  '(←/→ or tab to cycle)': '(←/→ o tab per canviar)',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    'Premeu ↑↓ per navegar · Retorn per seleccionar · Escriviu per cercar · Esc per cancel·lar',
  'Search…': 'Cercar…',
  'Use /trust to manage folder trust settings for this workspace.':
    "Useu /trust per gestionar la configuració de confiança de carpetes d'aquest espai de treball.",
  'Add directory…': 'Afegir directori…',
  'Add directory to workspace': "Afegir directori a l'espai de treball",
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    "Qwen Code pot llegir fitxers a l'espai de treball i fer canvis quan l'acceptació automàtica de canvis està activada.",
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    "Qwen Code podrà llegir fitxers en aquest directori i fer canvis quan l'acceptació automàtica de canvis està activada.",
  'Enter the path to the directory:': 'Introduïu el camí del directori:',
  'Enter directory path…': 'Introduïu el camí del directori…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab per completar · Retorn per afegir · Esc per cancel·lar',
  'Remove directory?': 'Eliminar el directori?',
  'Are you sure you want to remove this directory from the workspace?':
    "Esteu segur que voleu eliminar aquest directori de l'espai de treball?",
  '  (Original working directory)': '  (Directori de treball original)',
  '  (from settings)': '  (des de la configuració)',
  'Directory does not exist.': 'El directori no existeix.',
  'Path is not a directory.': 'El camí no és un directori.',
  'This directory is already in the workspace.':
    "Aquest directori ja és a l'espai de treball.",
  'Already covered by existing directory: {{dir}}':
    'Ja cobert per un directori existent: {{dir}}',

  // ============================================================================
  // Barra d'estat
  // ============================================================================
  'Using:': 'En ús:',
  '{{count}} open file': '{{count}} fitxer obert',
  '{{count}} open files': '{{count}} fitxers oberts',
  '(ctrl+g to view)': '(ctrl+g per veure)',
  '{{count}} {{name}} file': '{{count}} fitxer {{name}}',
  '{{count}} {{name}} files': '{{count}} fitxers {{name}}',
  '{{count}} MCP server': '{{count}} servidor MCP',
  '{{count}} MCP servers': '{{count}} servidors MCP',
  '{{count}} Blocked': '{{count}} bloquejats',
  '(ctrl+t to view)': '(ctrl+t per veure)',
  '(ctrl+t to toggle)': '(ctrl+t per canviar)',
  'Press Ctrl+C again to exit.': 'Premeu Ctrl+C de nou per sortir.',
  'Press Ctrl+D again to exit.': 'Premeu Ctrl+D de nou per sortir.',
  'Press Esc again to clear.': 'Premeu Esc de nou per esborrar.',
  'Press ↑ to edit queued messages': 'Premeu ↑ per editar els missatges en cua',

  // ============================================================================
  // Estat MCP
  // ============================================================================
  'No MCP servers configured.': 'No hi ha servidors MCP configurats.',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    "⏳ Els servidors MCP s'estan iniciant ({{count}} inicialitzant)...",
  'Note: First startup may take longer. Tool availability will update automatically.':
    "Nota: El primer inici pot tardar més. La disponibilitat de les eines s'actualitzarà automàticament.",
  'Configured MCP servers:': 'Servidors MCP configurats:',
  Ready: 'Preparat',
  'Starting... (first startup may take longer)':
    'Iniciant... (el primer inici pot tardar més)',
  Disconnected: 'Desconnectat',
  '{{count}} tool': '{{count}} eina',
  '{{count}} tools': '{{count}} eines',
  '{{count}} prompt': '{{count}} missatge',
  '{{count}} prompts': '{{count}} missatges',
  '(from {{extensionName}})': '(de {{extensionName}})',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth expirat',
  'OAuth not authenticated': 'OAuth no autenticat',
  'tools and prompts will appear when ready':
    'les eines i els missatges apareixeran quan estiguin a punt',
  '{{count}} tools cached': '{{count}} eines en memòria cau',
  'Tools:': 'Eines:',
  'Parameters:': 'Paràmetres:',
  'Prompts:': 'Missatges:',
  Blocked: 'Bloquejat',
  '💡 Tips:': '💡 Consells:',
  Use: 'Useu',
  'to show server and tool descriptions':
    'per mostrar les descripcions del servidor i de les eines',
  'to show tool parameter schemas':
    'per mostrar els esquemes de paràmetres de les eines',
  'to hide descriptions': 'per amagar les descripcions',
  'to authenticate with OAuth-enabled servers':
    'per autenticar-vos amb servidors OAuth',
  Press: 'Premeu',
  'to toggle tool descriptions on/off':
    'per activar/desactivar les descripcions de les eines',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "Iniciant l'autenticació OAuth per al servidor MCP '{{name}}'...",
  'Restarting MCP servers...': 'Reiniciant els servidors MCP...',

  // ============================================================================
  // Consells d'inici
  // ============================================================================
  'Tips:': 'Consells:',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    "Useu /compress quan la conversa sigui llarga per resumir l'historial i alliberar context.",
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    "Comenceu una idea nova amb /clear o /new; la sessió anterior segueix disponible a l'historial.",
  'Use /bug to submit issues to the maintainers when something goes off.':
    'Useu /bug per enviar incidències als mantenidors quan alguna cosa vagi malament.',
  'Switch auth type quickly with /auth.':
    "Canvieu ràpidament el tipus d'autenticació amb /auth.",
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    'Podeu executar qualsevol ordre shell des de Qwen Code usant ! (p. ex. !ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    "Escriviu / per obrir el menú emergent d'ordres; Tab completa automàticament les ordres de barra i els missatges desats.",
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    'Podeu reprendre una conversa anterior executant qwen --continue o qwen --resume.',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'Podeu canviar ràpidament el mode de permisos amb Maj+Tab o /approval-mode.',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    'Podeu canviar ràpidament el mode de permisos amb Tab o /approval-mode.',
  'Try /insight to generate personalized insights from your chat history.':
    'Proveu /insight per generar idees personalitzades a partir del vostre historial de xat.',
  'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.':
    'Premeu Ctrl+O per canviar el mode compacte — amagueu la sortida de les eines i el pensament per a una vista més neta.',
  'Add a QWEN.md file to give Qwen Code persistent project context.':
    'Afegiu un fitxer QWEN.md per donar a Qwen Code un context persistent del projecte.',
  'Use /btw to ask a quick side question without disrupting the conversation.':
    'Useu /btw per fer una pregunta ràpida sense interrompre la conversa.',
  'Context is almost full! Run /compress now or start /new to continue.':
    'El context gairebé és ple! Executeu /compress ara o inicieu /new per continuar.',
  'Context is getting full. Use /compress to free up space.':
    "El context s'omple. Useu /compress per alliberar espai.",
  'Long conversation? /compress summarizes history to free context.':
    "Conversa llarga? /compress resumeix l'historial per alliberar context.",

  // ============================================================================
  // Pantalla de sortida / Estadístiques
  // ============================================================================
  'Agent powering down. Goodbye!': "L'agent s'apaga. Fins aviat!",
  'To continue this session, run': 'Per continuar aquesta sessió, executeu',
  'Interaction Summary': 'Resum de la interacció',
  'Session ID:': 'ID de sessió:',
  'Tool Calls:': 'Crides a eines:',
  'Success Rate:': "Taxa d'èxit:",
  'User Agreement:': "Acord de l'usuari:",
  reviewed: 'revisades',
  'Code Changes:': 'Canvis de codi:',
  Performance: 'Rendiment',
  'Wall Time:': 'Temps real:',
  'Agent Active:': 'Agent actiu:',
  'API Time:': "Temps de l'API:",
  'Tool Time:': "Temps d'eines:",
  'Session Stats': 'Estadístiques de la sessió',
  'Model Usage': 'Ús del model',
  Reqs: 'Sol·licituds',
  'Input Tokens': "Tokens d'entrada",
  'Output Tokens': 'Tokens de sortida',
  'Savings Highlight:': 'Estalvis destacats:',
  'of input tokens were served from the cache, reducing costs.':
    "dels tokens d'entrada s'han servit des de la memòria cau, reduint els costos.",
  'Tip: For a full token breakdown, run `/stats model`.':
    'Consell: Per a un desglossament complet de tokens, executeu `/stats model`.',
  'Model Stats For Nerds': 'Estadístiques del model per a nerds',
  'Tool Stats For Nerds': "Estadístiques d'eines per a nerds",
  Metric: 'Mètrica',
  API: 'API',
  Requests: 'Sol·licituds',
  Errors: 'Errors',
  'Avg Latency': 'Latència mitjana',
  Tokens: 'Tokens',
  Total: 'Total',
  Prompt: 'Missatge',
  Cached: 'En memòria cau',
  Thoughts: 'Pensaments',
  Tool: 'Eina',
  Output: 'Sortida',
  'No API calls have been made in this session.':
    "No s'ha realitzat cap crida a l'API en aquesta sessió.",
  'Tool Name': "Nom de l'eina",
  Calls: 'Crides',
  'Success Rate': "Taxa d'èxit",
  'Avg Duration': 'Durada mitjana',
  'User Decision Summary': "Resum de decisions de l'usuari",
  'Total Reviewed Suggestions:': 'Total de suggeriments revisats:',
  ' » Accepted:': ' » Acceptats:',
  ' » Rejected:': ' » Rebutjats:',
  ' » Modified:': ' » Modificats:',
  ' Overall Agreement Rate:': " Taxa d'acord global:",
  'No tool calls have been made in this session.':
    "No s'ha realitzat cap crida a eines en aquesta sessió.",
  'Session start time is unavailable, cannot calculate stats.':
    "L'hora d'inici de la sessió no està disponible, no es poden calcular les estadístiques.",

  // ============================================================================
  // Migració del format d'ordres
  // ============================================================================
  'Command Format Migration': "Migració del format d'ordres",
  'Found {{count}} TOML command file:':
    "S'ha trobat {{count}} fitxer d'ordres TOML:",
  'Found {{count}} TOML command files:':
    "S'han trobat {{count}} fitxers d'ordres TOML:",
  'Current tasks': 'Tasques actuals',
  '... and {{count}} more': '... i {{count}} més',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'El format TOML és obsolet. Voleu migrar-los al format Markdown?',
  '(Backups will be created and original files will be preserved)':
    '(Es crearan còpies de seguretat i els fitxers originals es conservaran)',

  // ============================================================================
  // Frases de càrrega
  // ============================================================================
  'Waiting for user confirmation...': "Esperant la confirmació de l'usuari...",
  '(esc to cancel, {{time}})': '(esc per cancel·lar, {{time}})',

  // ============================================================================
  // Frases de càrrega enginyoses
  // ============================================================================
  WITTY_LOADING_PHRASES: [
    'Em sento afortunat',
    'Enviant el millor...',
    "Setze jutges d'un jutjat mengen fetge d'un penjat.",
    'Navegant pel fong mucilaginós...',
    'Consultant els esperits digitals...',
    'Desperta ferro...',
    'Escalfant els hàmsters de la IA...',
    'Preguntant a la petxina màgica...',
    'Generant una rèplica enginyosa...',
    'Polint els algorismes...',
    'No correu la perfecció (ni el meu codi)...',
    'Preparant bytes frescos...',
    'Comptant electrons...',
    'Activant els processadors cognitius...',
    "Buscant errors de sintaxi a l'univers...",
    "Un moment, optimitzant l'humor...",
    'Barrejant les gràcies...',
    'Desenredant les xarxes neuronals...',
    'Compilant la brillantor...',
    'Carregant gràcia.exe...',
    'Invocant el núvol de saviesa...',
    'Preparant una resposta enginyosa...',
    'Un segon, estic depurant la realitat...',
    'Donant els últims cops de...',
    'Afinant les freqüències còsmiques...',
    'Elaborant una resposta digna de la vostra paciència...',
    'Compilant els 1 i els 0...',
    'Resolent dependències... i crisis existencials...',
    'Desfragmentant records... tant de RAM com personals...',
    "Reiniciant el mòdul de l'humor...",
    'Emmagatzemant en memòria cau el necessari (principalment mems de gats)...',
    'Optimitzant per a velocitat ridícula',
    'Intercanviant bits... que no ho sàpiguen els bytes...',
    'Recollint brossa... torno de seguida...',
    'Assemblant les internets...',
    'Convertint cafè en codi...',
    'Actualitzant la sintaxi de la realitat...',
    'Reconnectant les sinapsis...',
    'Buscant un punt i coma mal posat...',
    'Engreixant els engranatges de la màquina...',
    'Precalfant els servidors...',
    'Calibrant el condensador de flux...',
    'Activant el motor de improbabilitat...',
    'Canalitzant la Força...',
    'Alineant les estrelles per a una resposta òptima...',
    'I tots ho diem...',
    'Carregant la propera gran idea...',
    'Un moment, estic en el meu element...',
    'Preparant-me per impressionar-vos amb brillantor...',
    'Un moment, polint el meu enginy...',
    'Aguanteu, estic creant una obra mestra...',
    "Un moment, depurant l'univers...",
    'Un moment, alineant els píxels...',
    "Un segon, optimitzant l'humor...",
    'Un moment, afinant els algorismes...',
    'Velocitat de curvatura activada...',
    'Preparant la següent jugada mestre...',
    'No us espanteu...',
    'Seguint el conill blanc...',
    'La veritat és aquí... en algun lloc...',
    'Bufant al cartutx...',
    'Carregant... Feu un gir de barril!',
    'Esperant la reaparició...',
    'Paciència, pensa que Rodalies encara va més lent...',
    "El pastís no és una mentida, simplement s'està carregant...",
    'Tafanejant la pantalla de creació de personatge...',
    'Un moment, trobo el meme adequat...',
    "Prement 'A' per continuar...",
    'Pasturant gats digitals...',
    'Polint els píxels...',
    'Buscant un acudit per a la pantalla de càrrega...',
    'Distreu-vos amb aquesta frase enginyosa...',
    'Gairebé a punt... probablement...',
    'Els nostres hàmsters treballen tan ràpid com poden...',
    'Donant un copet al cap a Cloudy...',
    'Fent festes al gat...',
    'Endavant les atxes...',
    'Mai no us deixaré anar, mai no us decebré...',
    'Tocant el baix...',
    'Vaig a buscar ratafia...',
    'Vaig a tota velocitat, vaig a tota marxa...',
    'És la vida real? És sols fantasia?...',
    'Tinc bon pressentiment sobre això...',
    'Tocant el tigre...',
    'Investigant els últims mems...',
    'Pensant com fer això més enginyós...',
    'Hmm... deixeu-me pensar...',
    'Suant la cansalada...',
    'Trient el fetge per la boca...',
    "Posar fil a l'agulla...",
    'Un moment, ho tenim a tocar..',
    'Això és bufar i fer ampolles',
    'Què pots fer amb un llapis trencat? Res, no té punta...',
    'Aplicant manteniment percussiu...',
    "Buscant l'orientació correcta de l'USB...",
    'Assegurant que el fum màgic quedi dins dels cables...',
    'Intentant sortir del Vim...',
    'Girant la roda del hàmster...',
    'Això no és un error, és una característica no documentada...',
    'Endavant.',
    'Tornaré... amb una resposta.',
    'El meu altre procés és una TARDIS...',
    'Posant oli als engranatges...',
    'Deixant que els pensaments macerin...',
    'Acabo de recordar on he deixat les claus...',
    "Ponderant l'orbe...",
    'He vist coses que no creuríeu... com un usuari que llegeix els missatges de càrrega.',
    'Iniciant la mirada pensativa...',
    "Quin és el berenar preferit d'un computador? Xips micro.",
    'Per què els programadors de Java porten ulleres? Perquè no veuen en C#.',
    'Carregant el làser... piu piu!',
    'Dividint per zero... és broma!',
    'Buscant un supervisor adult... és a dir, processant.',
    'Fent que faci xup xup.',
    'Emmarcant... perquè fins i tot les IA necessiten un moment.',
    'Entrellaçant partícules quàntiques per a una resposta més ràpida...',
    'Polint el crom... dels algorismes.',
    'No esteu entretinguts? (Hi estem treballant!)',
    'Invocant els follets del codi... per ajudar, és clar.',
    'Esperant que acabi el so del mòdem de marcació...',
    "Recalibrant el mesurament de l'humor.",
    'La meva altra pantalla de càrrega és fins i tot més divertida.',
    'Estic bastant segur que hi ha un gat caminant per algun teclat...',
    'Millorant... millorant... encara carregant.',
    "No és un error, és una característica... d'aquesta pantalla de càrrega.",
    'Heu provat apagar-ho i tornar-lo a encendre? (La pantalla de càrrega, no jo.)',
    'Construint piló addicionals...',
  ],

  // ============================================================================
  // Entrada de configuració d'extensions
  // ============================================================================
  'Enter value...': 'Introduïu el valor...',
  'Enter sensitive value...': 'Introduïu el valor sensible...',
  'Press Enter to submit, Escape to cancel':
    'Premeu Retorn per enviar, Esc per cancel·lar',

  // ============================================================================
  // Eina de migració d'ordres
  // ============================================================================
  'Markdown file already exists: {{filename}}':
    'El fitxer Markdown ja existeix: {{filename}}',
  'TOML Command Format Deprecation Notice':
    "Avís d'obsolescència del format d'ordres TOML",
  'Found {{count}} command file(s) in TOML format:':
    "S'ha(n) trobat {{count}} fitxer(s) d'ordres en format TOML:",
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    "El format TOML per a ordres s'està fent obsolet en favor del format Markdown.",
  'Markdown format is more readable and easier to edit.':
    "El format Markdown és més llegible i fàcil d'editar.",
  'You can migrate these files automatically using:':
    'Podeu migrar aquests fitxers automàticament usant:',
  'Or manually convert each file:': 'O convertiu cada fitxer manualment:',
  'TOML: prompt = "..." / description = "..."':
    'TOML: prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content':
    'Markdown: capçalera YAML + contingut',
  'The migration tool will:': "L'eina de migració farà:",
  'Convert TOML files to Markdown': 'Convertir fitxers TOML a Markdown',
  'Create backups of original files':
    'Crear còpies de seguretat dels fitxers originals',
  'Preserve all command functionality':
    'Preservar tota la funcionalitat de les ordres',
  'TOML format will continue to work for now, but migration is recommended.':
    'El format TOML seguirà funcionant de moment, però es recomana la migració.',

  // ============================================================================
  // Extensions - Ordre d'explorar
  // ============================================================================
  'Open extensions page in your browser':
    "Obrir la pàgina d'extensions al vostre navegador",
  'Unknown extensions source: {{source}}.':
    "Font d'extensions desconeguda: {{source}}.",
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    "Obriria la pàgina d'extensions al vostre navegador: {{url}} (omès en entorn de proves)",
  'View available extensions at {{url}}':
    'Veure les extensions disponibles a {{url}}',
  'Opening extensions page in your browser: {{url}}':
    "Obrint la pàgina d'extensions al vostre navegador: {{url}}",
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    "Error en obrir el navegador. Visiteu la galeria d'extensions a {{url}}",

  // ============================================================================
  // Reintents / Límit de velocitat
  // ============================================================================
  'Rate limit error: {{reason}}': 'Error de límit de velocitat: {{reason}}',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    'Reintentant en {{seconds}} segons… (intent {{attempt}}/{{maxRetries}})',
  'Press Ctrl+Y to retry': 'Premeu Ctrl+Y per reintentar',
  'No failed request to retry.':
    'No hi ha cap sol·licitud fallida per reintentar.',
  'to retry last request': "per reintentar l'última sol·licitud",

  // ============================================================================
  // Autenticació del Coding Plan
  // ============================================================================
  'API key cannot be empty.': 'La clau API no pot estar buida.',
  'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.':
    'Clau API no vàlida. Les claus API del Coding Plan comencen per "sk-sp-". Comproveu-la.',
  'You can get your Coding Plan API key here':
    'Podeu obtenir la vostra clau API del Coding Plan aquí',
  'API key is stored in settings.env. You can migrate it to a .env file for better security.':
    "La clau API s'emmagatzema a settings.env. Podeu migrar-la a un fitxer .env per una millor seguretat.",
  'New model configurations are available for Alibaba Cloud Coding Plan. Update now?':
    "Hi ha noves configuracions de model disponibles per al Coding Plan d'Alibaba Cloud. Actualitzeu ara?",
  'Coding Plan configuration updated successfully. New models are now available.':
    "La configuració del Coding Plan s'ha actualitzat correctament. Ara hi ha nous models disponibles.",
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    "No s'ha trobat la clau API del Coding Plan. Torneu a autenticar-vos amb el Coding Plan.",
  'Failed to update Coding Plan configuration: {{message}}':
    'Error en actualitzar la configuració del Coding Plan: {{message}}',

  // ============================================================================
  // Configuració de clau API personalitzada
  // ============================================================================
  'You can configure your API key and models in settings.json':
    'Podeu configurar la vostra clau API i els models a settings.json',
  'Refer to the documentation for setup instructions':
    'Consulteu la documentació per a les instruccions de configuració',

  // ============================================================================
  // Diàleg d'autenticació - Títols i etiquetes
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  "Paste your api key of ModelStudio Coding Plan and you're all set!":
    'Enganxeu la vostra clau API del Coding Plan de ModelStudio i ja esteu llest!',
  Custom: 'Personalitzat',
  'More instructions about configuring `modelProviders` manually.':
    'Més instruccions sobre la configuració manual de `modelProviders`.',
  'Select API-KEY configuration mode:':
    'Seleccioneu el mode de configuració de la clau API:',
  '(Press Escape to go back)': '(Premeu Esc per tornar enrere)',
  '(Press Enter to submit, Escape to cancel)':
    '(Premeu Retorn per enviar, Esc per cancel·lar)',
  'Select Region for Coding Plan': 'Seleccioneu la regió per al Coding Plan',
  'Choose based on where your account is registered':
    "Trieu en funció d'on teniu registrat el compte",
  'Enter Coding Plan API Key': 'Introduïu la clau API del Coding Plan',

  // ============================================================================
  // Actualitzacions internacionals del Coding Plan
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    'Hi ha noves configuracions de model disponibles per a {{region}}. Actualitzeu ara?',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    'La configuració de {{region}} s\'ha actualitzat correctament. El model ha canviat a "{{model}}".',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json (backed up).':
    "S'ha autenticat correctament amb {{region}}. La clau API i les configuracions del model s'han desat a settings.json (amb còpia de seguretat).",

  // ============================================================================
  // Component d'ús del context
  // ============================================================================
  'Context Usage': 'Ús del context',
  '% used': '% usat',
  '% context used': '% del context usat',
  'Context exceeds limit! Use /compress or /clear to reduce.':
    'El context supera el límit! Useu /compress o /clear per reduir-lo.',
  'Use /compress or /clear': 'Useu /compress o /clear',
  'No API response yet. Send a message to see actual usage.':
    "Encara no hi ha cap resposta de l'API. Envieu un missatge per veure l'ús real.",
  'Estimated pre-conversation overhead':
    'Càrrega estimada prèvia a la conversa',
  'Context window': 'Finestra de context',
  tokens: 'tokens',
  Used: 'Usat',
  Free: 'Lliure',
  'Autocompact buffer': 'Memòria intermèdia de compactació automàtica',
  'Usage by category': 'Ús per categoria',
  'System prompt': 'Missatge del sistema',
  'Built-in tools': 'Eines integrades',
  'MCP tools': 'Eines MCP',
  'Memory files': 'Fitxers de memòria',
  Skills: 'Habilitats',
  Messages: 'Missatges',
  'Show context window usage breakdown.':
    "Mostrar el desglossament de l'ús de la finestra de context.",
  'Run /context detail for per-item breakdown.':
    'Executeu /context detail per a un desglossament per element.',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.':
    'Mostrar el desglossament de l\'ús de la finestra de context. Useu "/context detail" per a un desglossament per element.',
  'body loaded': 'cos carregat',
  memory: 'memòria',
  '{{region}} configuration updated successfully.':
    "La configuració de {{region}} s'ha actualitzat correctament.",
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    "S'ha autenticat correctament amb {{region}}. La clau API i les configuracions del model s'han desat a settings.json.",
  'Tip: Use /model to switch between available Coding Plan models.':
    'Consell: Useu /model per canviar entre els models del Coding Plan disponibles.',

  // ============================================================================
  // Eina de preguntes a l'usuari
  // ============================================================================
  'Please answer the following question(s):':
    'Responeu la(es) pregunta(es) següent(s):',
  'Cannot ask user questions in non-interactive mode. Please run in interactive mode to use this tool.':
    "No es poden fer preguntes a l'usuari en mode no interactiu. Executeu en mode interactiu per usar aquesta eina.",
  'User declined to answer the questions.':
    "L'usuari ha declinat respondre les preguntes.",
  'User has provided the following answers:':
    "L'usuari ha proporcionat les respostes següents:",
  'Failed to process user answers:':
    "Error en processar les respostes de l'usuari:",
  'Type something...': 'Escriviu alguna cosa...',
  Submit: 'Enviar',
  'Submit answers': 'Enviar respostes',
  Cancel: 'Cancel·lar',
  'Your answers:': 'Les vostres respostes:',
  '(not answered)': '(sense resposta)',
  'Ready to submit your answers?':
    'Preparats per enviar les vostres respostes?',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓: Navegar | ←/→: Canviar pestanyes | Retorn: Seleccionar',
  '↑/↓: Navigate | ←/→: Switch tabs | Space/Enter: Toggle | Esc: Cancel':
    '↑/↓: Navegar | ←/→: Canviar pestanyes | Espai/Retorn: Canviar | Esc: Cancel·lar',
  '↑/↓: Navigate | Space/Enter: Toggle | Esc: Cancel':
    '↑/↓: Navegar | Espai/Retorn: Canviar | Esc: Cancel·lar',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓: Navegar | Retorn: Seleccionar | Esc: Cancel·lar',

  // ============================================================================
  // Ordres - Autenticació
  // ============================================================================
  'Configure Qwen authentication information with Qwen-OAuth or Alibaba Cloud Coding Plan':
    "Configurar la informació d'autenticació de Qwen amb Qwen-OAuth o el Coding Plan d'Alibaba Cloud",
  'Authenticate using Qwen OAuth': 'Autenticar-se usant Qwen OAuth',
  'Authenticate using Alibaba Cloud Coding Plan':
    "Autenticar-se usant el Coding Plan d'Alibaba Cloud",
  'Region for Coding Plan (china/global)':
    'Regió per al Coding Plan (china/global)',
  'API key for Coding Plan': 'Clau API per al Coding Plan',
  'Show current authentication status': "Mostrar l'estat d'autenticació actual",
  'Authentication completed successfully.':
    "L'autenticació s'ha completat correctament.",
  'Starting Qwen OAuth authentication...':
    "Iniciant l'autenticació Qwen OAuth...",
  'Successfully authenticated with Qwen OAuth.':
    "S'ha autenticat correctament amb Qwen OAuth.",
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'Error en autenticar-se amb Qwen OAuth: {{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    "Processant l'autenticació del Coding Plan d'Alibaba Cloud...",
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    "S'ha autenticat correctament amb el Coding Plan d'Alibaba Cloud.",
  'Failed to authenticate with Coding Plan: {{error}}':
    'Error en autenticar-se amb el Coding Plan: {{error}}',
  '中国 (China)': '中国 (China)',
  '阿里云百炼 (aliyun.com)': '阿里云百炼 (aliyun.com)',
  Global: 'Global',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': 'Seleccioneu la regió per al Coding Plan:',
  'Enter your Coding Plan API key: ':
    'Introduïu la vostra clau API del Coding Plan: ',
  'Select authentication method:': "Seleccioneu el mètode d'autenticació:",
  '\n=== Authentication Status ===\n': "\n=== Estat d'autenticació ===\n",
  '⚠️  No authentication method configured.\n':
    "⚠️  Cap mètode d'autenticació configurat.\n",
  'Run one of the following commands to get started:\n':
    'Executeu una de les ordres següents per començar:\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)':
    '  qwen auth qwen-oauth     - Autenticar-se amb Qwen OAuth (descontinuat)',
  '  qwen auth coding-plan      - Authenticate with Alibaba Cloud Coding Plan\n':
    "  qwen auth coding-plan      - Autenticar-se amb el Coding Plan d'Alibaba Cloud\n",
  'Or simply run:': 'O simplement executeu:',
  '  qwen auth                - Interactive authentication setup\n':
    "  qwen auth                - Configuració interactiva de l'autenticació\n",
  '✓ Authentication Method: Qwen OAuth': "✓ Mètode d'autenticació: Qwen OAuth",
  '  Type: Free tier (discontinued 2026-04-15)':
    '  Tipus: Nivell gratuït (descontinuat el 15-04-2026)',
  '  Limit: No longer available': '  Límit: Ja no disponible',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.':
    'El nivell gratuït de Qwen OAuth es va descontinuar el 15-04-2026. Executeu /auth per canviar al Coding Plan, OpenRouter, Fireworks AI o un altre proveïdor.',
  '  Models: Qwen latest models\n': '  Models: Últims models Qwen\n',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    "✓ Mètode d'autenticació: Coding Plan d'Alibaba Cloud",
  '中国 (China) - 阿里云百炼': '中国 (China) - 阿里云百炼',
  'Global - Alibaba Cloud': 'Global - Alibaba Cloud',
  '  Region: {{region}}': '  Regió: {{region}}',
  '  Current Model: {{model}}': '  Model actual: {{model}}',
  '  Config Version: {{version}}': '  Versió de configuració: {{version}}',
  '  Status: API key configured\n': '  Estat: Clau API configurada\n',
  '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    "⚠️  Mètode d'autenticació: Coding Plan d'Alibaba Cloud (Incomplet)",
  '  Issue: API key not found in environment or settings\n':
    "  Problema: Clau API no trobada a l'entorn o la configuració\n",
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  Executeu `qwen auth coding-plan` per tornar a configurar.\n',
  '✓ Authentication Method: {{type}}': "✓ Mètode d'autenticació: {{type}}",
  '  Status: Configured\n': '  Estat: Configurat\n',
  'Failed to check authentication status: {{error}}':
    "Error en comprovar l'estat d'autenticació: {{error}}",
  'Select an option:': 'Seleccioneu una opció:',
  'Raw mode not available. Please run in an interactive terminal.':
    'El mode raw no està disponible. Executeu en un terminal interactiu.',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(Useu les fletxes ↑ ↓ per navegar, Retorn per seleccionar, Ctrl+C per sortir)\n',
  compact: 'compacte',
  'compact mode: on (Ctrl+O off)':
    'mode compacte: activat (Ctrl+O per desactivar)',
  'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).':
    'Amagueu la sortida de les eines i el pensament per a una vista més neta (canvieu amb Ctrl+O).',
  'Press Ctrl+O to show full tool output':
    'Premeu Ctrl+O per mostrar la sortida completa de les eines',

  'Switch to plan mode or exit plan mode':
    'Canviar al mode de planificació o sortir del mode de planificació',
  'Exited plan mode. Previous approval mode restored.':
    "S'ha sortit del mode de planificació. S'ha restaurat el mode d'aprovació anterior.",
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    "S'ha activat el mode de planificació. L'agent analitzarà i planificarà sense executar eines.",
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    'Ja esteu en mode de planificació. Useu "/plan exit" per sortir del mode de planificació.',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    'No esteu en mode de planificació. Useu "/plan" per entrar al mode de planificació primer.',

  "Set up Qwen Code's status line UI":
    "Configurar la interfície de la barra d'estat de Qwen Code",
};
