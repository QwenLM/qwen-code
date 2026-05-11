/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// German translations for Qwen Code CLI
// Deutsche Übersetzungen für Qwen Code CLI

export default {
  // ============================================================================
  // Help / UI Components
  // ============================================================================
  // Attachment hints
  '↑ to manage attachments': '↑ Anhänge verwalten',
  '← → select, Delete to remove, ↓ to exit':
    '← → auswählen, Delete zum Löschen, ↓ beenden',
  'Attachments: ': 'Anhänge: ',
  'Basics:': 'Grundlagen:',
  'Add context': 'Kontext hinzufügen',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    'Verwenden Sie {{symbol}}, um Dateien als Kontext anzugeben (z.B. {{example}}), um bestimmte Dateien oder Ordner auszuwählen.',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Shell-Modus',
  'YOLO mode': 'YOLO-Modus',
  'plan mode': 'Planungsmodus',
  'auto-accept edits': 'Änderungen automatisch akzeptieren',
  'Accepting edits': 'Änderungen werden akzeptiert',
  '(shift + tab to cycle)': '(Shift + Tab zum Wechseln)',
  '(tab to cycle)': '(Tab zum Wechseln)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    'Shell-Befehle über {{symbol}} ausführen (z.B. {{example1}}) oder natürliche Sprache verwenden (z.B. {{example2}}).',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'Server starten',
  'Commands:': 'Befehle:',
  'shell command': 'Shell-Befehl',
  'Model Context Protocol command (from external servers)':
    'Model Context Protocol Befehl (von externen Servern)',
  'Keyboard Shortcuts:': 'Tastenkürzel:',
  'Jump through words in the input': 'Wörter in der Eingabe überspringen',
  'Close dialogs, cancel requests, or quit application':
    'Dialoge schließen, Anfragen abbrechen oder Anwendung beenden',
  'New line': 'Neue Zeile',
  'New line (Alt+Enter works for certain linux distros)':
    'Neue Zeile (Alt+Enter funktioniert bei bestimmten Linux-Distributionen)',
  'Clear the screen': 'Bildschirm löschen',
  'Open input in external editor': 'Eingabe in externem Editor öffnen',
  'Send message': 'Nachricht senden',
  'Initializing...': 'Initialisierung...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    'Verbindung zu MCP servers wird hergestellt... ({{connected}}/{{total}})',
  'Type your message or @path/to/file':
    'Nachricht eingeben oder @Pfad/zur/Datei',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "Drücken Sie 'i' für den EINFÜGE-Modus und 'Esc' für den NORMAL-Modus.",
  'Cancel operation / Clear input (double press)':
    'Vorgang abbrechen / Eingabe löschen (doppelt drücken)',
  'Cycle approval modes': 'Genehmigungsmodi durchschalten',
  'Cycle through your prompt history': 'Eingabeverlauf durchblättern',
  'For a full list of shortcuts, see {{docPath}}':
    'Eine vollständige Liste der Tastenkürzel finden Sie unter {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': 'für Hilfe zu Qwen Code',
  'show version info': 'Versionsinformationen anzeigen',
  'submit a bug report': 'Fehlerbericht einreichen',
  Status: 'Status',

  // ============================================================================
  // System Information Fields
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: 'Laufzeit',
  OS: 'Betriebssystem',
  Auth: 'Authentifizierung',
  Model: 'Modell',
  'Fast Model': 'Schnelles Modell',
  Sandbox: 'Sandbox',
  'Session ID': 'Sitzungs-ID',
  'Base URL': 'Base URL',
  Proxy: 'Proxy',
  'Memory Usage': 'Speichernutzung',
  'IDE Client': 'IDE-Client',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Analysiert das Projekt und erstellt eine maßgeschneiderte QWEN.md-Datei.',
  'List available Qwen Code tools. Usage: /tools [desc]':
    'Verfügbare Qwen Code Werkzeuge auflisten. Verwendung: /tools [desc]',
  'List available skills.': 'Verfügbare Skills auflisten.',
  'Available Qwen Code CLI tools:': 'Verfügbare Qwen Code CLI-Werkzeuge:',
  'No tools available': 'Keine Werkzeuge verfügbar',
  'View or change the approval mode for tool usage':
    'Genehmigungsmodus für Werkzeugnutzung anzeigen oder ändern',
  'View or change the language setting':
    'Spracheinstellung anzeigen oder ändern',
  'List background tasks (text dump — interactive dialog opens via the footer pill)':
    'Hintergrundaufgaben auflisten (Textausgabe; der interaktive Dialog lässt sich über die Schaltfläche in der Fußzeile öffnen)',
  'Delete a previous session': 'Eine frühere Sitzung löschen',
  'Run installation and environment diagnostics':
    'Installations- und Umgebungsdiagnosen ausführen',
  'Browse dynamic model catalogs and choose which models stay enabled locally':
    'Dynamische Modellkataloge durchsuchen und auswählen, welche Modelle lokal aktiviert bleiben',
  'Generate a one-line session recap now':
    'Jetzt eine einzeilige Sitzungszusammenfassung erstellen',
  'Rename the current conversation. --auto lets the fast model pick a title.':
    'Die aktuelle Unterhaltung umbenennen. Mit --auto lässt du das schnelle Modell einen Titel wählen.',
  'Rewind conversation to a previous turn':
    'Die Unterhaltung auf einen früheren Gesprächsschritt zurücksetzen',
  'change the theme': 'Design ändern',
  'Select Theme': 'Design auswählen',
  Preview: 'Vorschau',
  '(Use Enter to select, Tab to configure scope)':
    '(Enter zum Auswählen, Tab zum Konfigurieren des Bereichs)',
  '(Use Enter to apply scope, Tab to go back)':
    '(Enter zum Anwenden des Bereichs, Tab zum Zurückgehen)',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    'Design-Konfiguration aufgrund der NO_COLOR-Umgebungsvariable nicht verfügbar.',
  'Theme "{{themeName}}" not found.': 'Design "{{themeName}}" nicht gefunden.',
  'Theme "{{themeName}}" not found in selected scope.':
    'Design "{{themeName}}" im ausgewählten Bereich nicht gefunden.',
  'Clear conversation history and free up context':
    'Gesprächsverlauf löschen und Kontext freigeben',
  'Compresses the context by replacing it with a summary.':
    'Komprimiert den Kontext durch Ersetzen mit einer Zusammenfassung.',
  'open full Qwen Code documentation in your browser':
    'Vollständige Qwen Code Dokumentation im Browser öffnen',
  'Configuration not available.': 'Konfiguration nicht verfügbar.',
  'Configure authentication information for login':
    'Authentifizierungsinformationen für die Anmeldung konfigurieren',
  'Copy the last result or code snippet to clipboard':
    'Letztes Ergebnis oder Codeausschnitt in die Zwischenablage kopieren',

  // ============================================================================
  // Commands - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    'Unteragenten für spezialisierte Aufgabendelegation verwalten.',
  'Manage existing subagents (view, edit, delete).':
    'Bestehende Unteragenten verwalten (anzeigen, bearbeiten, löschen).',
  'Create a new subagent with guided setup.':
    'Neuen Unteragenten mit geführter Einrichtung erstellen.',

  // ============================================================================
  // Agents - Management Dialog
  // ============================================================================
  Agents: 'Agenten',
  'Choose Action': 'Aktion wählen',
  'Edit {{name}}': '{{name}} bearbeiten',
  'Edit Tools: {{name}}': 'Werkzeuge bearbeiten: {{name}}',
  'Edit Color: {{name}}': 'Farbe bearbeiten: {{name}}',
  'Delete {{name}}': '{{name}} löschen',
  'Unknown Step': 'Unbekannter Schritt',
  'Esc to close': 'Esc zum Schließen',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Enter zum Auswählen, ↑↓ zum Navigieren, Esc zum Schließen',
  'Esc to go back': 'Esc zum Zurückgehen',
  'Enter to confirm, Esc to cancel': 'Enter zum Bestätigen, Esc zum Abbrechen',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Enter zum Auswählen, ↑↓ zum Navigieren, Esc zum Zurückgehen',
  'Enter to submit, Esc to go back': 'Enter zum Absenden, Esc zum Zurückgehen',
  'Invalid step: {{step}}': 'Ungültiger Schritt: {{step}}',
  'No subagents found.': 'Keine Unteragenten gefunden.',
  "Use '/agents create' to create your first subagent.":
    "Verwenden Sie '/agents create', um Ihren ersten Unteragenten zu erstellen.",
  '(built-in)': '(integriert)',
  '(overridden by project level agent)': '(überschrieben durch Projektagent)',
  'Project Level ({{path}})': 'Projektebene ({{path}})',
  'User Level ({{path}})': 'Benutzerebene ({{path}})',
  'Built-in Agents': 'Integrierte Agenten',
  'Extension Agents': 'Erweiterungs-Agenten',
  'Using: {{count}} agents': 'Verwendet: {{count}} Agenten',
  'View Agent': 'Agent anzeigen',
  'Edit Agent': 'Agent bearbeiten',
  'Delete Agent': 'Agent löschen',
  Back: 'Zurück',
  'No agent selected': 'Kein Agent ausgewählt',
  'File Path: ': 'Dateipfad: ',
  'Tools: ': 'Werkzeuge: ',
  'Color: ': 'Farbe: ',
  'Description:': 'Beschreibung:',
  'System Prompt:': 'System-Prompt:',
  'Open in editor': 'Im Editor öffnen',
  'Edit tools': 'Werkzeuge bearbeiten',
  'Edit color': 'Farbe bearbeiten',
  '❌ Error:': '❌ Fehler:',
  'Are you sure you want to delete agent "{{name}}"?':
    'Sind Sie sicher, dass Sie den Agenten "{{name}}" löschen möchten?',
  // ============================================================================
  // Agents - Creation Wizard
  // ============================================================================
  'Project Level (.qwen/agents/)': 'Projektebene (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': 'Benutzerebene (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!': '✅ Unteragent erfolgreich erstellt!',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    'Unteragent "{{name}}" wurde auf {{level}}-Ebene gespeichert.',
  'Name: ': 'Name: ',
  'Location: ': 'Speicherort: ',
  '❌ Error saving subagent:': '❌ Fehler beim Speichern des Unteragenten:',
  'Warnings:': 'Warnungen:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    'Name "{{name}}" existiert bereits auf {{level}}-Ebene - bestehender Unteragent wird überschrieben',
  'Name "{{name}}" exists at user level - project level will take precedence':
    'Name "{{name}}" existiert auf Benutzerebene - Projektebene hat Vorrang',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    'Name "{{name}}" existiert auf Projektebene - bestehender Unteragent hat Vorrang',
  'Description is over {{length}} characters':
    'Beschreibung ist über {{length}} Zeichen',
  'System prompt is over {{length}} characters':
    'System-Prompt ist über {{length}} Zeichen',
  // Agents - Creation Wizard Steps
  'Step {{n}}: Choose Location': 'Schritt {{n}}: Speicherort wählen',
  'Step {{n}}: Choose Generation Method':
    'Schritt {{n}}: Generierungsmethode wählen',
  'Generate with Qwen Code (Recommended)':
    'Mit Qwen Code generieren (Empfohlen)',
  'Manual Creation': 'Manuelle Erstellung',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    'Beschreiben Sie, was dieser Unteragent tun soll und wann er verwendet werden soll. (Ausführliche Beschreibung für beste Ergebnisse)',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    'z.B. Experte für Code-Reviews, der Code nach Best Practices überprüft...',
  'Generating subagent configuration...':
    'Unteragent-Konfiguration wird generiert...',
  'Failed to generate subagent: {{error}}':
    'Fehler beim Generieren des Unteragenten: {{error}}',
  'Step {{n}}: Describe Your Subagent': 'Schritt {{n}}: Unteragent beschreiben',
  'Step {{n}}: Enter Subagent Name': 'Schritt {{n}}: Unteragent-Name eingeben',
  'Step {{n}}: Enter System Prompt': 'Schritt {{n}}: System-Prompt eingeben',
  'Step {{n}}: Enter Description': 'Schritt {{n}}: Beschreibung eingeben',
  // Agents - Tool Selection
  'Step {{n}}: Select Tools': 'Schritt {{n}}: Werkzeuge auswählen',
  'All Tools (Default)': 'Alle Werkzeuge (Standard)',
  'All Tools': 'Alle Werkzeuge',
  'Read-only Tools': 'Nur-Lese-Werkzeuge',
  'Read & Edit Tools': 'Lese- und Bearbeitungswerkzeuge',
  'Read & Edit & Execution Tools':
    'Lese-, Bearbeitungs- und Ausführungswerkzeuge',
  'All tools selected, including MCP tools':
    'Alle Tools ausgewählt, einschließlich MCP tools',
  'Selected tools:': 'Ausgewählte Werkzeuge:',
  'Read-only tools:': 'Nur-Lese-Werkzeuge:',
  'Edit tools:': 'Bearbeitungswerkzeuge:',
  'Execution tools:': 'Ausführungswerkzeuge:',
  'Step {{n}}: Choose Background Color':
    'Schritt {{n}}: Hintergrundfarbe wählen',
  'Step {{n}}: Confirm and Save': 'Schritt {{n}}: Bestätigen und Speichern',
  // Agents - Navigation & Instructions
  'Esc to cancel': 'Esc zum Abbrechen',
  'Press Enter to save, e to save and edit, Esc to go back':
    'Enter zum Speichern, e zum Speichern und Bearbeiten, Esc zum Zurückgehen',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    'Enter zum Fortfahren, {{navigation}}Esc zum {{action}}',
  cancel: 'Abbrechen',
  'go back': 'Zurückgehen',
  '↑↓ to navigate, ': '↑↓ zum Navigieren, ',
  'Enter a clear, unique name for this subagent.':
    'Geben Sie einen eindeutigen Namen für diesen Unteragenten ein.',
  'e.g., Code Reviewer': 'z.B. Code-Reviewer',
  'Name cannot be empty.': 'Name darf nicht leer sein.',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    'Schreiben Sie den System-Prompt, der das Verhalten dieses Unteragenten definiert. Ausführlich für beste Ergebnisse.',
  'e.g., You are an expert code reviewer...':
    'z.B. Sie sind ein Experte für Code-Reviews...',
  'System prompt cannot be empty.': 'System-Prompt darf nicht leer sein.',
  'Describe when and how this subagent should be used.':
    'Beschreiben Sie, wann und wie dieser Unteragent verwendet werden soll.',
  'e.g., Reviews code for best practices and potential bugs.':
    'z.B. Überprüft Code auf Best Practices und mögliche Fehler.',
  'Description cannot be empty.': 'Beschreibung darf nicht leer sein.',
  'Failed to launch editor: {{error}}':
    'Fehler beim Starten des Editors: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    'Fehler beim Speichern und Bearbeiten des Unteragenten: {{error}}',

  // ============================================================================
  // Commands - General (continued)
  // ============================================================================
  'View and edit Qwen Code settings':
    'Qwen Code Einstellungen anzeigen und bearbeiten',
  Settings: 'Einstellungen',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'Um Änderungen zu sehen, muss Qwen Code neu gestartet werden. Drücken Sie r, um jetzt zu beenden und Änderungen anzuwenden.',
  // ============================================================================
  // Settings Labels
  // ============================================================================
  'Vim Mode': 'Vim-Modus',
  'Attribution: commit': 'Attribution: Commit',
  'Terminal Bell Notification': 'Terminal-Signalton',
  'Enable Usage Statistics': 'Nutzungsstatistiken aktivieren',
  Theme: 'Farbschema',
  'Preferred Editor': 'Bevorzugter Editor',
  'Auto-connect to IDE': 'Automatische Verbindung zur IDE',
  'Debug Keystroke Logging': 'Debug-Protokollierung von Tastatureingaben',
  'Language: UI': 'Sprache: Benutzeroberfläche',
  'Language: Model': 'Sprache: Modell',
  'Output Format': 'Ausgabeformat',
  'Hide Window Title': 'Fenstertitel ausblenden',
  'Show Status in Title': 'Status im Titel anzeigen',
  'Hide Tips': 'Tipps ausblenden',
  'Show Line Numbers in Code': 'Zeilennummern im Code anzeigen',
  'Show Citations': 'Quellenangaben anzeigen',
  'Custom Witty Phrases': 'Benutzerdefinierte Witzige Sprüche',
  'Show Welcome Back Dialog': 'Willkommen-zurück-Dialog anzeigen',
  'Enable User Feedback': 'Benutzerfeedback aktivieren',
  'How is Qwen doing this session? (optional)':
    'Wie macht sich Qwen in dieser Sitzung? (optional)',
  Bad: 'Schlecht',
  Fine: 'In Ordnung',
  Good: 'Gut',
  Dismiss: 'Ignorieren',
  'Screen Reader Mode': 'Bildschirmleser-Modus',
  'Max Session Turns': 'Maximale Sitzungsrunden',
  'Skip Next Speaker Check': 'Nächste-Sprecher-Prüfung überspringen',
  'Skip Loop Detection': 'Schleifenerkennung überspringen',
  'Skip Startup Context': 'Startkontext überspringen',
  'Enable OpenAI Logging': 'OpenAI-Protokollierung aktivieren',
  'OpenAI Logging Directory': 'OpenAI-Protokollierungsverzeichnis',
  Timeout: 'Zeitlimit',
  'Max Retries': 'Maximale Wiederholungen',
  'Load Memory From Include Directories':
    'Speicher aus Include-Verzeichnissen laden',
  'Respect .gitignore': '.gitignore beachten',
  'Respect .qwenignore': '.qwenignore beachten',
  'Enable Recursive File Search': 'Rekursive Dateisuche aktivieren',
  'Interactive Shell (PTY)': 'Interaktive Shell (PTY)',
  'Show Color': 'Farbe anzeigen',
  'Auto Accept': 'Automatisch akzeptieren',
  'Use Ripgrep': 'Ripgrep verwenden',
  'Use Builtin Ripgrep': 'Integriertes Ripgrep verwenden',
  'Tool Output Truncation Threshold':
    'Schwellenwert für Werkzeugausgabe-Kürzung',
  'Tool Output Truncation Lines': 'Zeilen für Werkzeugausgabe-Kürzung',
  'Folder Trust': 'Ordnervertrauen',
  'Tool Schema Compliance': 'Tool Schema-Konformität',
  // Settings enum options
  'Auto (detect from system)': 'Automatisch (vom System erkennen)',
  'Auto (detect terminal theme)': 'Automatisch (Terminal-Theme erkennen)',
  Auto: 'Automatisch',
  Text: 'Text',
  JSON: 'JSON',
  Plan: 'Plan',
  Default: 'Standard',
  'Auto Edit': 'Automatisch bearbeiten',
  YOLO: 'YOLO',
  'toggle vim mode on/off': 'Vim-Modus ein-/ausschalten',
  'check session stats. Usage: /stats [model|tools]':
    'Sitzungsstatistiken prüfen. Verwendung: /stats [model|tools]',
  'Show model-specific usage statistics.':
    'Modellspezifische Nutzungsstatistiken anzeigen.',
  'Show tool-specific usage statistics.':
    'Werkzeugspezifische Nutzungsstatistiken anzeigen.',
  'exit the cli': 'CLI beenden',
  'Manage workspace directories': 'Arbeitsbereichsverzeichnisse verwalten',
  'Add directories to the workspace. Use comma to separate multiple paths':
    'Verzeichnisse zum Arbeitsbereich hinzufügen. Komma zum Trennen mehrerer Pfade verwenden',
  'Show all directories in the workspace':
    'Alle Verzeichnisse im Arbeitsbereich anzeigen',
  'set external editor preference': 'Externen Editor festlegen',
  'Select Editor': 'Editor auswählen',
  'Editor Preference': 'Editor-Einstellung',
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    'Diese Editoren werden derzeit unterstützt. Bitte beachten Sie, dass einige Editoren nicht im Sandbox-Modus verwendet werden können.',
  'Your preferred editor is:': 'Ihr bevorzugter Editor ist:',
  'Manage extensions': 'Erweiterungen verwalten',
  'Manage installed extensions': 'Installierte Erweiterungen verwalten',
  'Disable an extension': 'Erweiterung deaktivieren',
  'Enable an extension': 'Erweiterung aktivieren',
  'Install an extension from a git repo or local path':
    'Erweiterung aus Git-Repository oder lokalem Pfad installieren',
  'Uninstall an extension': 'Erweiterung deinstallieren',
  'No extensions installed.': 'Keine Erweiterungen installiert.',
  'Extension "{{name}}" not found.': 'Erweiterung "{{name}}" nicht gefunden.',
  'No extensions to update.': 'Keine Erweiterungen zum Aktualisieren.',
  'Usage: /extensions install <source>':
    'Verwendung: /extensions install <Quelle>',
  'Installing extension from "{{source}}"...':
    'Installiere Erweiterung von "{{source}}"...',
  'Extension "{{name}}" installed successfully.':
    'Erweiterung "{{name}}" erfolgreich installiert.',
  'Failed to install extension from "{{source}}": {{error}}':
    'Fehler beim Installieren der Erweiterung von "{{source}}": {{error}}',
  'Do you want to continue? [Y/n]: ': 'Möchten Sie fortfahren? [Y/n]: ',
  'Do you want to continue?': 'Möchten Sie fortfahren?',
  'Installing extension "{{name}}".':
    'Erweiterung "{{name}}" wird installiert.',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**Erweiterungen können unerwartetes Verhalten verursachen. Stellen Sie sicher, dass Sie die Erweiterungsquelle untersucht haben und dem Autor vertrauen.**',
  'This extension will run the following MCP servers:':
    'Diese Erweiterung wird folgende MCP servers ausführen:',
  local: 'lokal',
  'This extension will add the following commands: {{commands}}.':
    'Diese Erweiterung wird folgende Befehle hinzufügen: {{commands}}.',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'Diese Erweiterung wird Informationen zu Ihrem QWEN.md-Kontext mit {{fileName}} hinzufügen',
  'This extension will install the following skills:':
    'Diese Erweiterung wird folgende Fähigkeiten installieren:',
  'This extension will install the following subagents:':
    'Diese Erweiterung wird folgende Unteragenten installieren:',
  'Installation cancelled for "{{name}}".':
    'Installation von "{{name}}" abgebrochen.',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    'Sie installieren eine Erweiterung von {{originSource}}. Einige Funktionen funktionieren möglicherweise nicht perfekt mit Qwen Code.',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    '--ref und --auto-update sind nicht anwendbar für Marketplace-Erweiterungen.',
  'Extension "{{name}}" installed successfully and enabled.':
    'Erweiterung "{{name}}" erfolgreich installiert und aktiviert.',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    'Die GitHub-URL, der lokale Pfad oder die Marketplace-Quelle (marketplace-url:plugin-name) der zu installierenden Erweiterung.',
  'The git ref to install from.': 'Die Git-Referenz für die Installation.',
  'Enable auto-update for this extension.':
    'Automatisches Update für diese Erweiterung aktivieren.',
  'Enable pre-release versions for this extension.':
    'Pre-Release-Versionen für diese Erweiterung aktivieren.',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    'Sicherheitsrisiken der Erweiterungsinstallation bestätigen und Bestätigungsaufforderung überspringen.',
  'The source argument must be provided.':
    'Das Quellargument muss angegeben werden.',
  'Extension "{{name}}" successfully uninstalled.':
    'Erweiterung "{{name}}" erfolgreich deinstalliert.',
  'Uninstalls an extension.': 'Deinstalliert eine Erweiterung.',
  'The name or source path of the extension to uninstall.':
    'Der Name oder Quellpfad der zu deinstallierenden Erweiterung.',
  'Please include the name of the extension to uninstall as a positional argument.':
    'Bitte geben Sie den Namen der zu deinstallierenden Erweiterung als Positionsargument an.',
  'Enables an extension.': 'Aktiviert eine Erweiterung.',
  'The name of the extension to enable.':
    'Der Name der zu aktivierenden Erweiterung.',
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    'Der Bereich, in dem die Erweiterung aktiviert werden soll. Wenn nicht gesetzt, wird sie in allen Bereichen aktiviert.',
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    'Erweiterung "{{name}}" erfolgreich für Bereich "{{scope}}" aktiviert.',
  'Extension "{{name}}" successfully enabled in all scopes.':
    'Erweiterung "{{name}}" erfolgreich in allen Bereichen aktiviert.',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    'Ungültiger Bereich: {{scope}}. Bitte verwenden Sie einen von {{scopes}}.',
  'Disables an extension.': 'Deaktiviert eine Erweiterung.',
  'The name of the extension to disable.':
    'Der Name der zu deaktivierenden Erweiterung.',
  'The scope to disable the extenison in.':
    'Der Bereich, in dem die Erweiterung deaktiviert werden soll.',
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    'Erweiterung "{{name}}" erfolgreich für Bereich "{{scope}}" deaktiviert.',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    'Erweiterung "{{name}}" erfolgreich aktualisiert: {{oldVersion}} → {{newVersion}}.',
  'Unable to install extension "{{name}}" due to missing install metadata':
    'Erweiterung "{{name}}" kann aufgrund fehlender Installationsmetadaten nicht installiert werden',
  'Extension "{{name}}" is already up to date.':
    'Erweiterung "{{name}}" ist bereits aktuell.',
  'Updates all extensions or a named extension to the latest version.':
    'Aktualisiert alle Erweiterungen oder eine benannte Erweiterung auf die neueste Version.',
  'The name of the extension to update.':
    'Der Name der zu aktualisierenden Erweiterung.',
  'Update all extensions.': 'Alle Erweiterungen aktualisieren.',
  'Either an extension name or --all must be provided':
    'Entweder ein Erweiterungsname oder --all muss angegeben werden',
  'Lists installed extensions.': 'Listet installierte Erweiterungen auf.',
  'Path:': 'Pfad:',
  'Source:': 'Quelle:',
  'Type:': 'Typ:',
  'Release tag:': 'Release-Tag:',
  'Enabled (User):': 'Aktiviert (Benutzer):',
  'Enabled (Workspace):': 'Aktiviert (Arbeitsbereich):',
  'Context files:': 'Kontextdateien:',
  'MCP servers:': 'MCP servers:',
  'Link extension failed to install.':
    'Verknüpfte Erweiterung konnte nicht installiert werden.',
  'Extension "{{name}}" linked successfully and enabled.':
    'Erweiterung "{{name}}" erfolgreich verknüpft und aktiviert.',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    'Verknüpft eine Erweiterung von einem lokalen Pfad. Änderungen am lokalen Pfad werden immer widergespiegelt.',
  'The name of the extension to link.':
    'Der Name der zu verknüpfenden Erweiterung.',
  'Set a specific setting for an extension.':
    'Legt eine bestimmte Einstellung für eine Erweiterung fest.',
  'Name of the extension to configure.':
    'Name der zu konfigurierenden Erweiterung.',
  'The setting to configure (name or env var).':
    'Die zu konfigurierende Einstellung (Name oder Umgebungsvariable).',
  'The scope to set the setting in.':
    'Der Bereich, in dem die Einstellung gesetzt werden soll.',
  'List all settings for an extension.':
    'Listet alle Einstellungen einer Erweiterung auf.',
  'Name of the extension.': 'Name der Erweiterung.',
  'Extension "{{name}}" has no settings to configure.':
    'Erweiterung "{{name}}" hat keine zu konfigurierenden Einstellungen.',
  'Settings for "{{name}}":': 'Einstellungen für "{{name}}":',
  '(workspace)': '(Arbeitsbereich)',
  '(user)': '(Benutzer)',
  '[not set]': '[nicht gesetzt]',
  '[value stored in keychain]': '[Wert in Schlüsselbund gespeichert]',
  'Manage extension settings.': 'Erweiterungseinstellungen verwalten.',
  'You need to specify a command (set or list).':
    'Sie müssen einen Befehl angeben (set oder list).',
  // ============================================================================
  // Plugin Choice / Marketplace
  // ============================================================================
  'No plugins available in this marketplace.':
    'In diesem Marktplatz sind keine Plugins verfügbar.',
  'Select a plugin to install from marketplace "{{name}}":':
    'Wählen Sie ein Plugin zur Installation aus Marktplatz "{{name}}":',
  'Plugin selection cancelled.': 'Plugin-Auswahl abgebrochen.',
  'Select a plugin from "{{name}}"': 'Plugin aus "{{name}}" auswählen',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    'Verwenden Sie ↑↓ oder j/k zum Navigieren, Enter zum Auswählen, Escape zum Abbrechen',
  '{{count}} more above': '{{count}} weitere oben',
  '{{count}} more below': '{{count}} weitere unten',
  'manage IDE integration': 'IDE-Integration verwalten',
  'check status of IDE integration': 'Status der IDE-Integration prüfen',
  'install required IDE companion for {{ideName}}':
    'Erforderlichen IDE-Begleiter für {{ideName}} installieren',
  'enable IDE integration': 'IDE-Integration aktivieren',
  'disable IDE integration': 'IDE-Integration deaktivieren',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    'IDE-Integration wird in Ihrer aktuellen Umgebung nicht unterstützt. Um diese Funktion zu nutzen, führen Sie Qwen Code in einer dieser unterstützten IDEs aus: VS Code oder VS Code-Forks.',
  'Set up GitHub Actions': 'GitHub Actions einrichten',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    'Terminal-Tastenbelegungen für mehrzeilige Eingabe konfigurieren (VS Code, Cursor, Windsurf, Trae)',
  'Please restart your terminal for the changes to take effect.':
    'Bitte starten Sie Ihr Terminal neu, damit die Änderungen wirksam werden.',
  'Failed to configure terminal: {{error}}':
    'Fehler beim Konfigurieren des Terminals: {{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    'Konnte {{terminalName}}-Konfigurationspfad unter Windows nicht ermitteln: APPDATA-Umgebungsvariable ist nicht gesetzt.',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} keybindings.json existiert, ist aber kein gültiges JSON-Array. Bitte korrigieren Sie die Datei manuell oder löschen Sie sie, um automatische Konfiguration zu ermöglichen.',
  'File: {{file}}': 'Datei: {{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    'Fehler beim Parsen von {{terminalName}} keybindings.json. Die Datei enthält ungültiges JSON. Bitte korrigieren Sie die Datei manuell oder löschen Sie sie, um automatische Konfiguration zu ermöglichen.',
  'Error: {{error}}': 'Fehler: {{error}}',
  'Shift+Enter binding already exists':
    'Shift+Enter-Belegung existiert bereits',
  'Ctrl+Enter binding already exists': 'Ctrl+Enter-Belegung existiert bereits',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    'Bestehende Tastenbelegungen erkannt. Keine Änderungen, um Konflikte zu vermeiden.',
  'Please check and modify manually if needed: {{file}}':
    'Bitte prüfen und bei Bedarf manuell ändern: {{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    'Shift+Enter und Ctrl+Enter Tastenbelegungen zu {{terminalName}} hinzugefügt.',
  'Modified: {{file}}': 'Geändert: {{file}}',
  '{{terminalName}} keybindings already configured.':
    '{{terminalName}}-Tastenbelegungen bereits konfiguriert.',
  'Failed to configure {{terminalName}}.':
    'Fehler beim Konfigurieren von {{terminalName}}.',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    'Ihr Terminal ist bereits für optimale Erfahrung mit mehrzeiliger Eingabe konfiguriert (Shift+Enter und Ctrl+Enter).',
  // ============================================================================
  // Commands - Hooks
  // ============================================================================
  'Manage Qwen Code hooks': 'Qwen Code-Hooks verwalten',
  'List all configured hooks': 'Alle konfigurierten Hooks auflisten',
  // Hooks - Dialog
  Hooks: 'Hooks',
  'Loading hooks...': 'Hooks werden geladen...',
  'Error loading hooks:': 'Fehler beim Laden der Hooks:',
  'Press Escape to close': 'Escape zum Schließen drücken',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    'Escape, Ctrl+C oder Ctrl+D zum Abbrechen',
  'Press Space, Enter, or Escape to dismiss':
    'Space, Enter oder Escape zum Schließen',
  'No hook selected': 'Kein Hook ausgewählt',
  // Hooks - List Step
  'No hook events found.': 'Keine Hook-Ereignisse gefunden.',
  '{{count}} hook configured': '{{count}} Hook konfiguriert',
  '{{count}} hooks configured': '{{count}} Hooks konfiguriert',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    'Dieses Menü ist schreibgeschützt. Um Hooks hinzuzufügen oder zu ändern, bearbeiten Sie settings.json direkt oder fragen Sie Qwen Code.',
  'Enter to select · Esc to cancel': 'Enter zum Auswählen · Esc zum Abbrechen',
  // Hooks - Detail Step
  'Exit codes:': 'Exit-Codes:',
  'Configured hooks:': 'Konfigurierte Hooks:',
  'No hooks configured for this event.':
    'Für dieses Ereignis sind keine Hooks konfiguriert.',
  'To add hooks, edit settings.json directly or ask Qwen.':
    'Um Hooks hinzuzufügen, bearbeiten Sie settings.json direkt oder fragen Sie Qwen.',
  'Enter to select · Esc to go back': 'Enter zum Auswählen · Esc zum Zurück',
  // Hooks - Config Detail Step
  'Hook details': 'Hook-Details',
  'Event:': 'Ereignis:',
  'Extension:': 'Erweiterung:',
  'Desc:': 'Beschreibung:',
  'No hook config selected': 'Keine Hook-Konfiguration ausgewählt',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    'Um diesen Hook zu ändern oder zu entfernen, bearbeiten Sie settings.json direkt oder fragen Sie Qwen.',
  // Hooks - Disabled Step
  'Hook Configuration - Disabled': 'Hook-Konfiguration - Deaktiviert',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    'Alle Hooks sind derzeit deaktiviert. Sie haben {{count}} die nicht ausgeführt werden.',
  '{{count}} configured hook': '{{count}} konfigurierter Hook',
  '{{count}} configured hooks': '{{count}} konfigurierte Hooks',
  'When hooks are disabled:': 'Wenn Hooks deaktiviert sind:',
  'No hook commands will execute': 'Keine Hook-Befehle werden ausgeführt',
  'StatusLine will not be displayed': 'StatusLine wird nicht angezeigt',
  'Tool operations will proceed without hook validation':
    'Tool-Operationen werden ohne Hook-Validierung fortgesetzt',
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    'Um Hooks wieder zu aktivieren, entfernen Sie "disableAllHooks" aus settings.json oder fragen Sie Qwen Code.',
  // Hooks - Source
  Project: 'Projekt',
  User: 'Benutzer',
  Skill: 'Skill',
  System: 'System',
  Extension: 'Erweiterung',
  'Local Settings': 'Lokale Einstellungen',
  'User Settings': 'Benutzereinstellungen',
  'System Settings': 'Systemeinstellungen',
  Extensions: 'Erweiterungen',
  'Session (temporary)': 'Sitzung (temporär)',
  // Hooks - Event Descriptions (short)
  'Before tool execution': 'Vor der Tool-Ausführung',
  'After tool execution': 'Nach der Tool-Ausführung',
  'After tool execution fails': 'Wenn die Tool-Ausführung fehlschlägt',
  'When notifications are sent': 'Wenn Benachrichtigungen gesendet werden',
  'When the user submits a prompt': 'Wenn der Benutzer einen Prompt absendet',
  'When a new session is started': 'Wenn eine neue Sitzung gestartet wird',
  'Right before Qwen Code concludes its response':
    'Direkt bevor Qwen Code seine Antwort abschließt',
  'When a subagent (Agent tool call) is started':
    'Wenn ein Subagent (Agent-Tool-Aufruf) gestartet wird',
  'Right before a subagent concludes its response':
    'Direkt bevor ein Subagent seine Antwort abschließt',
  'Before conversation compaction': 'Vor der Gesprächskomprimierung',
  'When a session is ending': 'Wenn eine Sitzung endet',
  'When a permission dialog is displayed':
    'Wenn ein Berechtigungsdialog angezeigt wird',
  'When a new todo item is created':
    'Wenn ein neues Todo-Element erstellt wird',
  'When a todo item is marked as completed':
    'Wenn ein Todo-Element als erledigt markiert wird',
  // Hooks - Event Descriptions (detailed)
  'Input to command is JSON of tool call arguments.':
    'Die Eingabe an den Befehl ist JSON der Tool-Aufruf-Argumente.',
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    'Die Eingabe an den Befehl ist JSON mit den Feldern "inputs" (Tool-Aufruf-Argumente) und "response" (Tool-Aufruf-Antwort).',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    'Die Eingabe an den Befehl ist JSON mit tool_name, tool_input, tool_use_id, error, error_type, is_interrupt und is_timeout.',
  'Input to command is JSON with notification message and type.':
    'Die Eingabe an den Befehl ist JSON mit Benachrichtigungsnachricht und -typ.',
  'Input to command is JSON with original user prompt text.':
    'Die Eingabe an den Befehl ist JSON mit dem ursprünglichen Benutzer-Prompt-Text.',
  'Input to command is JSON with session start source.':
    'Die Eingabe an den Befehl ist JSON mit der Sitzungsstart-Quelle.',
  'Input to command is JSON with session end reason.':
    'Die Eingabe an den Befehl ist JSON mit dem Sitzungsende-Grund.',
  'Input to command is JSON with agent_id and agent_type.':
    'Die Eingabe an den Befehl ist JSON mit agent_id und agent_type.',
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    'Die Eingabe an den Befehl ist JSON mit agent_id, agent_type und agent_transcript_path.',
  'Input to command is JSON with compaction details.':
    'Die Eingabe an den Befehl ist JSON mit Komprimierungsdetails.',
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    'Die Eingabe an den Befehl ist JSON mit tool_name, tool_input und tool_use_id. Ausgabe ist JSON mit hookSpecificOutput, das die Entscheidung zum Zulassen oder Ablehnen enthält.',
  'Input to command is JSON with todo_id, todo_content, todo_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    'Die Eingabe an den Befehl ist JSON mit todo_id, todo_content, todo_status, all_todos und phase. In validation ist die Ausgabe JSON mit decision (allow/block/deny) und reason. In postWrite wird block/deny ignoriert.',
  'Input to command is JSON with todo_id, todo_content, previous_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    'Die Eingabe an den Befehl ist JSON mit todo_id, todo_content, previous_status, all_todos und phase. In validation ist die Ausgabe JSON mit decision (allow/block/deny) und reason. In postWrite wird block/deny ignoriert.',
  // Hooks - Exit Code Descriptions
  'stdout/stderr not shown': 'stdout/stderr nicht angezeigt',
  'show stderr to model and continue conversation':
    'stderr dem Modell anzeigen und Konversation fortsetzen',
  'show stderr to user only': 'stderr nur dem Benutzer anzeigen',
  'stdout shown in transcript mode (ctrl+o)':
    'stdout im Transkriptmodus angezeigt (ctrl+o)',
  'show stderr to model immediately': 'stderr sofort dem Modell anzeigen',
  'show stderr to user only but continue with tool call':
    'stderr nur dem Benutzer anzeigen, aber mit Tool-Aufruf fortfahren',
  'block processing, erase original prompt, and show stderr to user only':
    'Verarbeitung blockieren, ursprünglichen Prompt löschen und stderr nur dem Benutzer anzeigen',
  'stdout shown to Qwen': 'stdout dem Qwen anzeigen',
  'show stderr to user only (blocking errors ignored)':
    'stderr nur dem Benutzer anzeigen (Blockierungsfehler ignoriert)',
  'command completes successfully': 'Befehl erfolgreich abgeschlossen',
  'stdout shown to subagent': 'stdout dem Subagenten anzeigen',
  'show stderr to subagent and continue having it run':
    'stderr dem Subagenten anzeigen und ihn weiterlaufen lassen',
  'stdout appended as custom compact instructions':
    'stdout als benutzerdefinierte Komprimierungsanweisungen angehängt',
  'block compaction': 'Komprimierung blockieren',
  'show stderr to user only but continue with compaction':
    'stderr nur dem Benutzer anzeigen, aber mit Komprimierung fortfahren',
  'use hook decision if provided':
    'Hook-Entscheidung verwenden, falls bereitgestellt',
  'allow todo creation': 'Todo-Erstellung zulassen',
  'block todo creation and show reason to model':
    'Todo-Erstellung blockieren und Grund dem Modell anzeigen',
  'allow todo completion': 'Todo-Abschluss zulassen',
  'block todo completion and show reason to model':
    'Todo-Abschluss blockieren und Grund dem Modell anzeigen',
  // Hooks - Messages
  'Config not loaded.': 'Konfiguration nicht geladen.',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'Hooks sind nicht aktiviert. Aktivieren Sie Hooks in den Einstellungen, um diese Funktion zu nutzen.',
  // ============================================================================
  // Commands - Session Export
  // ============================================================================
  'Export current session message history to a file':
    'Den Nachrichtenverlauf der aktuellen Sitzung in eine Datei exportieren',
  'Export session to HTML format': 'Sitzung in das HTML-Format exportieren',
  'Export session to JSON format': 'Sitzung in das JSON-Format exportieren',
  'Export session to JSONL format (one message per line)':
    'Sitzung in das JSONL-Format exportieren (eine Nachricht pro Zeile)',
  'Export session to markdown format':
    'Sitzung in das Markdown-Format exportieren',

  // ============================================================================
  // Commands - Insights
  // ============================================================================
  'generate personalized programming insights from your chat history':
    'Personalisierte Programmier-Einblicke aus Ihrem Chatverlauf generieren',

  // ============================================================================
  // Commands - Session History
  // ============================================================================
  'Resume a previous session': 'Eine vorherige Sitzung fortsetzen',
  'Fork the current conversation into a new session':
    'Die aktuelle Unterhaltung in eine neue Sitzung verzweigen',
  'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    'Während eine Antwort oder ein Tool-Aufruf läuft, kann keine Verzweigung erstellt werden. Warten Sie, bis der Vorgang abgeschlossen ist, oder bearbeiten Sie den ausstehenden Tool-Aufruf.',
  'No conversation to branch.': 'Keine Unterhaltung zum Verzweigen vorhanden.',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    'Einen Tool-Aufruf wiederherstellen. Dadurch werden Konversations- und Dateiverlauf auf den Zustand zurückgesetzt, in dem der Tool-Aufruf vorgeschlagen wurde',
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    'Terminal-Typ konnte nicht erkannt werden. Unterstützte Terminals: VS Code, Cursor, Windsurf und Trae.',
  'Terminal "{{terminal}}" is not supported yet.':
    'Terminal "{{terminal}}" wird noch nicht unterstützt.',

  // ============================================================================
  // Commands - Language
  // ============================================================================
  'Invalid language. Available: {{options}}':
    'Ungültige Sprache. Verfügbar: {{options}}',
  'Language subcommands do not accept additional arguments.':
    'Sprach-Unterbefehle akzeptieren keine zusätzlichen Argumente.',
  'Current UI language: {{lang}}': 'Aktuelle UI-Sprache: {{lang}}',
  'Current LLM output language: {{lang}}':
    'Aktuelle LLM-Ausgabesprache: {{lang}}',
  'Set UI language': 'UI-Sprache festlegen',
  'Set LLM output language': 'LLM-Ausgabesprache festlegen',
  'Usage: /language ui [{{options}}]': 'Verwendung: /language ui [{{options}}]',
  'Usage: /language output <language>':
    'Verwendung: /language output <Sprache>',
  'Example: /language output 中文': 'Beispiel: /language output Deutsch',
  'Example: /language output English': 'Beispiel: /language output Englisch',
  'Example: /language output 日本語': 'Beispiel: /language output Japanisch',
  'UI language changed to {{lang}}': 'UI-Sprache geändert zu {{lang}}',
  'LLM output language set to {{lang}}':
    'LLM-Ausgabesprache auf {{lang}} gesetzt',
  'Please restart the application for the changes to take effect.':
    'Bitte starten Sie die Anwendung neu, damit die Änderungen wirksam werden.',
  'Failed to generate LLM output language rule file: {{error}}':
    'Fehler beim Generieren der LLM-Ausgabesprach-Regeldatei: {{error}}',
  'Invalid command. Available subcommands:':
    'Ungültiger Befehl. Verfügbare Unterbefehle:',
  'Available subcommands:': 'Verfügbare Unterbefehle:',
  'To request additional UI language packs, please open an issue on GitHub.':
    'Um zusätzliche UI-Sprachpakete anzufordern, öffnen Sie bitte ein Issue auf GitHub.',
  'Available options:': 'Verfügbare Optionen:',
  'Set UI language to {{name}}': 'UI-Sprache auf {{name}} setzen',

  // ============================================================================
  // Commands - Approval Mode
  // ============================================================================
  'Tool Approval Mode': 'Werkzeug-Genehmigungsmodus',
  '{{mode}} mode': '{{mode}}-Modus',
  'Analyze only, do not modify files or execute commands':
    'Nur analysieren, keine Dateien ändern oder Befehle ausführen',
  'Require approval for file edits or shell commands':
    'Genehmigung für Dateibearbeitungen oder Shell-Befehle erforderlich',
  'Automatically approve file edits':
    'Dateibearbeitungen automatisch genehmigen',
  'Automatically approve all tools': 'Alle Werkzeuge automatisch genehmigen',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    'Arbeitsbereich-Genehmigungsmodus existiert und hat Vorrang. Benutzerebene-Änderung hat keine Wirkung.',
  'Apply To': 'Anwenden auf',
  'Workspace Settings': 'Arbeitsbereich-Einstellungen',
  'Open auto-memory folder': 'Auto-Speicher-Ordner öffnen',
  'Auto-memory: {{status}}': 'Auto-Speicher: {{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run':
    'Auto-Konsolidierung: {{status}} · {{lastDream}} · /dream zum Ausführen',
  never: 'nie',
  on: 'ein',
  off: 'aus',
  'Remove matching entries from managed auto-memory.':
    'Passende Einträge aus dem verwalteten Auto-Speicher entfernen.',
  'Usage: /forget <memory text to remove>':
    'Verwendung: /forget <zu entfernender Erinnerungstext>',
  'No managed auto-memory entries matched: {{query}}':
    'Keine verwalteten Auto-Speicher-Einträge gefunden: {{query}}',
  'Consolidate managed auto-memory topic files.':
    'Verwaltete Auto-Speicher-Themendateien konsolidieren.',
  'Could not retrieve tool registry.':
    'Werkzeugregister konnte nicht abgerufen werden.',
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "Erfolgreich authentifiziert und Werkzeuge für '{{name}}' aktualisiert.",
  "Re-discovering tools from '{{name}}'...":
    "Werkzeuge von '{{name}}' werden neu erkannt...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "{{count}} Werkzeug(e) von '{{name}}' entdeckt.",
  'Authentication complete. Returning to server details...':
    'Authentifizierung abgeschlossen. Zurück zu den Serverdetails...',
  'Authentication successful.': 'Authentifizierung erfolgreich.',
  // =========================================================
  // Commands - Summary
  // ============================================================================
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    'Projektzusammenfassung generieren und in .qwen/PROJECT_SUMMARY.md speichern',
  'No chat client available to generate summary.':
    'Kein Chat-Client verfügbar, um Zusammenfassung zu generieren.',
  'Already generating summary, wait for previous request to complete':
    'Zusammenfassung wird bereits generiert, warten Sie auf Abschluss der vorherigen Anfrage',
  'No conversation found to summarize.':
    'Kein Gespräch zum Zusammenfassen gefunden.',
  'Failed to generate project context summary: {{error}}':
    'Fehler beim Generieren der Projektkontextzusammenfassung: {{error}}',
  'Saved project summary to {{filePathForDisplay}}.':
    'Projektzusammenfassung gespeichert unter {{filePathForDisplay}}.',
  'Saving project summary...': 'Projektzusammenfassung wird gespeichert...',
  'Generating project summary...': 'Projektzusammenfassung wird generiert...',
  'Processing summary...': 'Projektzusammenfassung wird verarbeitet...',
  'Project summary generated and saved successfully!':
    'Projektzusammenfassung wurde erfolgreich erstellt und gespeichert!',
  'Saved to: {{filePath}}': 'Gespeichert unter: {{filePath}}',
  'Stopped because': 'Angehalten, weil',
  'Failed to generate summary - no text content received from LLM response':
    'Fehler beim Generieren der Zusammenfassung - kein Textinhalt von LLM-Antwort erhalten',

  // ============================================================================
  // Commands - Model
  // ============================================================================
  'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).':
    'Modell für diese Sitzung wechseln (--fast für Vorschlagsmodell)',
  'Set a lighter model for prompt suggestions and speculative execution':
    'Leichteres Modell für Eingabevorschläge und spekulative Ausführung festlegen',
  'Content generator configuration not available.':
    'Inhaltsgenerator-Konfiguration nicht verfügbar.',
  'Authentication type not available.':
    'Authentifizierungstyp nicht verfügbar.',
  'No models available for the current authentication type ({{authType}}).':
    'Keine Modelle für den aktuellen Authentifizierungstyp ({{authType}}) verfügbar.',
  // Needs translation
  ' (not in model registry)': ' (not in model registry)',

  // ============================================================================
  // Commands - Clear
  // ============================================================================
  'Starting a new session, resetting chat, and clearing terminal.':
    'Neue Sitzung wird gestartet, Chat wird zurückgesetzt und Terminal wird gelöscht.',
  'Starting a new session and clearing.':
    'Neue Sitzung wird gestartet und gelöscht.',

  // ============================================================================
  // Commands - Compress
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    'Komprimierung läuft bereits, warten Sie auf Abschluss der vorherigen Anfrage',
  'Failed to compress chat history.':
    'Fehler beim Komprimieren des Chatverlaufs.',
  'Failed to compress chat history: {{error}}':
    'Fehler beim Komprimieren des Chatverlaufs: {{error}}',
  'Compressing chat history': 'Chatverlauf wird komprimiert',
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    'Chatverlauf komprimiert von {{originalTokens}} auf {{newTokens}} Token.',
  'Compression was not beneficial for this history size.':
    'Komprimierung war für diese Verlaufsgröße nicht vorteilhaft.',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    'Chatverlauf-Komprimierung hat die Größe nicht reduziert. Dies kann auf Probleme mit dem Komprimierungs-Prompt hindeuten.',
  'Could not compress chat history due to a token counting error.':
    'Chatverlauf konnte aufgrund eines Token-Zählfehlers nicht komprimiert werden.',
  // ============================================================================
  // Commands - Directory
  // ============================================================================
  'Configuration is not available.': 'Konfiguration ist nicht verfügbar.',
  'Please provide at least one path to add.':
    'Bitte geben Sie mindestens einen Pfad zum Hinzufügen an.',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    'Der Befehl /directory add wird in restriktiven Sandbox-Profilen nicht unterstützt. Bitte verwenden Sie --include-directories beim Starten der Sitzung.',
  "Error adding '{{path}}': {{error}}":
    "Fehler beim Hinzufügen von '{{path}}': {{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    'QWEN.md-Dateien aus folgenden Verzeichnissen erfolgreich hinzugefügt, falls vorhanden:\n- {{directories}}',
  'Error refreshing memory: {{error}}':
    'Fehler beim Aktualisieren des Speichers: {{error}}',
  'Successfully added directories:\n- {{directories}}':
    'Verzeichnisse erfolgreich hinzugefügt:\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    'Aktuelle Arbeitsbereichsverzeichnisse:\n{{directories}}',

  // ============================================================================
  // Commands - Docs
  // ============================================================================
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    'Bitte öffnen Sie folgende URL in Ihrem Browser, um die Dokumentation anzusehen:\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    'Dokumentation wird in Ihrem Browser geöffnet: {{url}}',

  // ============================================================================
  // Dialogs - Tool Confirmation
  // ============================================================================
  'Do you want to proceed?': 'Möchten Sie fortfahren?',
  'Yes, allow once': 'Ja, einmal erlauben',
  'Allow always': 'Immer erlauben',
  Yes: 'Ja',
  No: 'Nein',
  'No (esc)': 'Nein (Esc)',
  // MCP Management Dialog (translations for MCP UI components)
  'Manage MCP servers': 'MCP servers verwalten',
  'Server Detail': 'Serverdetails',
  Tools: 'Werkzeuge',
  'Tool Detail': 'Werkzeugdetails',
  'Loading...': 'Lädt...',
  'Unknown step': 'Unbekannter Schritt',
  'Esc to back': 'Esc zurück',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ navigieren · Enter auswählen · Esc schließen',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ navigieren · Enter auswählen · Esc zurück',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ navigieren · Enter bestätigen · Esc zurück',
  'User Settings (global)': 'Benutzereinstellungen (global)',
  'Workspace Settings (project-specific)':
    'Arbeitsbereichseinstellungen (projektspezifisch)',
  'Disable server:': 'Server deaktivieren:',
  'Select where to add the server to the exclude list:':
    'Wählen Sie, wo der Server zur Ausschlussliste hinzugefügt werden soll:',
  'Press Enter to confirm, Esc to cancel':
    'Enter zum Bestätigen, Esc zum Abbrechen',
  Disable: 'Deaktivieren',
  Enable: 'Aktivieren',
  Authenticate: 'Authentifizieren',
  'Re-authenticate': 'Erneut authentifizieren',
  'Clear Authentication': 'Authentifizierung löschen',
  disabled: 'deaktiviert',
  enabled: 'aktiviert',
  'Server:': 'Server:',
  Reconnect: 'Neu verbinden',
  'View tools': 'Werkzeuge anzeigen',
  'Status:': 'Status:',
  'Command:': 'Befehl:',
  'Working Directory:': 'Arbeitsverzeichnis:',
  'No server selected': 'Kein Server ausgewählt',
  'Error:': 'Fehler:',
  tool: 'Werkzeug',
  tools: 'Werkzeuge',
  connected: 'verbunden',
  connecting: 'verbindet',
  disconnected: 'getrennt',
  error: 'Fehler',

  // MCP Server List
  'User MCPs': 'Benutzer-MCPs',
  'Project MCPs': 'Projekt-MCPs',
  'Extension MCPs': 'Erweiterungs-MCPs',
  server: 'Server',
  servers: 'Server',
  'Add MCP servers to your settings to get started.':
    'Fügen Sie MCP servers zu Ihren Einstellungen hinzu, um zu beginnen.',
  'Run qwen --debug to see error logs':
    'Führen Sie qwen --debug aus, um Fehlerprotokolle anzuzeigen',

  // MCP OAuth Authentication
  'OAuth Authentication': 'OAuth-Authentifizierung',
  'Authenticating... Please complete the login in your browser.':
    'Authentifizierung läuft... Bitte schließen Sie die Anmeldung in Ihrem Browser ab.',
  // MCP Tool List
  'No tools available for this server.':
    'Keine Werkzeuge für diesen Server verfügbar.',
  destructive: 'destruktiv',
  'read-only': 'schreibgeschützt',
  'open-world': 'offene Welt',
  idempotent: 'idempotent',
  'Tools for {{serverName}}': 'Werkzeuge für {{serverName}}',
  '{{current}}/{{total}}': '{{current}}/{{total}}',

  // MCP Tool Detail
  required: 'erforderlich',
  Parameters: 'Parameter',
  'No tool selected': 'Kein Werkzeug ausgewählt',
  Server: 'Server',

  // Invalid tool related translations
  '{{count}} invalid tools': '{{count}} ungültige Werkzeuge',
  invalid: 'ungültig',
  'invalid: {{reason}}': 'ungültig: {{reason}}',
  'missing name': 'Name fehlt',
  'missing description': 'Beschreibung fehlt',
  '(unnamed)': '(unbenannt)',
  'Warning: This tool cannot be called by the LLM':
    'Warnung: Dieses Werkzeug kann nicht vom LLM aufgerufen werden',
  Reason: 'Grund',
  'Tools must have both name and description to be used by the LLM.':
    'Werkzeuge müssen sowohl einen Namen als auch eine Beschreibung haben, um vom LLM verwendet zu werden.',
  'Modify in progress:': 'Änderung in Bearbeitung:',
  'Save and close external editor to continue':
    'Speichern und externen Editor schließen, um fortzufahren',
  'Apply this change?': 'Diese Änderung anwenden?',
  'Yes, allow always': 'Ja, immer erlauben',
  'Modify with external editor': 'Mit externem Editor bearbeiten',
  'No, suggest changes (esc)': 'Nein, Änderungen vorschlagen (Esc)',
  "Allow execution of: '{{command}}'?":
    "Ausführung erlauben von: '{{command}}'?",
  'Always allow in this project': 'In diesem Projekt immer erlauben',
  'Always allow {{action}} in this project':
    '{{action}} in diesem Projekt immer erlauben',
  'Always allow for this user': 'Für diesen Benutzer immer erlauben',
  'Always allow {{action}} for this user':
    '{{action}} für diesen Benutzer immer erlauben',
  'Yes, restore previous mode ({{mode}})':
    'Ja, vorherigen Modus wiederherstellen ({{mode}})',
  'Yes, and auto-accept edits': 'Ja, und Änderungen automatisch akzeptieren',
  'Yes, and manually approve edits': 'Ja, und Änderungen manuell genehmigen',
  'No, keep planning (esc)': 'Nein, weiter planen (Esc)',
  'URLs to fetch:': 'Abzurufende URLs:',
  'MCP Server: {{server}}': 'MCP Server: {{server}}',
  'Tool: {{tool}}': 'Werkzeug: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'Ausführung von MCP tool "{{tool}}" von MCP server "{{server}}" erlauben?',
  // ============================================================================
  // Dialogs - Shell Confirmation
  // ============================================================================
  'Shell Command Execution': 'Shell-Befehlsausführung',
  'A custom command wants to run the following shell commands:':
    'Ein benutzerdefinierter Befehl möchte folgende Shell-Befehle ausführen:',
  // ============================================================================
  // Dialogs - Welcome Back
  // ============================================================================
  'Current Plan:': 'Aktueller Plan:',
  'Progress: {{done}}/{{total}} tasks completed':
    'Fortschritt: {{done}}/{{total}} Aufgaben abgeschlossen',
  ', {{inProgress}} in progress': ', {{inProgress}} in Bearbeitung',
  'Pending Tasks:': 'Ausstehende Aufgaben:',
  'What would you like to do?': 'Was möchten Sie tun?',
  'Choose how to proceed with your session:':
    'Wählen Sie, wie Sie mit Ihrer Sitzung fortfahren möchten:',
  'Start new chat session': 'Neue Chat-Sitzung starten',
  'Continue previous conversation': 'Vorheriges Gespräch fortsetzen',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 Willkommen zurück! (Zuletzt aktualisiert: {{timeAgo}})',
  '🎯 Overall Goal:': '🎯 Gesamtziel:',
  'Select Authentication Method': 'Authentifizierungsmethode auswählen',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    'Sie müssen eine Authentifizierungsmethode wählen, um fortzufahren. Drücken Sie erneut Ctrl+C zum Beenden.',
  'Terms of Services and Privacy Notice':
    'Nutzungsbedingungen und Datenschutzhinweis',
  'Qwen OAuth': 'Qwen OAuth',
  'Discontinued — switch to Coding Plan or API Key':
    'Eingestellt — wechseln Sie zu Coding Plan oder API Key',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.':
    'Das kostenlose Qwen OAuth-Kontingent wurde am 2026-04-15 eingestellt. Bitte wählen Sie Coding Plan oder API Key.',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.':
    'Das kostenlose Qwen OAuth-Angebot wurde am 2026-04-15 eingestellt. Bitte wählen Sie ein Modell eines anderen Anbieter oder führen Sie /auth aus, um zu wechseln.',
  '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n':
    '\n⚠ Das kostenlose Qwen OAuth-Kontingent wurde am 2026-04-15 eingestellt. Bitte wählen Sie eine andere Option.\n',
  'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models':
    'Kostenpflichtig \u00B7 Bis zu 6.000 Anfragen/5 Std. \u00B7 Alle Alibaba Cloud Coding Plan Modelle',
  'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
  'Bring your own API key': 'Eigenen API Key verwenden',
  'Browser-based authentication with third-party providers (e.g. OpenRouter, ModelScope)':
    'Browserbasierte Authentifizierung mit externen Anbietern (z. B. OpenRouter, ModelScope)',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    'Authentifizierung ist auf {{enforcedType}} festgelegt, aber Sie verwenden derzeit {{currentType}}.',
  'Qwen OAuth Authentication': 'Qwen OAuth-Authentifizierung',
  'Please visit this URL to authorize:':
    'Bitte besuchen Sie diese URL zur Autorisierung:',
  'Waiting for authorization': 'Warten auf Autorisierung',
  'Time remaining:': 'Verbleibende Zeit:',
  'Qwen OAuth Authentication Timeout':
    'Qwen OAuth-Authentifizierung abgelaufen',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'OAuth-Token abgelaufen (über {{seconds}} Sekunden). Bitte wählen Sie erneut eine Authentifizierungsmethode.',
  'Press any key to return to authentication type selection.':
    'Drücken Sie eine beliebige Taste, um zur Authentifizierungstypauswahl zurückzukehren.',
  'Waiting for Qwen OAuth authentication...':
    'Warten auf Qwen OAuth-Authentifizierung...',
  'Authentication timed out. Please try again.':
    'Authentifizierung abgelaufen. Bitte versuchen Sie es erneut.',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    'Warten auf Authentifizierung... (ESC oder CTRL+C zum Abbrechen drücken)',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    'API Key für OpenAI-kompatible Authentifizierung fehlt. Setzen Sie settings.security.auth.apiKey oder die Umgebungsvariable {{envKeyHint}}.',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    'Umgebungsvariable {{envKeyHint}} wurde nicht gefunden. Bitte legen Sie sie in Ihrer .env-Datei oder den Systemumgebungsvariablen fest.',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    'Umgebungsvariable {{envKeyHint}} wurde nicht gefunden (oder setzen Sie settings.security.auth.apiKey). Bitte legen Sie sie in Ihrer .env-Datei oder den Systemumgebungsvariablen fest.',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    'API Key für OpenAI-kompatible Authentifizierung fehlt. Setzen Sie die Umgebungsvariable {{envKeyHint}}.',
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'Anthropic-Anbieter fehlt erforderliche baseUrl in modelProviders[].baseUrl.',
  'ANTHROPIC_BASE_URL environment variable not found.':
    'Umgebungsvariable ANTHROPIC_BASE_URL wurde nicht gefunden.',
  'Invalid auth method selected.':
    'Ungültige Authentifizierungsmethode ausgewählt.',
  'Failed to authenticate. Message: {{message}}':
    'Authentifizierung fehlgeschlagen. Meldung: {{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    'Erfolgreich mit {{authType}}-Anmeldedaten authentifiziert.',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    'Ungültiger QWEN_DEFAULT_AUTH_TYPE-Wert: "{{value}}". Gültige Werte sind: {{validValues}}',
  // ============================================================================
  // Dialogs - Model
  // ============================================================================
  'Select Model': 'Modell auswählen',
  'API Key': 'API Key',
  '(default)': '(Standard)',
  '(not set)': '(nicht gesetzt)',
  Modality: 'Modalität',
  'Context Window': 'Kontextfenster',
  text: 'Text',
  'text-only': 'nur Text',
  image: 'Bild',
  pdf: 'PDF',
  audio: 'Audio',
  video: 'Video',
  'not set': 'nicht gesetzt',
  none: 'keine',
  unknown: 'unbekannt',
  // ============================================================================
  // Dialogs - Permissions
  // ============================================================================
  'Manage folder trust settings': 'Ordnervertrauenseinstellungen verwalten',
  'Manage permission rules': 'permission rules verwalten',
  Allow: 'Erlauben',
  Ask: 'Fragen',
  Deny: 'Verweigern',
  Workspace: 'Arbeitsbereich',
  "Qwen Code won't ask before using allowed tools.":
    'Qwen Code fragt nicht, bevor erlaubte Tools verwendet werden.',
  'Qwen Code will ask before using these tools.':
    'Qwen Code fragt, bevor diese Tools verwendet werden.',
  'Qwen Code is not allowed to use denied tools.':
    'Qwen Code darf verweigerte Tools nicht verwenden.',
  'Manage trusted directories for this workspace.':
    'Vertrauenswürdige Verzeichnisse für diesen Arbeitsbereich verwalten.',
  'Any use of the {{tool}} tool': 'Jede Verwendung des {{tool}}-Tools',
  "{{tool}} commands matching '{{pattern}}'":
    "{{tool}}-Befehle, die '{{pattern}}' entsprechen",
  'From user settings': 'Aus Benutzereinstellungen',
  'From project settings': 'Aus Projekteinstellungen',
  'From session': 'Aus Sitzung',
  'Project settings': 'Projekteinstellungen',
  'Checked in at .qwen/settings.json': 'Eingecheckt in .qwen/settings.json',
  'User settings': 'Benutzereinstellungen',
  'Saved in at ~/.qwen/settings.json': 'Gespeichert in ~/.qwen/settings.json',
  'Add a new rule…': 'Neue Regel hinzufügen…',
  'Add {{type}} permission rule': '{{type}} permission rule hinzufügen',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    'permission rules sind ein Toolname, optional gefolgt von einem Bezeichner in Klammern.',
  'e.g.,': 'z.B.',
  or: 'oder',
  'Enter permission rule…': 'permission rule eingeben…',
  'Enter to submit · Esc to cancel': 'Enter zum Absenden · Esc zum Abbrechen',
  'Where should this rule be saved?': 'Wo soll diese Regel gespeichert werden?',
  'Enter to confirm · Esc to cancel':
    'Enter zum Bestätigen · Esc zum Abbrechen',
  'Delete {{type}} rule?': '{{type}}-Regel löschen?',
  'Are you sure you want to delete this permission rule?':
    'Sind Sie sicher, dass Sie diese permission rule löschen möchten?',
  'Permissions:': 'Berechtigungen:',
  '(←/→ or tab to cycle)': '(←/→ oder Tab zum Wechseln)',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    '↑↓ navigieren · Enter auswählen · Tippen suchen · Esc abbrechen',
  'Search…': 'Suche…',
  // Workspace directory management
  'Add directory…': 'Verzeichnis hinzufügen…',
  'Add directory to workspace': 'Verzeichnis zum Arbeitsbereich hinzufügen',
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    'Qwen Code kann Dateien im Arbeitsbereich lesen und Bearbeitungen vornehmen, wenn die automatische Akzeptierung aktiviert ist.',
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    'Qwen Code kann Dateien in diesem Verzeichnis lesen und Bearbeitungen vornehmen, wenn die automatische Akzeptierung aktiviert ist.',
  'Enter the path to the directory:': 'Pfad zum Verzeichnis eingeben:',
  'Enter directory path…': 'Verzeichnispfad eingeben…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab zum Vervollständigen · Enter zum Hinzufügen · Esc zum Abbrechen',
  'Remove directory?': 'Verzeichnis entfernen?',
  'Are you sure you want to remove this directory from the workspace?':
    'Möchten Sie dieses Verzeichnis wirklich aus dem Arbeitsbereich entfernen?',
  '  (Original working directory)': '  (Ursprüngliches Arbeitsverzeichnis)',
  '  (from settings)': '  (aus Einstellungen)',
  'Directory does not exist.': 'Verzeichnis existiert nicht.',
  'Path is not a directory.': 'Pfad ist kein Verzeichnis.',
  'This directory is already in the workspace.':
    'Dieses Verzeichnis ist bereits im Arbeitsbereich.',
  'Already covered by existing directory: {{dir}}':
    'Bereits durch vorhandenes Verzeichnis abgedeckt: {{dir}}',

  // ============================================================================
  // Status Bar
  // ============================================================================
  'Using:': 'Verwendet:',
  '{{count}} open file': '{{count}} geöffnete Datei',
  '{{count}} open files': '{{count}} geöffnete Dateien',
  '(ctrl+g to view)': '(Ctrl+G zum Anzeigen)',
  '{{count}} {{name}} file': '{{count}} {{name}}-Datei',
  '{{count}} {{name}} files': '{{count}} {{name}}-Dateien',
  '{{count}} MCP server': '{{count}} MCP server',
  '{{count}} MCP servers': '{{count}} MCP servers',
  '{{count}} Blocked': '{{count}} blockiert',
  '(ctrl+t to view)': '(Ctrl+T zum Anzeigen)',
  '(ctrl+t to toggle)': '(Ctrl+T zum Umschalten)',
  'Press Ctrl+C again to exit.': 'Drücken Sie erneut Ctrl+C zum Beenden.',
  'Press Ctrl+D again to exit.': 'Drücken Sie erneut Ctrl+D zum Beenden.',
  'Press Esc again to clear.': 'Drücken Sie erneut Esc zum Löschen.',
  'Press ↑ to edit queued messages':
    'Drücken Sie ↑, um Nachrichten in der Warteschlange zu bearbeiten',

  // ============================================================================
  // MCP Status
  // ============================================================================
  'No MCP servers configured.': 'Keine MCP servers konfiguriert.',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCP servers werden gestartet ({{count}} werden initialisiert)...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    'Hinweis: Der erste Start kann länger dauern. Werkzeugverfügbarkeit wird automatisch aktualisiert.',
  'Configured MCP servers:': 'Konfigurierte MCP servers:',
  Ready: 'Bereit',
  'Starting... (first startup may take longer)':
    'Wird gestartet... (erster Start kann länger dauern)',
  Disconnected: 'Getrennt',
  '{{count}} tool': '{{count}} Werkzeug',
  '{{count}} tools': '{{count}} Werkzeuge',
  '{{count}} prompt': '{{count}} Prompt',
  '{{count}} prompts': '{{count}} Prompts',
  '(from {{extensionName}})': '(von {{extensionName}})',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth abgelaufen',
  'OAuth not authenticated': 'OAuth nicht authentifiziert',
  'tools and prompts will appear when ready':
    'Werkzeuge und Prompts werden angezeigt, wenn bereit',
  '{{count}} tools cached': '{{count}} Werkzeuge zwischengespeichert',
  'Tools:': 'Werkzeuge:',
  'Parameters:': 'Parameter:',
  Blocked: 'Blockiert',
  '💡 Tips:': '💡 Tipps:',
  Use: 'Verwenden',
  'to show server and tool descriptions':
    'um Server- und Werkzeugbeschreibungen anzuzeigen',
  'to show tool parameter schemas': 'um tool parameter schemas anzuzeigen',
  'to hide descriptions': 'um Beschreibungen auszublenden',
  'to authenticate with OAuth-enabled servers':
    'um sich bei OAuth-fähigen Servern zu authentifizieren',
  Press: 'Drücken Sie',
  'to toggle tool descriptions on/off':
    'um Werkzeugbeschreibungen ein-/auszuschalten',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "OAuth-Authentifizierung für MCP server '{{name}}' wird gestartet...",
  // ============================================================================
  // Startup Tips
  // ============================================================================

  // ============================================================================
  // Exit Screen / Stats
  // ============================================================================
  'Agent powering down. Goodbye!':
    'Agent wird heruntergefahren. Auf Wiedersehen!',
  'To continue this session, run':
    'Um diese Sitzung fortzusetzen, führen Sie aus',
  'Interaction Summary': 'Interaktionszusammenfassung',
  'Session ID:': 'Sitzungs-ID:',
  'Tool Calls:': 'Werkzeugaufrufe:',
  'Success Rate:': 'Erfolgsrate:',
  'User Agreement:': 'Benutzerzustimmung:',
  reviewed: 'überprüft',
  'Code Changes:': 'Codeänderungen:',
  Performance: 'Leistung',
  'Wall Time:': 'Gesamtzeit:',
  'Agent Active:': 'Agent aktiv:',
  'API Time:': 'API-Zeit:',
  'Tool Time:': 'Werkzeugzeit:',
  'Session Stats': 'Sitzungsstatistiken',
  'Model Usage': 'Modellnutzung',
  Reqs: 'Anfragen',
  'Input Tokens': 'Eingabe-Token',
  'Output Tokens': 'Ausgabe-Token',
  'Savings Highlight:': 'Einsparungen:',
  'of input tokens were served from the cache, reducing costs.':
    'der Eingabe-Token wurden aus dem Cache bedient, was die Kosten reduziert.',
  'Tip: For a full token breakdown, run `/stats model`.':
    'Tipp: Für eine vollständige Token-Aufschlüsselung führen Sie `/stats model` aus.',
  'Model Stats For Nerds': 'Modellstatistiken für Nerds',
  'Tool Stats For Nerds': 'Werkzeugstatistiken für Nerds',
  Metric: 'Metrik',
  API: 'API',
  Requests: 'Anfragen',
  Errors: 'Fehler',
  'Avg Latency': 'Durchschn. Latenz',
  Tokens: 'Token',
  Total: 'Gesamt',
  Cached: 'Zwischengespeichert',
  Thoughts: 'Gedanken',
  Output: 'Ausgabe',
  'No API calls have been made in this session.':
    'In dieser Sitzung wurden keine API-Aufrufe gemacht.',
  'Tool Name': 'Werkzeugname',
  Calls: 'Aufrufe',
  'Success Rate': 'Erfolgsrate',
  'Avg Duration': 'Durchschn. Dauer',
  'User Decision Summary': 'Benutzerentscheidungs-Zusammenfassung',
  'Total Reviewed Suggestions:': 'Insgesamt überprüfter Vorschläge:',
  ' » Accepted:': ' » Akzeptiert:',
  ' » Rejected:': ' » Abgelehnt:',
  ' » Modified:': ' » Geändert:',
  ' Overall Agreement Rate:': ' Gesamtzustimmungsrate:',
  'No tool calls have been made in this session.':
    'In dieser Sitzung wurden keine Werkzeugaufrufe gemacht.',
  'Session start time is unavailable, cannot calculate stats.':
    'Sitzungsstartzeit nicht verfügbar, Statistiken können nicht berechnet werden.',

  // ============================================================================
  // Command Format Migration
  // ============================================================================
  'Command Format Migration': 'Befehlsformat-Migration',
  'Found {{count}} TOML command file:': '{{count}} TOML-Befehlsdatei gefunden:',
  'Found {{count}} TOML command files:':
    '{{count}} TOML-Befehlsdateien gefunden:',
  'Current tasks': 'Aktuelle Aufgaben',
  '... and {{count}} more': '... und {{count}} weitere',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'Das TOML-Format ist veraltet. Möchten Sie sie ins Markdown-Format migrieren?',
  '(Backups will be created and original files will be preserved)':
    '(Backups werden erstellt und Originaldateien werden beibehalten)',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...': 'Warten auf Benutzerbestätigung...',
  // ============================================================================
  // Loading Phrases
  // ============================================================================
  WITTY_LOADING_PHRASES: [
    'Auf gut Glück!',
    'Genialität wird ausgeliefert...',
    'Die Serifen werden aufgemalt...',
    'Durch den Schleimpilz navigieren...',
    'Die digitalen Geister werden befragt...',
    'Splines werden retikuliert...',
    'Die KI-Hamster werden aufgewärmt...',
    'Die Zaubermuschel wird befragt...',
    'Witzige Erwiderung wird generiert...',
    'Die Algorithmen werden poliert...',
    'Perfektion braucht Zeit (mein Code auch)...',
    'Frische Bytes werden gebrüht...',
    'Elektronen werden gezählt...',
    'Kognitive Prozessoren werden aktiviert...',
    'Auf Syntaxfehler im Universum wird geprüft...',
    'Einen Moment, Humor wird optimiert...',
    'Pointen werden gemischt...',
    'Neuronale Netze werden entwirrt...',
    'Brillanz wird kompiliert...',
    'wit.exe wird geladen...',
    'Die Wolke der Weisheit wird beschworen...',
    'Eine witzige Antwort wird vorbereitet...',
    'Einen Moment, ich debugge die Realität...',
    'Die Optionen werden verwirrt...',
    'Kosmische Frequenzen werden eingestellt...',
    'Eine Antwort wird erstellt, die Ihrer Geduld würdig ist...',
    'Die Einsen und Nullen werden kompiliert...',
    'Abhängigkeiten werden aufgelöst... und existenzielle Krisen...',
    'Erinnerungen werden defragmentiert... sowohl RAM als auch persönliche...',
    'Das Humor-Modul wird neu gestartet...',
    'Das Wesentliche wird zwischengespeichert (hauptsächlich Katzen-Memes)...',
    'Für lächerliche Geschwindigkeit wird optimiert',
    'Bits werden getauscht... sagen Sie es nicht den Bytes...',
    'Garbage Collection läuft... bin gleich zurück...',
    'Das Internet wird zusammengebaut...',
    'Kaffee wird in Code umgewandelt...',
    'Die Syntax der Realität wird aktualisiert...',
    'Die Synapsen werden neu verdrahtet...',
    'Ein verlegtes Semikolon wird gesucht...',
    'Die Zahnräder werden geschmiert...',
    'Die Server werden vorgeheizt...',
    'Der Fluxkompensator wird kalibriert...',
    'Der Unwahrscheinlichkeitsantrieb wird aktiviert...',
    'Die Macht wird kanalisiert...',
    'Die Sterne werden für optimale Antwort ausgerichtet...',
    'So sagen wir alle...',
    'Die nächste große Idee wird geladen...',
    'Einen Moment, ich bin in der Zone...',
    'Bereite mich vor, Sie mit Brillanz zu blenden...',
    'Einen Augenblick, ich poliere meinen Witz...',
    'Halten Sie durch, ich erschaffe ein Meisterwerk...',
    'Einen Moment, ich debugge das Universum...',
    'Einen Moment, ich richte die Pixel aus...',
    'Einen Moment, ich optimiere den Humor...',
    'Einen Moment, ich tune die Algorithmen...',
    'Warp-Geschwindigkeit aktiviert...',
    'Mehr Dilithium-Kristalle werden gesucht...',
    'Keine Panik...',
    'Dem weißen Kaninchen wird gefolgt...',
    'Die Wahrheit ist hier drin... irgendwo...',
    'Auf die Kassette wird gepustet...',
    'Ladevorgang... Machen Sie eine Fassrolle!',
    'Auf den Respawn wird gewartet...',
    'Der Kessel-Flug wird in weniger als 12 Parsec beendet...',
    'Der Kuchen ist keine Lüge, er lädt nur noch...',
    'Am Charaktererstellungsbildschirm wird herumgefummelt...',
    'Einen Moment, ich suche das richtige Meme...',
    "'A' wird zum Fortfahren gedrückt...",
    'Digitale Katzen werden gehütet...',
    'Die Pixel werden poliert...',
    'Ein passender Ladebildschirm-Witz wird gesucht...',
    'Ich lenke Sie mit diesem witzigen Spruch ab...',
    'Fast da... wahrscheinlich...',
    'Unsere Hamster arbeiten so schnell sie können...',
    'Cloudy wird am Kopf gestreichelt...',
    'Die Katze wird gestreichelt...',
    'Meinen Chef rickrollen...',
    'Never gonna give you up, never gonna let you down...',
    'Auf den Bass wird geschlagen...',
    'Die Schnozbeeren werden probiert...',
    "I'm going the distance, I'm going for speed...",
    'Ist dies das wahre Leben? Ist dies nur Fantasie?...',
    'Ich habe ein gutes Gefühl dabei...',
    'Den Bären wird gestupst...',
    'Recherche zu den neuesten Memes...',
    'Überlege, wie ich das witziger machen kann...',
    'Hmmm... lassen Sie mich nachdenken...',
    'Wie nennt man einen Fisch ohne Augen? Ein Fsh...',
    'Warum ging der Computer zur Therapie? Er hatte zu viele Bytes...',
    'Warum mögen Programmierer keine Natur? Sie hat zu viele Bugs...',
    'Warum bevorzugen Programmierer den Dunkelmodus? Weil Licht Bugs anzieht...',
    'Warum ging der Entwickler pleite? Er hat seinen ganzen Cache aufgebraucht...',
    'Was kann man mit einem kaputten Bleistift machen? Nichts, er ist sinnlos...',
    'Perkussive Wartung wird angewendet...',
    'Die richtige USB-Ausrichtung wird gesucht...',
    'Es wird sichergestellt, dass der magische Rauch in den Kabeln bleibt...',
    'Versuche Vim zu beenden...',
    'Das Hamsterrad wird angeworfen...',
    'Das ist kein Bug, das ist ein undokumentiertes Feature...',
    'Engage.',
    'Ich komme wieder... mit einer Antwort.',
    'Mein anderer Prozess ist eine TARDIS...',
    'Mit dem Maschinengeist wird kommuniziert...',
    'Die Gedanken marinieren lassen...',
    'Gerade erinnert, wo ich meine Schlüssel hingelegt habe...',
    'Über die Kugel wird nachgedacht...',
    'Ich habe Dinge gesehen, die Sie nicht glauben würden... wie einen Benutzer, der Lademeldungen liest.',
    'Nachdenklicher Blick wird initiiert...',
    'Was ist der Lieblingssnack eines Computers? Mikrochips.',
    'Warum tragen Java-Entwickler Brillen? Weil sie nicht C#.',
    'Der Laser wird aufgeladen... pew pew!',
    'Durch Null wird geteilt... nur Spaß!',
    'Suche nach einem erwachsenen Aufseh... ich meine, Verarbeitung.',
    'Es piept und boopt.',
    'Pufferung... weil auch KIs einen Moment brauchen.',
    'Quantenteilchen werden für schnellere Antwort verschränkt...',
    'Das Chrom wird poliert... an den Algorithmen.',
    'Sind Sie nicht unterhalten? (Arbeite daran!)',
    'Die Code-Gremlins werden beschworen... zum Helfen, natürlich.',
    'Warte nur auf das Einwahlton-Ende...',
    'Das Humor-O-Meter wird neu kalibriert.',
    'Mein anderer Ladebildschirm ist noch lustiger.',
    'Ziemlich sicher, dass irgendwo eine Katze über die Tastatur läuft...',
    'Verbessern... Verbessern... Lädt noch.',
    'Das ist kein Bug, das ist ein Feature... dieses Ladebildschirms.',
    'Haben Sie versucht, es aus- und wieder einzuschalten? (Den Ladebildschirm, nicht mich.)',
    'Zusätzliche Pylonen werden gebaut...',
  ],

  // ============================================================================
  // Extension Settings Input
  // ============================================================================
  'Enter value...': 'Wert eingeben...',
  'Enter sensitive value...': 'Sensiblen Wert eingeben...',
  'Press Enter to submit, Escape to cancel':
    'Enter zum Absenden, Escape zum Abbrechen drücken',

  // ============================================================================
  // Command Migration Tool
  // ============================================================================
  'Markdown file already exists: {{filename}}':
    'Markdown-Datei existiert bereits: {{filename}}',
  'TOML Command Format Deprecation Notice':
    'TOML-Befehlsformat Veraltet-Hinweis',
  'Found {{count}} command file(s) in TOML format:':
    '{{count}} Befehlsdatei(en) im TOML-Format gefunden:',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    'Das TOML-Format für Befehle wird zugunsten des Markdown-Formats eingestellt.',
  'Markdown format is more readable and easier to edit.':
    'Das Markdown-Format ist lesbarer und einfacher zu bearbeiten.',
  'You can migrate these files automatically using:':
    'Sie können diese Dateien automatisch migrieren mit:',
  'Or manually convert each file:': 'Oder jede Datei manuell konvertieren:',
  'TOML: prompt = "..." / description = "..."':
    'TOML: prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content': 'Markdown: YAML-Frontmatter + Inhalt',
  'The migration tool will:': 'Das Migrationstool wird:',
  'Convert TOML files to Markdown': 'TOML-Dateien in Markdown konvertieren',
  'Create backups of original files':
    'Sicherungen der Originaldateien erstellen',
  'Preserve all command functionality': 'Alle Befehlsfunktionen beibehalten',
  'TOML format will continue to work for now, but migration is recommended.':
    'Das TOML-Format funktioniert vorerst weiter, aber eine Migration wird empfohlen.',

  // ============================================================================
  // Extensions - Explore Command
  // ============================================================================
  'Open extensions page in your browser': 'Erweiterungsseite im Browser öffnen',
  'Unknown extensions source: {{source}}.':
    'Unbekannte Erweiterungsquelle: {{source}}.',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    'Würde Erweiterungsseite im Browser öffnen: {{url}} (übersprungen in Testumgebung)',
  'View available extensions at {{url}}':
    'Verfügbare Erweiterungen ansehen unter {{url}}',
  'Opening extensions page in your browser: {{url}}':
    'Erweiterungsseite wird im Browser geöffnet: {{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    'Browser konnte nicht geöffnet werden. Besuchen Sie die Erweiterungsgalerie unter {{url}}',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    'Verwenden Sie /compress, wenn die Unterhaltung lang wird, um den Verlauf zusammenzufassen und Kontext freizugeben.',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    'Starten Sie eine neue Idee mit /clear oder /new; die vorherige Sitzung bleibt im Verlauf verfügbar.',
  'Use /bug to submit issues to the maintainers when something goes off.':
    'Verwenden Sie /bug, um Probleme an die Betreuer zu melden, wenn etwas schiefgeht.',
  'Switch auth type quickly with /auth.':
    'Wechseln Sie den Authentifizierungstyp schnell mit /auth.',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    'Sie können beliebige Shell-Befehle in Qwen Code mit ! ausführen (z. B. !ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    'Geben Sie / ein, um das Befehlsmenü zu öffnen; Tab vervollständigt Slash-Befehle und gespeicherte Prompts.',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    'Sie können eine frühere Unterhaltung mit qwen --continue oder qwen --resume fortsetzen.',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'Sie können den Berechtigungsmodus schnell mit Shift+Tab oder /approval-mode wechseln.',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    'Sie können den Berechtigungsmodus schnell mit Tab oder /approval-mode wechseln.',
  'Try /insight to generate personalized insights from your chat history.':
    'Probieren Sie /insight, um personalisierte Erkenntnisse aus Ihrem Chatverlauf zu erstellen.',
  'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.':
    'Ctrl+O drücken, um den Kompaktmodus umzuschalten — Tool-Ausgabe und Denkprozess ausblenden.',
  'Add a QWEN.md file to give Qwen Code persistent project context.':
    'Fügen Sie eine QWEN.md-Datei hinzu, um Qwen Code dauerhaften Projektkontext zu geben.',
  'Use /btw to ask a quick side question without disrupting the conversation.':
    'Verwenden Sie /btw, um eine kurze Nebenfrage zu stellen, ohne die Unterhaltung zu unterbrechen.',
  'Context is almost full! Run /compress now or start /new to continue.':
    'Der Kontext ist fast voll! Führen Sie jetzt /compress aus oder starten Sie /new, um fortzufahren.',
  'Context is getting full. Use /compress to free up space.':
    'Der Kontext füllt sich. Verwenden Sie /compress, um Platz freizugeben.',
  'Long conversation? /compress summarizes history to free context.':
    'Lange Unterhaltung? /compress fasst den Verlauf zusammen, um Kontext freizugeben.',

  // ============================================================================
  // Custom API Key Configuration
  // ============================================================================
  'You can configure your API key and models in settings.json':
    'Sie können Ihren API Key und Modelle in settings.json konfigurieren',
  'Refer to the documentation for setup instructions':
    'Einrichtungsanweisungen finden Sie in der Dokumentation',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'API key cannot be empty.': 'API Key darf nicht leer sein.',
  'You can get your Coding Plan API key here':
    'Sie können Ihren Coding Plan API Key hier erhalten',
  'Failed to update Coding Plan configuration: {{message}}':
    'Fehler beim Aktualisieren der Coding Plan-Konfiguration: {{message}}',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  Custom: 'Benutzerdefiniert',
  'Select Region for Coding Plan': 'Region für Coding Plan auswählen',
  'Choose based on where your account is registered':
    'Wählen Sie basierend auf dem Registrierungsort Ihres Kontos',
  'Enter Coding Plan API Key': 'Coding Plan API Key eingeben',

  // ============================================================================
  // Coding Plan International Updates
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    'Neue Modellkonfigurationen sind für {{region}} verfügbar. Jetzt aktualisieren?',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    '{{region}}-Konfiguration erfolgreich aktualisiert. Modell auf "{{model}}" umgeschaltet.',
  // ============================================================================
  // Context Usage Component
  // ============================================================================
  'Context Usage': 'Kontextnutzung',
  '% used': '% verwendet',
  '% context used': '% Kontext verwendet',
  'Context exceeds limit! Use /compress or /clear to reduce.':
    'Kontext überschreitet Limit! Verwenden Sie /compress oder /clear zum Reduzieren.',
  'No API response yet. Send a message to see actual usage.':
    'Noch keine API-Antwort. Senden Sie eine Nachricht, um die tatsächliche Nutzung anzuzeigen.',
  'Estimated pre-conversation overhead':
    'Geschätzte Vorabkosten vor der Unterhaltung',
  'Context window': 'Kontextfenster',
  tokens: 'Tokens',
  Used: 'Verwendet',
  Free: 'Frei',
  'Autocompact buffer': 'Autokomprimierungs-Puffer',
  'Usage by category': 'Verwendung nach Kategorie',
  'System prompt': 'System-Prompt',
  'Built-in tools': 'Integrierte Tools',
  'MCP tools': 'MCP tools',
  'Memory files': 'Speicherdateien',
  Skills: 'Fähigkeiten',
  Messages: 'Nachrichten',
  'Run /context detail for per-item breakdown.':
    'Führen Sie /context detail für eine Aufschlüsselung nach Elementen aus.',
  active: 'aktiv',
  'body loaded': 'Inhalt geladen',
  memory: 'Speicher',
  '{{region}} configuration updated successfully.':
    '{{region}}-Konfiguration erfolgreich aktualisiert.',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    'Erfolgreich mit {{region}} authentifiziert. API Key und Modellkonfigurationen wurden in settings.json gespeichert.',
  'Tip: Use /model to switch between available Coding Plan models.':
    'Tipp: Verwenden Sie /model, um zwischen verfügbaren Coding Plan-Modellen zu wechseln.',
  'Type something...': 'Etwas eingeben...',
  Submit: 'Senden',
  'Submit answers': 'Antworten senden',
  Cancel: 'Abbrechen',
  'Your answers:': 'Ihre Antworten:',
  '(not answered)': '(nicht beantwortet)',
  'Ready to submit your answers?': 'Bereit, Ihre Antworten zu senden?',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓: Navigieren | ←/→: Tabs wechseln | Enter: Auswählen',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓: Navigieren | Enter: Auswählen | Esc: Abbrechen',
  'Authenticate using Qwen OAuth': 'Mit Qwen OAuth authentifizieren',
  'Authenticate using Alibaba Cloud Coding Plan':
    'Mit Alibaba Cloud Coding Plan authentifizieren',
  'Region for Coding Plan (china/global)':
    'Region für Coding Plan (china/global)',
  'API key for Coding Plan': 'API Key für Coding Plan',
  'Show current authentication status':
    'Aktuellen Authentifizierungsstatus anzeigen',
  'Authentication completed successfully.':
    'Authentifizierung erfolgreich abgeschlossen.',
  'Starting Qwen OAuth authentication...':
    'Qwen OAuth-Authentifizierung wird gestartet...',
  'Successfully authenticated with Qwen OAuth.':
    'Erfolgreich mit Qwen OAuth authentifiziert.',
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'Authentifizierung mit Qwen OAuth fehlgeschlagen: {{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    'Alibaba Cloud Coding Plan-Authentifizierung wird verarbeitet...',
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    'Erfolgreich mit Alibaba Cloud Coding Plan authentifiziert.',
  'Failed to authenticate with Coding Plan: {{error}}':
    'Authentifizierung mit Coding Plan fehlgeschlagen: {{error}}',
  '阿里云百炼 (aliyun.com)': '阿里云百炼 (aliyun.com)',
  Global: 'Global',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': 'Region für Coding Plan auswählen:',
  'Enter your Coding Plan API key: ':
    'Geben Sie Ihren Coding Plan API Key ein: ',
  'Select authentication method:': 'Authentifizierungsmethode auswählen:',
  '\n=== Authentication Status ===\n': '\n=== Authentifizierungsstatus ===\n',
  '⚠️  No authentication method configured.\n':
    '⚠️  Keine Authentifizierungsmethode konfiguriert.\n',
  'Run one of the following commands to get started:\n':
    'Führen Sie einen der folgenden Befehle aus, um zu beginnen:\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)':
    '  qwen auth qwen-oauth     - Mit Qwen OAuth authentifizieren (eingestellt)',
  'Or simply run:': 'Oder einfach ausführen:',
  '  qwen auth                - Interactive authentication setup\n':
    '  qwen auth                - Interaktive Authentifizierungseinrichtung\n',
  '✓ Authentication Method: Qwen OAuth':
    '✓ Authentifizierungsmethode: Qwen OAuth',
  '  Type: Free tier (discontinued 2026-04-15)':
    '  Typ: Kostenloses Kontingent (eingestellt 2026-04-15)',
  '  Limit: No longer available': '  Limit: Nicht mehr verfügbar',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.':
    'Das kostenlose Qwen OAuth-Kontingent wurde am 2026-04-15 eingestellt. Führen Sie /auth aus, um zu Coding Plan, OpenRouter, Fireworks AI oder einem anderen Anbieter zu wechseln.',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    '✓ Authentifizierungsmethode: Alibaba Cloud Coding Plan',
  'Global - Alibaba Cloud': 'Global - Alibaba Cloud',
  '  Region: {{region}}': '  Region: {{region}}',
  '  Current Model: {{model}}': '  Aktuelles Modell: {{model}}',
  '  Config Version: {{version}}': '  Konfigurationsversion: {{version}}',
  '  Status: API key configured\n': '  Status: API Key konfiguriert\n',
  '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    '⚠️  Authentifizierungsmethode: Alibaba Cloud Coding Plan (Unvollständig)',
  '  Issue: API key not found in environment or settings\n':
    '  Problem: API Key nicht in Umgebung oder Einstellungen gefunden\n',
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  Führen Sie `qwen auth coding-plan` aus, um neu zu konfigurieren.\n',
  '✓ Authentication Method: {{type}}': '✓ Authentifizierungsmethode: {{type}}',
  '  Status: Configured\n': '  Status: Konfiguriert\n',
  'Failed to check authentication status: {{error}}':
    'Authentifizierungsstatus konnte nicht überprüft werden: {{error}}',
  'Select an option:': 'Option auswählen:',
  'Raw mode not available. Please run in an interactive terminal.':
    'Raw-Modus nicht verfügbar. Bitte in einem interaktiven Terminal ausführen.',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(↑ ↓ Pfeiltasten zum Navigieren, Enter zum Auswählen, Ctrl+C zum Beenden)\n',
  'to toggle compact mode': 'Kompaktmodus umschalten',
  'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).':
    'Tool-Ausgabe und Denkprozess ausblenden für eine übersichtlichere Ansicht (mit Ctrl+O umschalten).',
  'Press Ctrl+O to show full tool output':
    'Ctrl+O für vollständige Tool-Ausgabe drücken',
  'Switch to plan mode or exit plan mode':
    'In den Plan-Modus wechseln oder den Plan-Modus verlassen',
  'Exited plan mode. Previous approval mode restored.':
    'Plan-Modus verlassen. Vorheriger Genehmigungsmodus wiederhergestellt.',
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    'Plan-Modus aktiviert. Der Agent analysiert und plant, ohne Werkzeuge auszuführen.',
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    'Bereits im Plan-Modus. Verwenden Sie "/plan exit", um den Plan-Modus zu verlassen.',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    'Nicht im Plan-Modus. Verwenden Sie "/plan", um zuerst in den Plan-Modus zu gelangen.',
  "Set up Qwen Code's status line UI": 'Qwen Codes Statusleisten-UI einrichten',

  // === Core: added from PR #3328 ===
  'Open the memory manager.': 'Den Speicher-Manager öffnen.',
  'Save a durable memory to the memory system.':
    'Eine dauerhafte Erinnerung im Speichersystem speichern.',
  'Open MCP management dialog': 'MCP-Verwaltungsdialog öffnen',
  'Manage extension settings': 'Erweiterungseinstellungen verwalten',
  prompts: 'Eingabeaufforderungen',
  'Manage dynamic translation cache': 'Dynamischen Übersetzungscache verwalten',
  'Manage Extensions': 'Erweiterungen verwalten',
  'Extension Details': 'Erweiterungsdetails',
  'View Extension': 'Erweiterung anzeigen',
  'Update Extension': 'Erweiterung aktualisieren',
  'Disable Extension': 'Erweiterung deaktivieren',
  'Enable Extension': 'Erweiterung aktivieren',
  'Uninstall Extension': 'Erweiterung deinstallieren',
  'Select Scope': 'Bereich auswählen',
  'User Scope': 'Benutzerbereich',
  'Workspace Scope': 'Arbeitsbereich',
  'No extensions found.': 'Keine Erweiterungen gefunden.',
  'Toggle this help display': 'Diese Hilfe ein- oder ausblenden',
  'Toggle shell mode': 'Shell-Modus umschalten',
  'Open command menu': 'Befehlsmenü öffnen',
  'Add file context': 'Dateikontext hinzufügen',
  'Accept suggestion / Autocomplete':
    'Vorschlag akzeptieren / automatisch vervollständigen',
  'Reverse search history': 'Verlauf rückwärts durchsuchen',
  'Press ? again to close': 'Erneut ? drücken, um zu schließen',
  '? for shortcuts': '? für Tastenkürzel',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    'Ungültiger Freigabemodus "{{arg}}". Gültige Modi: {{modes}}',
  'Approval mode set to "{{mode}}"': 'Freigabemodus auf "{{mode}}" gesetzt',
  'Are you sure you want to uninstall extension "{{name}}"?':
    'Sind Sie sicher, dass Sie die Erweiterung "{{name}}" deinstallieren möchten?',
  'This action cannot be undone.':
    'Diese Aktion kann nicht rückgängig gemacht werden.',
  'Extension "{{name}}" updated successfully.':
    'Erweiterung "{{name}}" erfolgreich aktualisiert.',
  'Name:': 'Name:',
  'MCP Servers:': 'MCP Servers:',
  'Settings:': 'Einstellungen:',
  'View Details': 'Details anzeigen',
  'Update failed:': 'Aktualisierung fehlgeschlagen:',
  'Updating {{name}}...': '{{name}} wird aktualisiert...',
  'Update complete!': 'Aktualisierung abgeschlossen!',
  'User (global)': 'Benutzer (global)',
  'Workspace (project-specific)': 'Arbeitsbereich (projektspezifisch)',
  'Disable "{{name}}" - Select Scope':
    '"{{name}}" deaktivieren - Bereich auswählen',
  'Enable "{{name}}" - Select Scope':
    '"{{name}}" aktivieren - Bereich auswählen',
  'No extension selected': 'Keine Erweiterung ausgewählt',
  '{{count}} extensions installed': '{{count}} Erweiterungen installiert',
  'up to date': 'aktuell',
  'update available': 'Update verfügbar',
  'checking...': 'wird geprüft...',
  'not updatable': 'nicht aktualisierbar',
  'Re-translate currently loaded dynamic slash descriptions for the current UI language':
    'Derzeit geladene dynamische Slash-Befehlsbeschreibungen für die aktuelle UI-Sprache neu übersetzen',
  'Clear cached translations for the current UI language':
    'Cache-Übersetzungen für die aktuelle UI-Sprache löschen',
  'Manage AI translation for dynamic slash command descriptions':
    'KI-Übersetzung für dynamische Slash-Befehlsbeschreibungen verwalten',
  'Enable AI translation for dynamic slash command descriptions':
    'KI-Übersetzung für dynamische Slash-Befehlsbeschreibungen aktivieren',
  'Disable AI translation for dynamic slash command descriptions':
    'KI-Übersetzung für dynamische Slash-Befehlsbeschreibungen deaktivieren',
  'Show AI translation status for dynamic slash command descriptions':
    'KI-Übersetzungsstatus für dynamische Slash-Befehlsbeschreibungen anzeigen',
  'AI translation for dynamic slash command descriptions is {{status}}.':
    'KI-Übersetzung für dynamische Slash-Befehlsbeschreibungen ist {{status}}.',
  'AI translation for dynamic slash command descriptions is now enabled.':
    'KI-Übersetzung für dynamische Slash-Befehlsbeschreibungen ist jetzt aktiviert.',
  'AI translation for dynamic slash command descriptions is now disabled.':
    'KI-Übersetzung für dynamische Slash-Befehlsbeschreibungen ist jetzt deaktiviert.',
  'Ask a quick side question without affecting the main conversation':
    'Eine kurze Nebenfrage stellen, ohne die Hauptunterhaltung zu beeinflussen',
  'Manage Arena sessions': 'Arena-Sitzungen verwalten',
  'Start an Arena session with multiple models competing on the same task':
    'Eine Arena-Sitzung starten, in der mehrere Modelle dieselbe Aufgabe bearbeiten',
  'Stop the current Arena session': 'Die aktuelle Arena-Sitzung beenden',
  'Show the current Arena session status':
    'Den Status der aktuellen Arena-Sitzung anzeigen',
  'Select a model result and merge its diff into the current workspace':
    'Ein Modellergebnis auswählen und dessen Diff in den aktuellen Arbeitsbereich übernehmen',
  'No running Arena session found.': 'Keine laufende Arena-Sitzung gefunden.',
  'No Arena session found. Start one with /arena start.':
    'Keine Arena-Sitzung gefunden. Starten Sie eine mit /arena start.',
  'Arena session is still running. Wait for it to complete or use /arena stop first.':
    'Die Arena-Sitzung läuft noch. Warten Sie, bis sie abgeschlossen ist, oder verwenden Sie zuerst /arena stop.',
  'No successful agent results to select from. All agents failed or were cancelled.':
    'Keine erfolgreichen Agent-Ergebnisse zur Auswahl. Alle Agents sind fehlgeschlagen oder wurden abgebrochen.',
  'Use /arena stop to end the session.':
    'Verwenden Sie /arena stop, um die Sitzung zu beenden.',
  'No idle agent found matching "{{name}}".':
    'Kein inaktiver Agent gefunden, der "{{name}}" entspricht.',
  'Failed to apply changes from {{label}}: {{error}}':
    'Anwenden der Änderungen von {{label}} fehlgeschlagen: {{error}}',
  'Applied changes from {{label}} to workspace. Arena session complete.':
    'Änderungen von {{label}} auf den Arbeitsbereich angewendet. Arena-Sitzung abgeschlossen.',
  'Discard all Arena results and clean up worktrees?':
    'Alle Arena-Ergebnisse verwerfen und Arbeitsbäume bereinigen?',
  'Arena results discarded. All worktrees cleaned up.':
    'Arena-Ergebnisse verworfen. Alle Arbeitsbäume wurden bereinigt.',
  'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.':
    'Arena wird im nicht-interaktiven Modus nicht unterstützt. Verwenden Sie den interaktiven Modus, um eine Arena-Sitzung zu starten.',
  'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.':
    'Arena wird im nicht-interaktiven Modus nicht unterstützt. Verwenden Sie den interaktiven Modus, um eine Arena-Sitzung zu beenden.',
  'Arena is not supported in non-interactive mode.':
    'Arena wird im nicht-interaktiven Modus nicht unterstützt.',
  'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.':
    'Es existiert bereits eine Arena-Sitzung. Verwenden Sie /arena stop oder /arena select, um sie zu beenden, bevor Sie eine neue starten.',
  'Usage: /arena start --models model1,model2 <task>':
    'Verwendung: /arena start --models model1,model2 <Aufgabe>',
  'Models to compete (required, at least 2)':
    'Wettbewerbsmodelle (erforderlich, mindestens 2)',
  'Format: authType:modelId or just modelId':
    'Format: authType:modelId oder nur modelId',
  'Arena requires at least 2 models. Use --models model1,model2 to specify.':
    'Arena benötigt mindestens 2 Modelle. Verwenden Sie --models model1,model2 zur Angabe.',
  'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}':
    'Arena mit {{count}} Agents für Aufgabe "{{task}}" gestartet\nModelle:\n{{modelList}}',
  'Arena panes are running in tmux. Attach with: `{{command}}`':
    'Arena-Panels laufen in tmux. Verbinden mit: `{{command}}`',
  '[{{label}}] failed: {{error}}': '[{{label}}] fehlgeschlagen: {{error}}',
  'Loading suggestions...': 'Vorschläge werden geladen...',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.':
    'Die Aufschlüsselung der Nutzung des Kontextfensters anzeigen. Für Details pro Element "/context detail" verwenden.',
  'Show per-item context usage breakdown.':
    'Die Aufschlüsselung der Kontextnutzung pro Element anzeigen.',

  // === Missing key backfill ===
  'for shell mode': 'für Shell-Modus',
  'for commands': 'für Befehle',
  'for file paths': 'für Dateipfade',
  'to clear input': 'zum Leeren der Eingabe',
  'to cycle approvals': 'zum Wechseln der Freigaben',
  'to quit': 'zum Beenden',
  'for newline': 'für Zeilenumbruch',
  'to clear screen': 'zum Leeren des Bildschirms',
  'to search history': 'zum Durchsuchen des Verlaufs',
  'to paste images': 'zum Einfügen von Bildern',
  'for external editor': 'für externen Editor',
  'Updating...': 'Wird aktualisiert...',
  Unknown: 'Unbekannt',
  Error: 'Fehler',
  'Version:': 'Version:',
  "Use '/extensions install' to install your first extension.":
    "Verwenden Sie '/extensions install', um Ihre erste Erweiterung zu installieren.",
  'Value:': 'Wert:',
  'Press c to copy the authorization URL to your clipboard.':
    'Drücken Sie c, um die Autorisierungs-URL in die Zwischenablage zu kopieren.',
  'Copy request sent to your terminal. If paste is empty, copy the URL above manually.':
    'Kopieranfrage an Ihr Terminal gesendet. Wenn das Einfügen leer ist, kopieren Sie die URL oben manuell.',
  'Cannot write to terminal — copy the URL above manually.':
    'Schreiben ins Terminal nicht möglich — kopieren Sie die URL oben manuell.',
  'Tips:': 'Tipps:',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    'Erneuter Versuch in {{seconds}} Sekunden… (Versuch {{attempt}}/{{maxRetries}})',
  'Press Ctrl+Y to retry': 'Drücken Sie Ctrl+Y, um es erneut zu versuchen',
  'No failed request to retry.':
    'Keine fehlgeschlagene Anfrage zum Wiederholen.',
  'to retry last request': 'um die letzte Anfrage erneut zu versuchen',
  'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.':
    'Ungültiger API Key. Coding Plan API Keys beginnen mit "sk-sp-". Bitte prüfen.',
  'Lock release warning': 'Warnung zur Sperrfreigabe',
  'Metadata write warning': 'Warnung beim Schreiben der Metadaten',
  "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.":
    'Weitere Dream-Läufe können als gesperrt übersprungen werden, bis der nächste Stale-Sweep der Sitzung die Datei bereinigt.',
  "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.":
    'Das Scheduler-Gate hat den Zeitstempel dieses Dream-Laufs nicht gesehen; der nächste Dream-Zyklus kann früher als üblich erneut starten.',
  // === Same-as-English optimization ===
  'Agents:': 'Agenten:',
  Prompt: 'Eingabe',
  'Prompts:': 'Eingaben:',
  'Ref:': 'Referenz:',
  'Skills:': 'Fähigkeiten:',
  remote: 'entfernt',
  '中国 (China)': 'China',
  '中国 (China) - 阿里云百炼': 'China - 阿里云百炼',
};
