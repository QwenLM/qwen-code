/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Portuguese translations for Qwen Code CLI (pt-BR)

export default {
  // ============================================================================
  // Help / UI Components
  // ============================================================================
  'Basics:': 'Noções básicas:',
  'Add context': 'Adicionar contexto',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    'Use {{symbol}} para especificar arquivos para o contexto (ex: {{example}}) para atingir arquivos ou pastas específicos.',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Modo shell',
  'YOLO mode': 'Modo YOLO',
  'plan mode': 'modo planejamento',
  'auto-accept edits': 'aceitar edições automaticamente',
  'Accepting edits': 'Aceitando edições',
  '(shift + tab to cycle)': '(shift + tab para alternar)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    'Execute comandos shell via {{symbol}} (ex: {{example1}}) ou use linguagem natural (ex: {{example2}}).',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'iniciar servidor',
  'Commands:': 'Comandos:',
  'shell command': 'comando shell',
  'Model Context Protocol command (from external servers)':
    'Comando Model Context Protocol (de servidores externos)',
  'Keyboard Shortcuts:': 'Atalhos de teclado:',
  'Toggle this help display': 'Alternar exibição desta ajuda',
  'Toggle shell mode': 'Alternar modo shell',
  'Open command menu': 'Abrir menu de comandos',
  'Add file context': 'Adicionar contexto de arquivo',
  'Accept suggestion / Autocomplete': 'Aceitar sugestão / Autocompletar',
  'Reverse search history': 'Pesquisa reversa no histórico',
  'Press ? again to close': 'Pressione ? novamente para fechar',
  // Keyboard shortcuts panel descriptions
  'for shell mode': 'para modo shell',
  'for commands': 'para comandos',
  'for file paths': 'para caminhos de arquivo',
  'to clear input': 'para limpar entrada',
  'to cycle approvals': 'para alternar aprovações',
  'to quit': 'para sair',
  'for newline': 'para nova linha',
  'to clear screen': 'para limpar a tela',
  'to search history': 'para pesquisar no histórico',
  'to paste images': 'para colar imagens',
  'for external editor': 'para editor externo',
  'Jump through words in the input': 'Pular palavras na entrada',
  'Close dialogs, cancel requests, or quit application':
    'Fechar diálogos, cancelar solicitações ou sair do aplicativo',
  'New line': 'Nova linha',
  'New line (Alt+Enter works for certain linux distros)':
    'Nova linha (Alt+Enter funciona em certas distros linux)',
  'Clear the screen': 'Limpar a tela',
  'Open input in external editor': 'Abrir entrada no editor externo',
  'Send message': 'Enviar mensagem',
  'Initializing...': 'Inicializando...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    'Conectando aos servidores MCP... ({{connected}}/{{total}})',
  'Type your message or @path/to/file':
    'Digite sua mensagem ou @caminho/do/arquivo',
  '? for shortcuts': '? para atalhos',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "Pressione 'i' para modo INSERÇÃO e 'Esc' para modo NORMAL.",
  'Cancel operation / Clear input (double press)':
    'Cancelar operação / Limpar entrada (pressionar duas vezes)',
  'Cycle approval modes': 'Alternar modos de aprovação',
  'Cycle through your prompt history': 'Alternar histórico de prompts',
  'For a full list of shortcuts, see {{docPath}}':
    'Para uma lista completa de atalhos, consulte {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': 'para ajuda sobre o Qwen Code',
  'show version info': 'mostrar informações de versão',
  'submit a bug report': 'enviar um relatório de erro',
  'About Qwen Code': 'Sobre o Qwen Code',
  Status: 'Status',

  // ============================================================================
  // System Information Fields
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: 'Runtime',
  OS: 'SO',
  Auth: 'Autenticação',
  'CLI Version': 'Versão da CLI',
  'Git Commit': 'Commit do Git',
  Model: 'Modelo',
  Sandbox: 'Sandbox',
  'OS Platform': 'Plataforma do SO',
  'OS Arch': 'Arquitetura do SO',
  'OS Release': 'Versão do SO',
  'Node.js Version': 'Versão do Node.js',
  'NPM Version': 'Versão do NPM',
  'Session ID': 'ID da Sessão',
  'Auth Method': 'Método de Autenticação',
  'Base URL': 'URL Base',
  Proxy: 'Proxy',
  'Memory Usage': 'Uso de Memória',
  'IDE Client': 'Cliente IDE',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Analisa o projeto e cria um arquivo QWEN.md personalizado.',
  'list available Qwen Code tools. Usage: /tools [desc]':
    'listar ferramentas Qwen Code disponíveis. Uso: /tools [desc]',
  'Available Qwen Code CLI tools:': 'Ferramentas CLI do Qwen Code disponíveis:',
  'No tools available': 'Nenhuma ferramenta disponível',
  'View or change the approval mode for tool usage':
    'Ver ou alterar o modo de aprovação para uso de ferramentas',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    'Modo de aprovação inválido "{{arg}}". Modos válidos: {{modes}}',
  'Approval mode set to "{{mode}}"':
    'Modo de aprovação definido como "{{mode}}"',
  'View or change the language setting':
    'Ver ou alterar a configuração de idioma',
  'change the theme': 'alterar o tema',
  'Select Theme': 'Selecionar Tema',
  Preview: 'Visualizar',
  '(Use Enter to select, Tab to configure scope)':
    '(Use Enter para selecionar, Tab para configurar o escopo)',
  '(Use Enter to apply scope, Tab to go back)':
    '(Use Enter para aplicar o escopo, Tab para voltar)',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    'Configuração de tema indisponível devido à variável de ambiente NO_COLOR.',
  'Theme "{{themeName}}" not found.': 'Tema "{{themeName}}" não encontrado.',
  'Theme "{{themeName}}" not found in selected scope.':
    'Tema "{{themeName}}" não encontrado no escopo selecionado.',
  'Clear conversation history and free up context':
    'Limpar histórico de conversa e liberar contexto',
  'Compresses the context by replacing it with a summary.':
    'Comprime o contexto substituindo-o por um resumo.',
  'open full Qwen Code documentation in your browser':
    'abrir documentação completa do Qwen Code no seu navegador',
  'Configuration not available.': 'Configuração não disponível.',
  'change the auth method': 'alterar o método de autenticação',
  'Configure authentication information for login':
    'Configurar informações de autenticação para login',
  'Copy the last result or code snippet to clipboard':
    'Copiar o último resultado ou trecho de código para a área de transferência',

  // ============================================================================
  // Commands - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    'Gerenciar subagentes para delegação de tarefas especializadas.',
  'Manage existing subagents (view, edit, delete).':
    'Gerenciar subagentes existentes (ver, editar, excluir).',
  'Create a new subagent with guided setup.':
    'Criar um novo subagente com configuração guiada.',

  // ============================================================================
  // Agents - Management Dialog
  // ============================================================================
  Agents: 'Agentes',
  'Choose Action': 'Escolher Ação',
  'Edit {{name}}': 'Editar {{name}}',
  'Edit Tools: {{name}}': 'Editar Ferramentas: {{name}}',
  'Edit Color: {{name}}': 'Editar Cor: {{name}}',
  'Delete {{name}}': 'Excluir {{name}}',
  'Unknown Step': 'Etapa Desconhecida',
  'Esc to close': 'Esc para fechar',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Enter para selecionar, ↑↓ para navegar, Esc para fechar',
  'Esc to go back': 'Esc para voltar',
  'Enter to confirm, Esc to cancel': 'Enter para confirmar, Esc para cancelar',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Enter para selecionar, ↑↓ para navegar, Esc para voltar',
  'Invalid step: {{step}}': 'Etapa inválida: {{step}}',
  'No subagents found.': 'Nenhum subagente encontrado.',
  "Use '/agents create' to create your first subagent.":
    "Use '/agents create' para criar seu primeiro subagente.",
  '(built-in)': '(integrado)',
  '(overridden by project level agent)':
    '(substituído por agente de nível de projeto)',
  'Project Level ({{path}})': 'Nível de Projeto ({{path}})',
  'User Level ({{path}})': 'Nível de Usuário ({{path}})',
  'Built-in Agents': 'Agentes Integrados',
  'Extension Agents': 'Agentes de Extensão',
  'Using: {{count}} agents': 'Usando: {{count}} agentes',
  'View Agent': 'Ver Agente',
  'Edit Agent': 'Editar Agente',
  'Delete Agent': 'Excluir Agente',
  Back: 'Voltar',
  'No agent selected': 'Nenhum agente selecionado',
  'File Path: ': 'Caminho do Arquivo: ',
  'Tools: ': 'Ferramentas: ',
  'Color: ': 'Cor: ',
  'Description:': 'Descrição:',
  'System Prompt:': 'Prompt do Sistema:',
  'Open in editor': 'Abrir no editor',
  'Edit tools': 'Editar ferramentas',
  'Edit color': 'Editar cor',
  '❌ Error:': '❌ Erro:',
  'Are you sure you want to delete agent "{{name}}"?':
    'Tem certeza que deseja excluir o agente "{{name}}"?',

  // ============================================================================
  // Agents - Creation Wizard
  // ============================================================================
  'Project Level (.qwen/agents/)': 'Nível de Projeto (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': 'Nível de Usuário (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!': '✅ Subagente criado com sucesso!',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    'O subagente "{{name}}" foi salvo no nível {{level}}.',
  'Name: ': 'Nome: ',
  'Location: ': 'Localização: ',
  '❌ Error saving subagent:': '❌ Erro ao salvar subagente:',
  'Warnings:': 'Avisos:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    'O nome "{{name}}" já existe no nível {{level}} - o subagente existente será substituído',
  'Name "{{name}}" exists at user level - project level will take precedence':
    'O nome "{{name}}" existe no nível de usuário - o nível de projeto terá precedência',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    'O nome "{{name}}" existe no nível de projeto - o subagente existente terá precedência',
  'Description is over {{length}} characters':
    'A descrição tem mais de {{length}} caracteres',
  'System prompt is over {{length}} characters':
    'O prompt do sistema tem mais de {{length}} caracteres',

  // ============================================================================
  // Agents - Creation Wizard Steps
  // ============================================================================
  'Step {{n}}: Choose Location': 'Etapa {{n}}: Escolher Localização',
  'Step {{n}}: Choose Generation Method':
    'Etapa {{n}}: Escolher Método de Geração',
  'Generate with Qwen Code (Recommended)': 'Gerar com Qwen Code (Recomendado)',
  'Manual Creation': 'Criação Manual',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    'Descreva o que este subagente deve fazer e quando deve ser usado. (Seja abrangente para melhores resultados)',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    'ex: Revisor de código especialista que revisa código com base em melhores práticas...',
  'Generating subagent configuration...':
    'Gerando configuração do subagente...',
  'Failed to generate subagent: {{error}}':
    'Falha ao gerar subagente: {{error}}',
  'Step {{n}}: Describe Your Subagent': 'Etapa {{n}}: Descreva Seu Subagente',
  'Step {{n}}: Enter Subagent Name': 'Etapa {{n}}: Digite o Nome do Subagente',
  'Step {{n}}: Enter System Prompt': 'Etapa {{n}}: Digite o Prompt do Sistema',
  'Step {{n}}: Enter Description': 'Etapa {{n}}: Digite a Descrição',

  // ============================================================================
  // Agents - Tool Selection
  // ============================================================================
  'Step {{n}}: Select Tools': 'Etapa {{n}}: Selecionar Ferramentas',
  'All Tools (Default)': 'Todas as Ferramentas (Padrão)',
  'All Tools': 'Todas as Ferramentas',
  'Read-only Tools': 'Ferramentas de Somente Leitura',
  'Read & Edit Tools': 'Ferramentas de Leitura e Edição',
  'Read & Edit & Execution Tools': 'Ferramentas de Leitura, Edição e Execução',
  'All tools selected, including MCP tools':
    'Todas as ferramentas selecionadas, incluindo ferramentas MCP',
  'Selected tools:': 'Ferramentas selecionadas:',
  'Read-only tools:': 'Ferramentas de somente leitura:',
  'Edit tools:': 'Ferramentas de edição:',
  'Execution tools:': 'Ferramentas de execução:',
  'Step {{n}}: Choose Background Color': 'Etapa {{n}}: Escolher Cor de Fundo',
  'Step {{n}}: Confirm and Save': 'Etapa {{n}}: Confirmar e Salvar',

  // ============================================================================
  // Agents - Navigation & Instructions
  // ============================================================================
  'Esc to cancel': 'Esc para cancelar',
  'Press Enter to save, e to save and edit, Esc to go back':
    'Pressione Enter para salvar, e para salvar e editar, Esc para voltar',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    'Pressione Enter para continuar, {{navigation}}Esc para {{action}}',
  cancel: 'cancelar',
  'go back': 'voltar',
  '↑↓ to navigate, ': '↑↓ para navegar, ',
  'Enter a clear, unique name for this subagent.':
    'Digite um nome claro e único para este subagente.',
  'e.g., Code Reviewer': 'ex: Revisor de Código',
  'Name cannot be empty.': 'O nome não pode estar vazio.',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    'Escreva o prompt do sistema que define o comportamento deste subagente. Seja abrangente para melhores resultados.',
  'e.g., You are an expert code reviewer...':
    'ex: Você é um revisor de código especialista...',
  'System prompt cannot be empty.': 'O prompt do sistema não pode estar vazio.',
  'Describe when and how this subagent should be used.':
    'Descreva quando e como este subagente deve ser usado.',
  'e.g., Reviews code for best practices and potential bugs.':
    'ex: Revisa o código em busca de melhores práticas e erros potenciais.',
  'Description cannot be empty.': 'A descrição não pode estar vazia.',
  'Failed to launch editor: {{error}}': 'Falha ao iniciar editor: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    'Falha ao salvar e editar subagente: {{error}}',

  // ============================================================================
  // Commands - General (continued)
  // ============================================================================
  'View and edit Qwen Code settings': 'Ver e editar configurações do Qwen Code',
  Settings: 'Configurações',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'Para ver as alterações, o Qwen Code deve ser reiniciado. Pressione r para sair e aplicar as alterações agora.',
  'The command "/{{command}}" is not supported in non-interactive mode.':
    'O comando "/{{command}}" não é suportado no modo não interativo.',

  // ============================================================================
  // Settings Labels
  // ============================================================================
  'Vim Mode': 'Modo Vim',
  'Disable Auto Update': 'Desativar Atualização Automática',
  'Attribution: commit': 'Atribuição: commit',
  'Terminal Bell Notification': 'Notificação Sonora do Terminal',
  'Enable Usage Statistics': 'Ativar Estatísticas de Uso',
  Theme: 'Tema',
  'Preferred Editor': 'Editor Preferido',
  'Auto-connect to IDE': 'Conexão Automática com IDE',
  'Enable Prompt Completion': 'Ativar Autocompletar de Prompts',
  'Debug Keystroke Logging': 'Log de Depuração de Teclas',
  'Language: UI': 'Idioma: Interface',
  'Language: Model': 'Idioma: Modelo',
  'Output Format': 'Formato de Saída',
  'Hide Window Title': 'Ocultar Título da Janela',
  'Show Status in Title': 'Mostrar Status no Título',
  'Hide Tips': 'Ocultar Dicas',
  'Show Line Numbers in Code': 'Mostrar Números de Linhas no Código',
  'Show Citations': 'Mostrar Citações',
  'Custom Witty Phrases': 'Frases de Efeito Personalizadas',
  'Show Welcome Back Dialog': 'Mostrar Diálogo de Bem-vindo de Volta',
  'Enable User Feedback': 'Ativar Feedback do Usuário',
  'How is Qwen doing this session? (optional)':
    'Como o Qwen está se saindo nesta sessão? (opcional)',
  Bad: 'Ruim',
  Fine: 'Bom',
  Good: 'Ótimo',
  Dismiss: 'Ignorar',
  'Not Sure Yet': 'Não tenho certeza ainda',
  'Any other key': 'Qualquer outra tecla',
  'Disable Loading Phrases': 'Desativar Frases de Carregamento',
  'Screen Reader Mode': 'Modo de Leitor de Tela',
  'IDE Mode': 'Modo IDE',
  'Max Session Turns': 'Máximo de Turnos da Sessão',
  'Skip Next Speaker Check': 'Pular Verificação do Próximo Falante',
  'Skip Loop Detection': 'Pular Detecção de Loop',
  'Skip Startup Context': 'Pular Contexto de Inicialização',
  'Enable OpenAI Logging': 'Ativar Log do OpenAI',
  'OpenAI Logging Directory': 'Diretório de Log do OpenAI',
  Timeout: 'Tempo Limite',
  'Max Retries': 'Máximo de Tentativas',
  'Disable Cache Control': 'Desativar Controle de Cache',
  'Memory Discovery Max Dirs': 'Descoberta de Memória Máx. Diretorios',
  'Load Memory From Include Directories':
    'Carregar Memória de Diretórios Incluídos',
  'Respect .gitignore': 'Respeitar .gitignore',
  'Respect .qwenignore': 'Respeitar .qwenignore',
  'Enable Recursive File Search': 'Ativar Pesquisa Recursiva de Arquivos',
  'Disable Fuzzy Search': 'Desativar Pesquisa Difusa',
  'Interactive Shell (PTY)': 'Shell Interativo (PTY)',
  'Show Color': 'Mostrar Cores',
  'Auto Accept': 'Aceitar Automaticamente',
  'Use Ripgrep': 'Usar Ripgrep',
  'Use Builtin Ripgrep': 'Usar Ripgrep Integrado',
  'Enable Tool Output Truncation': 'Ativar Truncamento de Saída de Ferramenta',
  'Tool Output Truncation Threshold':
    'Limite de Truncamento de Saída de Ferramenta',
  'Tool Output Truncation Lines':
    'Linhas de Truncamento de Saída de Ferramenta',
  'Folder Trust': 'Confiança de Pasta',
  'Vision Model Preview': 'Visualização de Modelo de Visão',
  'Tool Schema Compliance': 'Conformidade de Esquema de Ferramenta',

  // Settings enum options
  'Auto (detect from system)': 'Automático (detectar do sistema)',
  Text: 'Texto',
  JSON: 'JSON',
  Plan: 'Planejamento',
  Default: 'Padrão',
  'Auto Edit': 'Edição Automática',
  YOLO: 'YOLO',
  'toggle vim mode on/off': 'alternar modo vim ligado/desligado',
  'check session stats. Usage: /stats [model|tools]':
    'verificar estatísticas da sessão. Uso: /stats [model|tools]',
  'Show model-specific usage statistics.':
    'Mostrar estatísticas de uso específicas do modelo.',
  'Show tool-specific usage statistics.':
    'Mostrar estatísticas de uso específicas da ferramenta.',
  'exit the cli': 'sair da cli',
  'list configured MCP servers and tools, or authenticate with OAuth-enabled servers':
    'listar servidores e ferramentas MCP configurados, ou autenticar com servidores habilitados para OAuth',
  'Manage workspace directories': 'Gerenciar diretórios do workspace',
  'Add directories to the workspace. Use comma to separate multiple paths':
    'Adicionar diretórios ao workspace. Use vírgula para separar vários caminhos',
  'Show all directories in the workspace':
    'Mostrar todos os diretórios no workspace',
  'set external editor preference': 'definir preferência de editor externo',
  'Select Editor': 'Selecionar Editor',
  'Editor Preference': 'Preferência de Editor',
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    'Estes editores são suportados atualmente. Note que alguns editores não podem ser usados no modo sandbox.',
  'Your preferred editor is:': 'Seu editor preferido é:',
  'Manage extensions': 'Gerenciar extensões',
  'List active extensions': 'Listar extensões ativas',
  'Update extensions. Usage: update <extension-names>|--all':
    'Atualizar extensões. Uso: update <nomes-das-extensoes>|--all',
  'Disable an extension': 'Desativar uma extensão',
  'Enable an extension': 'Ativar uma extensão',
  'Install an extension from a git repo or local path':
    'Instalar uma extensão de um repositório git ou caminho local',
  'Uninstall an extension': 'Desinstalar uma extensão',
  'No extensions installed.': 'Nenhuma extensão instalada.',
  'Usage: /extensions update <extension-names>|--all':
    'Uso: /extensions update <nomes-das-extensoes>|--all',
  'Extension "{{name}}" not found.': 'Extensão "{{name}}" não encontrada.',
  'No extensions to update.': 'Nenhuma extensão para atualizar.',
  'Usage: /extensions install <source>': 'Uso: /extensions install <fonte>',
  'Installing extension from "{{source}}"...':
    'Instalando extensão de "{{source}}"...',
  'Extension "{{name}}" installed successfully.':
    'Extensão "{{name}}" instalada com sucesso.',
  'Failed to install extension from "{{source}}": {{error}}':
    'Falha ao instalar extensão de "{{source}}": {{error}}',
  'Usage: /extensions uninstall <extension-name>':
    'Uso: /extensions uninstall <nome-da-extensao>',
  'Uninstalling extension "{{name}}"...':
    'Desinstalando extensão "{{name}}"...',
  'Extension "{{name}}" uninstalled successfully.':
    'Extensão "{{name}}" desinstalada com sucesso.',
  'Failed to uninstall extension "{{name}}": {{error}}':
    'Falha ao desinstalar extensão "{{name}}": {{error}}',
  'Usage: /extensions {{command}} <extension> [--scope=<user|workspace>]':
    'Uso: /extensions {{command}} <extensao> [--scope=<user|workspace>]',
  'Unsupported scope "{{scope}}", deve ser um de "user" ou "workspace"':
    'Escopo não suportado "{{scope}}", deve ser um de "user" ou "workspace"',
  'Extension "{{name}}" disabled for scope "{{scope}}"':
    'Extensão "{{name}}" desativada para o escopo "{{scope}}"',
  'Extension "{{name}}" enabled for scope "{{scope}}"':
    'Extensão "{{name}}" ativada para o escopo "{{scope}}"',
  'Do you want to continue? [Y/n]: ': 'Você deseja continuar? [Y/n]: ',
  'Do you want to continue?': 'Você deseja continuar?',
  'Installing extension "{{name}}".': 'Instalando extensão "{{name}}".',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**As extensões podem introduzir comportamentos inesperados. Certifique-se de ter investigado a fonte da extensão e confie no autor.**',
  'This extension will run the following MCP servers:':
    'Esta extensão executará os seguintes servidores MCP:',
  local: 'local',
  remote: 'remoto',
  'This extension will add the following commands: {{commands}}.':
    'Esta extensão adicionará os seguintes comandos: {{commands}}.',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'Esta extensão anexará informações ao seu contexto QWEN.md usando {{fileName}}',
  'This extension will exclude the following core tools: {{tools}}':
    'Esta extensão excluirá as seguintes ferramentas principais: {{tools}}',
  'This extension will install the following skills:':
    'Esta extensão instalará as seguintes habilidades:',
  'This extension will install the following subagents:':
    'Esta extensão instalará os seguintes subagentes:',
  'Installation cancelled for "{{name}}".':
    'Instalação cancelada para "{{name}}".',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    'Você está instalando uma extensão de {{originSource}}. Alguns recursos podem não funcionar perfeitamente com o Qwen Code.',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    '--ref e --auto-update não são aplicáveis para extensões de marketplace.',
  'Extension "{{name}}" installed successfully and enabled.':
    'Extensão "{{name}}" instalada com sucesso e ativada.',
  'Installs an extension from a git repository URL, local path, or claude marketplace (marketplace-url:plugin-name).':
    'Instala uma extensão de uma URL de repositório git, caminho local ou marketplace do claude (marketplace-url:plugin-name).',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    'A URL do github, caminho local ou fonte do marketplace (marketplace-url:plugin-name) da extensão para instalar.',
  'The git ref to install from.': 'A referência git para instalar.',
  'Enable auto-update for this extension.':
    'Ativar atualização automática para esta extensão.',
  'Enable pre-release versions for this extension.':
    'Ativar versões de pré-lançamento para esta extensão.',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    'Reconhecer os riscos de segurança de instalar uma extensão e pular o prompt de confirmação.',
  'The source argument must be provided.':
    'O argumento fonte deve ser fornecido.',
  'Extension "{{name}}" successfully uninstalled.':
    'Extensão "{{name}}" desinstalada com sucesso.',
  'Uninstalls an extension.': 'Desinstala uma extensão.',
  'The name or source path of the extension to uninstall.':
    'O nome ou caminho da fonte da extensão para desinstalar.',
  'Please include the name of the extension to uninstall as a positional argument.':
    'Inclua o nome da extensão para desinstalar como um argumento posicional.',
  'Enables an extension.': 'Ativa uma extensão.',
  'The name of the extension to enable.': 'O nome da extensão para ativar.',
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    'O escopo para ativar a extensão. Se não definido, será ativada em todos os escopos.',
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    'Extensão "{{name}}" ativada com sucesso para o escopo "{{scope}}".',
  'Extension "{{name}}" successfully enabled in all scopes.':
    'Extensão "{{name}}" ativada com sucesso em todos os escopos.',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    'Escopo inválido: {{scope}}. Use um de {{scopes}}.',
  'Disables an extension.': 'Desativa uma extensão.',
  'The name of the extension to disable.': 'O nome da extensão para desativar.',
  'The scope to disable the extenison in.':
    'O escopo para desativar a extensão.',
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    'Extensão "{{name}}" desativada com sucesso para o escopo "{{scope}}".',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    'Extensão "{{name}}" atualizada com sucesso: {{oldVersion}} → {{newVersion}}.',
  'Unable to install extension "{{name}}" due to missing install metadata':
    'Não foi possível instalar a extensão "{{name}}" devido à falta de metadados de instalação',
  'Extension "{{name}}" is already up to date.':
    'A extensão "{{name}}" já está atualizada.',
  'Updates all extensions or a named extension to the latest version.':
    'Atualiza todas as extensões ou uma extensão nomeada para a última versão.',
  'Update all extensions.': 'Atualizar todas as extensões.',
  'Either an extension name or --all must be provided':
    'Um nome de extensão ou --all deve ser fornecido',
  'Lists installed extensions.': 'Lista as extensões instaladas.',
  'Link extension failed to install.': 'Falha ao instalar link da extensão.',
  'Extension "{{name}}" linked successfully and enabled.':
    'Extensão "{{name}}" vinculada com sucesso e ativada.',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    'Vincula uma extensão de um caminho local. Atualizações feitas no caminho local sempre serão refletidas.',
  'The name of the extension to link.': 'O nome da extensão para vincular.',
  'Set a specific setting for an extension.':
    'Define uma configuração específica para uma extensão.',
  'Name of the extension to configure.': 'Nome da extensão para configurar.',
  'The setting to configure (name or env var).':
    'A configuração para configurar (nome ou var env).',
  'The scope to set the setting in.': 'O escopo para definir a configuração.',
  'List all settings for an extension.':
    'Listar todas as configurações de uma extensão.',
  'Name of the extension.': 'Nome da extensão.',
  'Extension "{{name}}" has no settings to configure.':
    'A extensão "{{name}}" não tem configurações para configurar.',
  'Settings for "{{name}}":': 'Configurações para "{{name}}":',
  '(workspace)': '(workspace)',
  '(user)': '(usuário)',
  '[not set]': '[não definido]',
  '[value stored in keychain]': '[valor armazenado no chaveiro]',
  'Value:': 'Valor:',
  'Manage extension settings.': 'Gerenciar configurações de extensão.',
  'You need to specify a command (set or list).':
    'Você precisa especificar um comando (set ou list).',

  // ============================================================================
  // Plugin Choice / Marketplace
  // ============================================================================
  'No plugins available in this marketplace.':
    'Nenhum plugin disponível neste marketplace.',
  'Select a plugin to install from marketplace "{{name}}":':
    'Selecione um plugin para instalar do marketplace "{{name}}":',
  'Plugin selection cancelled.': 'Seleção de plugin cancelada.',
  'Select a plugin from "{{name}}"': 'Selecione um plugin de "{{name}}"',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    'Use ↑↓ ou j/k para navegar, Enter para selecionar, Escape para cancelar',
  '{{count}} more above': '{{count}} mais acima',
  '{{count}} more below': '{{count}} mais abaixo',
  'manage IDE integration': 'gerenciar integração com IDE',
  'check status of IDE integration': 'verificar status da integração com IDE',
  'install required IDE companion for {{ideName}}':
    'instalar companion IDE necessário para {{ideName}}',
  'enable IDE integration': 'ativar integração com IDE',
  'disable IDE integration': 'desativar integração com IDE',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    'A integração com IDE não é suportada no seu ambiente atual. Para usar este recurso, execute o Qwen Code em um destes IDEs suportados: VS Code ou forks do VS Code.',
  'Set up GitHub Actions': 'Configurar GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    'Configurar atalhos de terminal para entrada multilinhas (VS Code, Cursor, Windsurf, Trae)',
  'Please restart your terminal for the changes to take effect.':
    'Reinicie seu terminal para que as alterações tenham efeito.',
  'Failed to configure terminal: {{error}}':
    'Falha ao configurar terminal: {{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    'Não foi possível determinar o caminho de configuração de {{terminalName}} no Windows: variável de ambiente APPDATA não está definida.',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} keybindings.json existe mas não é um array JSON válido. Corrija o arquivo manualmente ou exclua-o para permitir a configuração automática.',
  'File: {{file}}': 'Arquivo: {{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    'Falha ao analisar {{terminalName}} keybindings.json. O arquivo contém JSON inválido. Corrija o arquivo manualmente ou exclua-o para permitir a configuração automática.',
  'Error: {{error}}': 'Erro: {{error}}',
  'Shift+Enter binding already exists': 'Atalho Shift+Enter já existe',
  'Ctrl+Enter binding already exists': 'Atalho Ctrl+Enter já existe',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    'Atalhos existentes detectados. Não serão modificados para evitar conflitos.',
  'Please check and modify manually if needed: {{file}}':
    'Verifique e modifique manualmente se necessário: {{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    'Adicionados atalhos Shift+Enter e Ctrl+Enter para {{terminalName}}.',
  'Modified: {{file}}': 'Modificado: {{file}}',
  '{{terminalName}} keybindings already configured.':
    'Atalhos de {{terminalName}} já configurados.',
  'Failed to configure {{terminalName}}.':
    'Falha ao configurar {{terminalName}}.',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    'Seu terminal já está configurado para uma experiência ideal com entrada multilinhas (Shift+Enter e Ctrl+Enter).',
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    'Não foi possível detectar o tipo de terminal. Terminais suportados: VS Code, Cursor, Windsurf e Trae.',
  'Terminal "{{terminal}}" is not supported yet.':
    'O terminal "{{terminal}}" ainda não é suportado.',

  // ============================================================================
  // Commands - Language
  // ============================================================================
  'Invalid language. Available: {{options}}':
    'Idioma inválido. Disponíveis: {{options}}',
  'Language subcommands do not accept additional arguments.':
    'Subcomandos de idioma não aceitam argumentos adicionais.',
  'Current UI language: {{lang}}': 'Idioma atual da interface: {{lang}}',
  'Current LLM output language: {{lang}}':
    'Idioma atual da saída do LLM: {{lang}}',
  'LLM output language not set': 'Idioma de saída do LLM não definido',
  'Set UI language': 'Definir idioma da interface',
  'Set LLM output language': 'Definir idioma de saída do LLM',
  'Usage: /language ui [{{options}}]': 'Uso: /language ui [{{options}}]',
  'Usage: /language output <language>': 'Uso: /language output <idioma>',
  'Example: /language output 中文': 'Exemplo: /language output Português',
  'Example: /language output English': 'Exemplo: /language output Inglês',
  'Example: /language output 日本語': 'Exemplo: /language output Japonês',
  'Example: /language output Português': 'Exemplo: /language output Português',
  'UI language changed to {{lang}}':
    'Idioma da interface alterado para {{lang}}',
  'LLM output language set to {{lang}}':
    'Idioma de saída do LLM definido para {{lang}}',
  'LLM output language rule file generated at {{path}}':
    'Arquivo de regra de idioma de saída do LLM gerado em {{path}}',
  'Please restart the application for the changes to take effect.':
    'Reinicie o aplicativo para que as alterações tenham efeito.',
  'Failed to generate LLM output language rule file: {{error}}':
    'Falha ao gerar arquivo de regra de idioma de saída do LLM: {{error}}',
  'Invalid command. Available subcommands:':
    'Comando inválido. Subcomandos disponíveis:',
  'Available subcommands:': 'Subcomandos disponíveis:',
  'To request additional UI language packs, please open an issue on GitHub.':
    'Para solicitar pacotes de idiomas de interface adicionais, abra um problema no GitHub.',
  'Available options:': 'Opções disponíveis:',
  'Set UI language to {{name}}': 'Definir idioma da interface para {{name}}',

  // ============================================================================
  // Commands - Approval Mode
  // ============================================================================
  'Tool Approval Mode': 'Modo de Aprovação de Ferramenta',
  'Current approval mode: {{mode}}': 'Modo de aprovação atual: {{mode}}',
  'Available approval modes:': 'Modos de aprovação disponíveis:',
  'Approval mode changed to: {{mode}}':
    'Modo de aprovação alterado para: {{mode}}',
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    'Modo de aprovação alterado para: {{mode}} (salvo nas configurações de {{scope}}{{location}})',
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    'Uso: /approval-mode <mode> [--session|--user|--project]',

  'Scope subcommands do not accept additional arguments.':
    'Subcomandos de escopo não aceitam argumentos adicionais.',
  'Plan mode - Analyze only, do not modify files or execute commands':
    'Modo planejamento - Apenas analisa, não modifica arquivos nem executa comandos',
  'Default mode - Require approval for file edits or shell commands':
    'Modo padrão - Exige aprovação para edições de arquivos ou comandos shell',
  'Auto-edit mode - Automatically approve file edits':
    'Modo auto-edição - Aprova automaticamente edições de arquivos',
  'YOLO mode - Automatically approve all tools':
    'Modo YOLO - Aprova automaticamente todas as ferramentas',
  '{{mode}} mode': 'Modo {{mode}}',
  'Settings service is not available; unable to persist the approval mode.':
    'Serviço de configurações não disponível; não foi possível persistir o modo de aprovação.',
  'Failed to save approval mode: {{error}}':
    'Falha ao salvar modo de aprovação: {{error}}',
  'Failed to change approval mode: {{error}}':
    'Falha ao alterar modo de aprovação: {{error}}',
  'Apply to current session only (temporary)':
    'Aplicar apenas à sessão atual (temporário)',
  'Persist for this project/workspace': 'Persistir para este projeto/workspace',
  'Persist for this user on this machine':
    'Persistir para este usuário nesta máquina',
  'Analyze only, do not modify files or execute commands':
    'Apenas analisar, não modificar arquivos nem executar comandos',
  'Require approval for file edits or shell commands':
    'Exigir aprovação para edições de arquivos ou comandos shell',
  'Automatically approve file edits':
    'Aprovar automaticamente edições de arquivos',
  'Automatically approve all tools':
    'Aprovar automaticamente todas as ferramentas',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    'O modo de aprovação do workspace existe e tem prioridade. A alteração no nível do usuário não terá efeito.',
  'Apply To': 'Aplicar A',
  'User Settings': 'Configurações do Usuário',
  'Workspace Settings': 'Configurações do Workspace',

  // ============================================================================
  // Commands - Memory
  // ============================================================================
  'Commands for interacting with memory.':
    'Comandos para interagir com a memória.',
  'Show the current memory contents.':
    'Mostrar os conteúdos atuais da memória.',
  'Show project-level memory contents.':
    'Mostrar conteúdos da memória de nível de projeto.',
  'Show global memory contents.': 'Mostrar conteúdos da memória global.',
  'Add content to project-level memory.':
    'Adicionar conteúdo à memória de nível de projeto.',
  'Add content to global memory.': 'Adicionar conteúdo à memória global.',
  'Refresh the memory from the source.': 'Atualizar a memória da fonte.',
  'Usage: /memory add --project <text to remember>':
    'Uso: /memory add --project <texto para lembrar>',
  'Usage: /memory add --global <text to remember>':
    'Uso: /memory add --global <texto para lembrar>',
  'Attempting to save to project memory: "{{text}}"':
    'Tentando salvar na memória do projeto: "{{text}}"',
  'Attempting to save to global memory: "{{text}}"':
    'Tentando salvar na memória global: "{{text}}"',
  'Current memory content from {{count}} file(s):':
    'Conteúdo da memória atual de {{count}} arquivo(s):',
  'Memory is currently empty.': 'A memória está vazia no momento.',
  'Project memory file not found or is currently empty.':
    'Arquivo de memória do projeto não encontrado ou está vazio.',
  'Global memory file not found or is currently empty.':
    'Arquivo de memória global não encontrado ou está vazio.',
  'Global memory is currently empty.':
    'A memória global está vazia no momento.',
  'Global memory content:\n\n---\n{{content}}\n---':
    'Conteúdo da memória global:\n\n---\n{{content}}\n---',
  'Project memory content from {{path}}:\n\n---\n{{content}}\n---':
    'Conteúdo da memória do projeto de {{path}}:\n\n---\n{{content}}\n---',
  'Project memory is currently empty.':
    'A memória do projeto está vazia no momento.',
  'Refreshing memory from source files...':
    'Atualizando memória dos arquivos fonte...',
  'Add content to the memory. Use --global for global memory or --project for project memory.':
    'Adicionar conteúdo à memória. Use --global para memória global ou --project para memória do projeto.',
  'Usage: /memory add [--global|--project] <text to remember>':
    'Uso: /memory add [--global|--project] <texto para lembrar>',
  'Attempting to save to memory {{scope}}: "{{fact}}"':
    'Tentando salvar na memória {{scope}}: "{{fact}}"',

  // ============================================================================
  // Commands - MCP
  // ============================================================================
  'Authenticate with an OAuth-enabled MCP server':
    'Autenticar com um servidor MCP habilitado para OAuth',
  'List configured MCP servers and tools':
    'Listar servidores e ferramentas MCP configurados',
  'Restarts MCP servers.': 'Reinicia os servidores MCP.',
  'Config not loaded.': 'Configuração não carregada.',
  'Could not retrieve tool registry.':
    'Não foi possível recuperar o registro de ferramentas.',
  'No MCP servers configured with OAuth authentication.':
    'Nenhum servidor MCP configurado com autenticação OAuth.',
  'MCP servers with OAuth authentication:':
    'Servidores MCP com autenticação OAuth:',
  'Use /mcp auth <server-name> to authenticate.':
    'Use /mcp auth <nome-do-servidor> para autenticar.',
  "MCP server '{{name}}' not found.": "Servidor MCP '{{name}}' não encontrado.",
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "Autenticado com sucesso e ferramentas atualizadas para '{{name}}'.",
  "Failed to authenticate with MCP server '{{name}}': {{error}}":
    "Falha ao autenticar com o servidor MCP '{{name}}': {{error}}",
  "Re-discovering tools from '{{name}}'...":
    "Redescobrindo ferramentas de '{{name}}'...",

  // ============================================================================
  // Commands - Chat
  // ============================================================================
  'Manage conversation history.': 'Gerenciar histórico de conversas.',
  'List saved conversation checkpoints':
    'Listar checkpoints de conversa salvos',
  'No saved conversation checkpoints found.':
    'Nenhum checkpoint de conversa salvo encontrado.',
  'List of saved conversations:': 'Lista de conversas salvas:',
  'Note: Newest last, oldest first':
    'Nota: Mais novos por último, mais antigos primeiro',
  'Save the current conversation as a checkpoint. Usage: /chat save <tag>':
    'Salvar a conversa atual como um checkpoint. Uso: /chat save <tag>',
  'Missing tag. Usage: /chat save <tag>': 'Tag ausente. Uso: /chat save <tag>',
  'Delete a conversation checkpoint. Usage: /chat delete <tag>':
    'Excluir um checkpoint de conversa. Uso: /chat delete <tag>',
  'Missing tag. Usage: /chat delete <tag>':
    'Tag ausente. Uso: /chat delete <tag>',
  "Conversation checkpoint '{{tag}}' has been deleted.":
    "O checkpoint de conversa '{{tag}}' foi excluído.",
  "Error: No checkpoint found with tag '{{tag}}'.":
    "Erro: Nenhum checkpoint encontrado com a tag '{{tag}}'.",
  'Resume a conversation from a checkpoint. Usage: /chat resume <tag>':
    'Retomar uma conversa de um checkpoint. Uso: /chat resume <tag>',
  'Missing tag. Usage: /chat resume <tag>':
    'Tag ausente. Uso: /chat resume <tag>',
  'No saved checkpoint found with tag: {{tag}}.':
    'Nenhum checkpoint salvo encontrado com a tag: {{tag}}.',
  'A checkpoint with the tag {{tag}} already exists. Do you want to overwrite it?':
    'Um checkpoint com a tag {{tag}} já existe. Você deseja substituí-lo?',
  'No chat client available to save conversation.':
    'Nenhum cliente de chat disponível para salvar a conversa.',
  'Conversation checkpoint saved with tag: {{tag}}.':
    'Checkpoint de conversa salvo com a tag: {{tag}}.',
  'No conversation found to save.': 'Nenhuma conversa encontrada para salvar.',
  'No chat client available to share conversation.':
    'Nenhum cliente de chat disponível para compartilhar a conversa.',
  'Invalid file format. Only .md and .json are supported.':
    'Formato de arquivo inválido. Apenas .md e .json são suportados.',
  'Error sharing conversation: {{error}}':
    'Erro ao compartilhar conversa: {{error}}',
  'Conversation shared to {{filePath}}':
    'Conversa compartilhada em {{filePath}}',
  'No conversation found to share.':
    'Nenhuma conversa encontrada para compartilhar.',
  'Share the current conversation to a markdown or json file. Usage: /chat share <file>':
    'Compartilhar a conversa atual para um arquivo markdown ou json. Uso: /chat share <arquivo>',

  // ============================================================================
  // Commands - Summary
  // ============================================================================
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    'Gerar um resumo do projeto e salvá-lo em .qwen/PROJECT_SUMMARY.md',
  'No chat client available to generate summary.':
    'Nenhum cliente de chat disponível para gerar o resumo.',
  'Already generating summary, wait for previous request to complete':
    'Já gerando resumo, aguarde a conclusão da solicitação anterior',
  'No conversation found to summarize.':
    'Nenhuma conversa encontrada para resumir.',
  'Failed to generate project context summary: {{error}}':
    'Falha ao gerar resumo do contexto do projeto: {{error}}',
  'Saved project summary to {{filePathForDisplay}}.':
    'Resumo do projeto salvo em {{filePathForDisplay}}.',
  'Saving project summary...': 'Salvando resumo do projeto...',
  'Generating project summary...': 'Gerando resumo do projeto...',
  'Failed to generate summary - no text content received from LLM response':
    'Falha ao gerar resumo - nenhum conteúdo de texto recebido da resposta do LLM',

  // ============================================================================
  // Commands - Model
  // ============================================================================
  'Switch the model for this session': 'Trocar o modelo para esta sessão',
  'Content generator configuration not available.':
    'Configuração do gerador de conteúdo não disponível.',
  'Authentication type not available.': 'Tipo de autenticação não disponível.',
  'No models available for the current authentication type ({{authType}}).':
    'Nenhum modelo disponível para o tipo de autenticação atual ({{authType}}).',

  // ============================================================================
  // Commands - Clear
  // ============================================================================
  'Starting a new session, resetting chat, and clearing terminal.':
    'Iniciando uma nova sessão, resetando o chat e limpando o terminal.',
  'Starting a new session and clearing.':
    'Iniciando uma nova sessão e limpando.',

  // ============================================================================
  // Commands - Compress
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    'Já comprimindo, aguarde a conclusão da solicitação anterior',
  'Failed to compress chat history.': 'Falha ao comprimir histórico do chat.',
  'Failed to compress chat history: {{error}}':
    'Falha ao comprimir histórico do chat: {{error}}',
  'Compressing chat history': 'Comprimindo histórico do chat',
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    'Histórico do chat comprimido de {{originalTokens}} para {{newTokens}} tokens.',
  'Compression was not beneficial for this history size.':
    'A compressão não foi benéfica para este tamanho de histórico.',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    'A compressão do histórico do chat não reduziu o tamanho. Isso pode indicar problemas com o prompt de compressão.',
  'Could not compress chat history due to a token counting error.':
    'Não foi possível comprimir o histórico do chat devido a um erro de contagem de tokens.',
  'Chat history is already compressed.':
    'O histórico do chat já está comprimido.',

  // ============================================================================
  // Commands - Directory
  // ============================================================================
  'Configuration is not available.': 'A configuração não está disponível.',
  'Please provide at least one path to add.':
    'Forneça pelo menos um caminho para adicionar.',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    'O comando /directory add não é suportado em perfis de sandbox restritivos. Use --include-directories ao iniciar a sessão.',
  "Error adding '{{path}}': {{error}}":
    "Erro ao adicionar '{{path}}': {{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    'Arquivos QWEN.md adicionados com sucesso dos seguintes diretórios, se houverem:\n- {{directories}}',
  'Error refreshing memory: {{error}}': 'Erro ao atualizar memória: {{error}}',
  'Successfully added directories:\n- {{directories}}':
    'Diretórios adicionados com sucesso:\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    'Diretórios atuais do workspace:\n{{directories}}',

  // ============================================================================
  // Commands - Docs
  // ============================================================================
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    'Abra a seguinte URL no seu navegador para ver a documentação:\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    'Abrindo documentação no seu navegador: {{url}}',

  // ============================================================================
  // Dialogs - Tool Confirmation
  // ============================================================================
  'Do you want to proceed?': 'Você deseja prosseguir?',
  'Yes, allow once': 'Sim, permitir uma vez',
  'Allow always': 'Permitir sempre',
  No: 'Não',
  'No (esc)': 'Não (esc)',
  'Yes, allow always for this session': 'Sim, permitir sempre para esta sessão',
  'Modify in progress:': 'Modificação em progresso:',
  'Save and close external editor to continue':
    'Salve e feche o editor externo para continuar',
  'Apply this change?': 'Aplicar esta alteração?',
  'Yes, allow always': 'Sim, permitir sempre',
  'Modify with external editor': 'Modificar com editor externo',
  'No, suggest changes (esc)': 'Não, sugerir alterações (esc)',
  "Allow execution of: '{{command}}'?":
    "Permitir a execução de: '{{command}}'?",
  'Yes, allow always ...': 'Sim, permitir sempre ...',
  'Yes, and auto-accept edits': 'Sim, e aceitar edições automaticamente',
  'Yes, and manually approve edits': 'Sim, e aprovar edições manualmente',
  'No, keep planning (esc)': 'Não, continuar planejando (esc)',
  'URLs to fetch:': 'URLs para buscar:',
  'MCP Server: {{server}}': 'Servidor MCP: {{server}}',
  'Tool: {{tool}}': 'Ferramenta: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'Permitir a execução da ferramenta MCP "{{tool}}" do servidor "{{server}}"?',
  'Yes, always allow tool "{{tool}}" from server "{{server}}"':
    'Sim, sempre permitir a ferramenta "{{tool}}" do servidor "{{server}}"',
  'Yes, always allow all tools from server "{{server}}"':
    'Sim, sempre permitir todas as ferramentas do servidor "{{server}}"',

  // ============================================================================
  // Dialogs - Shell Confirmation
  // ============================================================================
  'Shell Command Execution': 'Execução de Comando Shell',
  'A custom command wants to run the following shell commands:':
    'Um comando personalizado deseja executar os seguintes comandos shell:',

  // ============================================================================
  // Dialogs - Pro Quota
  // ============================================================================
  'Pro quota limit reached for {{model}}.':
    'Limite de cota Pro atingido para {{model}}.',
  'Change auth (executes the /auth command)':
    'Alterar autenticação (executa o comando /auth)',
  'Continue with {{model}}': 'Continuar com {{model}}',

  // ============================================================================
  // Dialogs - Welcome Back
  // ============================================================================
  'Current Plan:': 'Plano Atual:',
  'Progress: {{done}}/{{total}} tasks completed':
    'Progresso: {{done}}/{{total}} tarefas concluídas',
  ', {{inProgress}} in progress': ', {{inProgress}} em progresso',
  'Pending Tasks:': 'Tarefas Pendentes:',
  'What would you like to do?': 'O que você gostaria de fazer?',
  'Choose how to proceed with your session:':
    'Escolha como proceder com sua sessão:',
  'Start new chat session': 'Iniciar nova sessão de chat',
  'Continue previous conversation': 'Continuar conversa anterior',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 Bem-vindo de volta! (Última atualização: {{timeAgo}})',
  '🎯 Overall Goal:': '🎯 Objetivo Geral:',

  // ============================================================================
  // Dialogs - Auth
  // ============================================================================
  'Get started': 'Começar',
  'How would you like to authenticate for this project?':
    'Como você gostaria de se autenticar para este projeto?',
  'OpenAI API key is required to use OpenAI authentication.':
    'A chave da API do OpenAI é necessária para usar a autenticação do OpenAI.',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    'Você deve selecionar um método de autenticação para prosseguir. Pressione Ctrl+C novamente para sair.',
  '(Use Enter to Set Auth)': '(Use Enter para Definir Autenticação)',
  'Terms of Services and Privacy Notice for Qwen Code':
    'Termos de Serviço e Aviso de Privacidade do Qwen Code',
  'Qwen OAuth': 'Qwen OAuth',
  'Login with QwenChat account to use daily free quota.':
    'Faça login com sua conta QwenChat para usar a cota gratuita diária.',
  'API-KEY': 'API-KEY',
  'Use coding plan credentials or your own api-keys/providers.':
    'Use credenciais do Coding Plan ou suas próprias chaves API/provedores.',
  OpenAI: 'OpenAI',
  'Failed to login. Message: {{message}}':
    'Falha ao fazer login. Mensagem: {{message}}',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    'A autenticação é forçada para {{enforcedType}}, mas você está usando {{currentType}} no momento.',
  'Qwen OAuth authentication timed out. Please try again.':
    'A autenticação Qwen OAuth expirou. Tente novamente.',
  'Qwen OAuth authentication cancelled.': 'Autenticação Qwen OAuth cancelada.',
  'Qwen OAuth Authentication': 'Autenticação Qwen OAuth',
  'Please visit this URL to authorize:': 'Visite esta URL para autorizar:',
  'Or scan the QR code below:': 'Ou escaneie o código QR abaixo:',
  'Waiting for authorization': 'Aguardando autorização',
  'Time remaining:': 'Tempo restante:',
  '(Press ESC or CTRL+C to cancel)': '(Pressione ESC ou CTRL+C para cancelar)',
  'Qwen OAuth Authentication Timeout':
    'Tempo Limite de Autenticação Qwen OAuth',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'Token OAuth expirado (mais de {{seconds}} segundos). Selecione o método de autenticação novamente.',
  'Press any key to return to authentication type selection.':
    'Pressione qualquer tecla para retornar à seleção do tipo de autenticação.',
  'Waiting for Qwen OAuth authentication...':
    'Aguardando autenticação Qwen OAuth...',
  'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.':
    'Nota: Sua chave de API existente no settings.json não será limpa ao usar o Qwen OAuth. Você pode voltar para a autenticação do OpenAI mais tarde, se necessário.',
  'Authentication timed out. Please try again.':
    'A autenticação expirou. Tente novamente.',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    'Aguardando autenticação... (Pressione ESC ou CTRL+C para cancelar)',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    'Chave de API ausente para autenticação compatível com OpenAI. Defina settings.security.auth.apiKey ou a variável de ambiente {{envKeyHint}}.',
  '{{envKeyHint}} environment variable not found.':
    'Variável de ambiente {{envKeyHint}} não encontrada.',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    'Variável de ambiente {{envKeyHint}} não encontrada. Defina-a no seu arquivo .env ou variáveis de ambiente.',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    'Variável de ambiente {{envKeyHint}} não encontrada (ou defina settings.security.auth.apiKey). Defina-a no seu arquivo .env ou variáveis de ambiente.',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    'Chave de API ausente para autenticação compatível com OpenAI. Defina a variável de ambiente {{envKeyHint}}.',
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'Provedor Anthropic sem a baseUrl necessária em modelProviders[].baseUrl.',
  'ANTHROPIC_BASE_URL environment variable not found.':
    'Variável de ambiente ANTHROPIC_BASE_URL não encontrada.',
  'Invalid auth method selected.':
    'Método de autenticação inválido selecionado.',
  'Failed to authenticate. Message: {{message}}':
    'Falha ao autenticar. Mensagem: {{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    'Autenticado com sucesso com credenciais {{authType}}.',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    'Valor QWEN_DEFAULT_AUTH_TYPE inválido: "{{value}}". Valores válidos são: {{validValues}}',
  'OpenAI Configuration Required': 'Configuração do OpenAI Necessária',
  'Please enter your OpenAI configuration. You can get an API key from':
    'Insira sua configuração do OpenAI. Você pode obter uma chave de API de',
  'API Key:': 'Chave da API:',
  'Invalid credentials: {{errorMessage}}':
    'Credenciais inválidas: {{errorMessage}}',
  'Failed to validate credentials': 'Falha ao validar credenciais',
  'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel':
    'Pressione Enter para continuar, Tab/↑↓ para navegar, Esc para cancelar',

  // ============================================================================
  // Dialogs - Model
  // ============================================================================
  'Select Model': 'Selecionar Modelo',
  '(Press Esc to close)': '(Pressione Esc para fechar)',
  'Current (effective) configuration': 'Configuração atual (efetiva)',
  AuthType: 'AuthType',
  'API Key': 'Chave da API',
  unset: 'não definido',
  '(default)': '(padrão)',
  '(set)': '(definido)',
  '(not set)': '(não definido)',
  "Failed to switch model to '{{modelId}}'.\n\n{{error}}":
    "Falha ao trocar o modelo para '{{modelId}}'.\n\n{{error}}",
  'Qwen 3.5 Plus — efficient hybrid model with leading coding performance':
    'Qwen 3.5 Plus — modelo híbrido eficiente com desempenho líder em programação',
  'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)':
    'O modelo Qwen Vision mais recente do Alibaba Cloud ModelStudio (versão: qwen3-vl-plus-2025-09-23)',

  // ============================================================================
  // Dialogs - Permissions
  // ============================================================================
  'Manage folder trust settings':
    'Gerenciar configurações de confiança de pasta',

  // ============================================================================
  // Status Bar
  // ============================================================================
  'Using:': 'Usando:',
  '{{count}} open file': '{{count}} arquivo aberto',
  '{{count}} open files': '{{count}} arquivos abertos',
  '(ctrl+g to view)': '(ctrl+g para ver)',
  '{{count}} {{name}} file': '{{count}} arquivo {{name}}',
  '{{count}} {{name}} files': '{{count}} arquivos {{name}}',
  '{{count}} MCP server': '{{count}} servidor MCP',
  '{{count}} MCP servers': '{{count}} servidores MCP',
  '{{count}} Blocked': '{{count}} Bloqueados',
  '(ctrl+t to view)': '(ctrl+t para ver)',
  '(ctrl+t to toggle)': '(ctrl+t para alternar)',
  'Press Ctrl+C again to exit.': 'Pressione Ctrl+C novamente para sair.',
  'Press Ctrl+D again to exit.': 'Pressione Ctrl+D novamente para sair.',
  'Press Esc again to clear.': 'Pressione Esc novamente para limpar.',

  // ============================================================================
  // MCP Status
  // ============================================================================
  'No MCP servers configured.': 'Nenhum servidor MCP configurado.',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ Servidores MCP estão iniciando ({{count}} inicializando)...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    'Nota: A primeira inicialização pode demorar mais. A disponibilidade da ferramenta será atualizada automaticamente.',
  'Configured MCP servers:': 'Servidores MCP configurados:',
  Ready: 'Pronto',
  'Starting... (first startup may take longer)':
    'Iniciando... (a primeira inicialização pode demorar mais)',
  Disconnected: 'Desconectado',
  '{{count}} tool': '{{count}} ferramenta',
  '{{count}} tools': '{{count}} ferramentas',
  '{{count}} prompt': '{{count}} prompt',
  '{{count}} prompts': '{{count}} prompts',
  '(from {{extensionName}})': '(de {{extensionName}})',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth expirado',
  'OAuth not authenticated': 'OAuth não autenticado',
  'tools and prompts will appear when ready':
    'ferramentas e prompts aparecerão quando estiverem prontos',
  '{{count}} tools cached': '{{count}} ferramentas em cache',
  'Tools:': 'Ferramentas:',
  'Parameters:': 'Parâmetros:',
  'Prompts:': 'Prompts:',
  Blocked: 'Bloqueado',
  '💡 Tips:': '💡 Dicas:',
  Use: 'Use',
  'to show server and tool descriptions':
    'para mostrar descrições de servidores e ferramentas',
  'to show tool parameter schemas':
    'para mostrar esquemas de parâmetros de ferramentas',
  'to hide descriptions': 'para ocultar descrições',
  'to authenticate with OAuth-enabled servers':
    'para autenticar com servidores habilitados para OAuth',
  Press: 'Pressione',
  'to toggle tool descriptions on/off':
    'para alternar descrições de ferramentas ligadas/desligadas',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "Iniciando autenticação OAuth para servidor MCP '{{name}}'...",
  'Restarting MCP servers...': 'Reiniciando servidores MCP...',

  // ============================================================================
  // Startup Tips
  // ============================================================================
  'Tips:': 'Dicas:',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    'Use /compress quando a conversa ficar longa para resumir o histórico e liberar contexto.',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    'Comece uma nova ideia com /clear ou /new; a sessão anterior permanece disponível no histórico.',
  'Use /bug to submit issues to the maintainers when something goes off.':
    'Use /bug para enviar problemas aos mantenedores quando algo der errado.',
  'Switch auth type quickly with /auth.':
    'Troque o tipo de autenticação rapidamente com /auth.',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    'Você pode executar quaisquer comandos shell do Qwen Code usando ! (ex: !ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    'Digite / para abrir o popup de comandos; Tab autocompleta comandos de barra e prompts salvos.',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    'Você pode retomar uma conversa anterior executando qwen --continue ou qwen --resume.',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'Você pode alternar o modo de permissão rapidamente com Shift+Tab ou /approval-mode.',

  // ============================================================================
  // Exit Screen / Stats
  // ============================================================================
  'Agent powering down. Goodbye!': 'Agente desligando. Adeus!',
  'To continue this session, run': 'Para continuar esta sessão, execute',
  'Interaction Summary': 'Resumo da Interação',
  'Session ID:': 'ID da Sessão:',
  'Tool Calls:': 'Chamadas de Ferramenta:',
  'Success Rate:': 'Taxa de Sucesso:',
  'User Agreement:': 'Acordo do Usuário:',
  reviewed: 'revisado',
  'Code Changes:': 'Alterações de Código:',
  Performance: 'Desempenho',
  'Wall Time:': 'Tempo Total:',
  'Agent Active:': 'Agente Ativo:',
  'API Time:': 'Tempo de API:',
  'Tool Time:': 'Tempo de Ferramenta:',
  'Session Stats': 'Estatísticas da Sessão',
  'Model Usage': 'Uso do Modelo',
  Reqs: 'Reqs',
  'Input Tokens': 'Tokens de Entrada',
  'Output Tokens': 'Tokens de Saída',
  'Savings Highlight:': 'Destaque de Economia:',
  'of input tokens were served from the cache, reducing costs.':
    'de tokens de entrada foram servidos do cache, reduzindo custos.',
  'Tip: For a full token breakdown, run `/stats model`.':
    'Dica: Para um detalhamento completo de tokens, execute `/stats model`.',
  'Model Stats For Nerds': 'Estatísticas de Modelo Para Nerds',
  'Tool Stats For Nerds': 'Estatísticas de Ferramenta Para Nerds',
  Metric: 'Métrica',
  API: 'API',
  Requests: 'Solicitações',
  Errors: 'Erros',
  'Avg Latency': 'Latência Média',
  Tokens: 'Tokens',
  Total: 'Total',
  Prompt: 'Prompt',
  Cached: 'Cacheado',
  Thoughts: 'Pensamentos',
  Tool: 'Ferramenta',
  Output: 'Saída',
  'No API calls have been made in this session.':
    'Nenhuma chamada de API foi feita nesta sessão.',
  'Tool Name': 'Nome da Ferramenta',
  Calls: 'Chamadas',
  'Success Rate': 'Taxa de Sucesso',
  'Avg Duration': 'Duração Média',
  'User Decision Summary': 'Resumo de Decisão do Usuário',
  'Total Reviewed Suggestions:': 'Total de Sugestões Revisadas:',
  ' » Accepted:': ' » Aceitas:',
  ' » Rejected:': ' » Rejeitadas:',
  ' » Modified:': ' » Modificadas:',
  ' Overall Agreement Rate:': ' Taxa Geral de Acordo:',
  'No tool calls have been made in this session.':
    'Nenhuma chamada de ferramenta foi feita nesta sessão.',
  'Session start time is unavailable, cannot calculate stats.':
    'Hora de início da sessão indisponível, não é possível calcular estatísticas.',

  // ============================================================================
  // Command Format Migration
  // ============================================================================
  'Command Format Migration': 'Migração de Formato de Comando',
  'Found {{count}} TOML command file:':
    'Encontrado {{count}} arquivo de comando TOML:',
  'Found {{count}} TOML command files:':
    'Encontrados {{count}} arquivos de comando TOML:',
  '... and {{count}} more': '... e mais {{count}}',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'O formato TOML está obsoleto. Você gostaria de migrá-los para o formato Markdown?',
  '(Backups will be created and original files will be preserved)':
    '(Backups serão criados e arquivos originais serão preservados)',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...': 'Aguardando confirmação do usuário...',
  '(esc to cancel, {{time}})': '(esc para cancelar, {{time}})',

  WITTY_LOADING_PHRASES: [
    'Estou com sorte',
    'Enviando maravilhas...',
    'Pintando os serifos de volta...',
    'Navegando pelo mofo limoso...',
    'Consultando os espíritos digitais...',
    'Reticulando splines...',
    'Aquecendo os hamsters da IA...',
    'Perguntando à concha mágica...',
    'Gerando réplica espirituosa...',
    'Polindo os algoritmos...',
    'Não apresse a perfeição (ou meu código)...',
    'Preparando bytes frescos...',
    'Contando elétrons...',
    'Engajando processadores cognitivos...',
    'Verificando erros de sintaxe no universo...',
    'Um momento, otimizando o humor...',
    'Embaralhando piadas...',
    'Desembaraçando redes neurais...',
    'Compilando brilhantismo...',
    'Carregando humor.exe...',
    'Invocando a nuvem da sabedoria...',
    'Preparando uma resposta espirituosa...',
    'Só um segundo, estou depurando a realidade...',
    'Confundindo as opções...',
    'Sintonizando as frequências cósmicas...',
    'Criando uma resposta digna da sua paciência...',
    'Compilando os 1s e 0s...',
    'Resolvendo dependências... e crises existenciais...',
    'Desfragmentando memórias... tanto RAM quanto pessoais...',
    'Reiniciando o módulo de humor...',
    'Fazendo cache do essencial (principalmente memes de gatos)...',
    'Otimizando para velocidade absurda',
    'Trocando bits... não conte para os bytes...',
    'Coletando lixo... volto já...',
    'Montando a internet...',
    'Convertendo café em código...',
    'Atualizando a sintaxe da realidade...',
    'Reconectando as sinapses...',
    'Procurando um ponto e vírgula perdido...',
    'Lubrificando as engrenagens da máquina...',
    'Pré-aquecendo os servidores...',
    'Calibrando o capacitor de fluxo...',
    'Engajando o motor de improbabilidade...',
    'Canalizando a Força...',
    'Alinhando as estrelas para uma resposta ideal...',
    'Assim dizemos todos...',
    'Carregando a próxima grande ideia...',
    'Só um momento, estou na zona...',
    'Preparando para deslumbrá-lo com brilhantismo...',
    'Só um tique, estou polindo minha inteligência...',
    'Segure firme, estou criando uma obra-prima...',
    'Só um instante, estou depurando o universo...',
    'Só um momento, estou alinhando os pixels...',
    'Só um segundo, estou otimizando o humor...',
    'Só um momento, estou ajustando os algoritmos...',
    'Velocidade de dobra engajada...',
    'Minerando mais cristais de Dilithium...',
    'Não entre em pânico...',
    'Seguindo o coelho branco...',
    'A verdade está lá fora... em algum lugar...',
    'Soprando o cartucho...',
    'Carregando... Faça um barrel roll!',
    'Aguardando o respawn...',
    'Terminando a Kessel Run em menos de 12 parsecs...',
    'O bolo não é uma mentira, só ainda está carregando...',
    'Mexendo na tela de criação de personagem...',
    'Só um momento, estou encontrando o meme certo...',
    "Pressionando 'A' para continuar...",
    'Pastoreando gatos digitais...',
    'Polindo os pixels...',
    'Encontrando um trocadilho adequado para a tela de carregamento...',
    'Distraindo você com esta frase espirituosa...',
    'Quase lá... provavelmente...',
    'Nossos hamsters estão trabalhando o mais rápido que podem...',
    'Dando um tapinha na cabeça do Cloudy...',
    'Acariciando o gato...',
    'Dando um Rickroll no meu chefe...',
    'Never gonna give you up, never gonna let you down...',
    'Tocando o baixo...',
    'Provando as amoras...',
    'Estou indo longe, estou indo pela velocidade...',
    'Isso é vida real? Ou é apenas fantasia?...',
    'Tenho um bom pressentimento sobre isso...',
    'Cutucando o urso...',
    'Fazendo pesquisa sobre os últimos memes...',
    'Descobrindo como tornar isso mais espirituoso...',
    'Hmmm... deixe-me pensar...',
    'O que você chama de um peixe sem olhos? Um pxe...',
    'Por que o computador foi à terapia? Porque tinha muitos bytes...',
    'Por que programadores não gostam da natureza? Porque tem muitos bugs...',
    'Por que programadores preferem o modo escuro? Porque a luz atrai bugs...',
    'Por que o desenvolvedor faliu? Porque usou todo o seu cache...',
    'O que você pode fazer com um lápis quebrado? Nada, ele não tem ponta...',
    'Aplicando manutenção percussiva...',
    'Procurando a orientação correta do USB...',
    'Garantindo que a fumaça mágica permaneça dentro dos fios...',
    'Tentando sair do Vim...',
    'Girando a roda do hamster...',
    'Isso não é um bug, é um recurso não documentado...',
    'Engajar.',
    'Eu voltarei... com uma resposta.',
    'Meu outro processo é uma TARDIS...',
    'Comungando com o espírito da máquina...',
    'Deixando os pensamentos marinarem...',
    'Lembrei agora onde coloquei minhas chaves...',
    'Ponderando a orbe...',
    'Eu vi coisas que vocês não acreditariam... como um usuário que lê mensagens de carregamento.',
    'Iniciando olhar pensativo...',
    'Qual é o lanche favorito de um computador? Microchips.',
    'Por que desenvolvedores Java usam óculos? Porque eles não C#.',
    'Carregando o laser... pew pew!',
    'Dividindo por zero... só brincando!',
    'Procurando por um supervisor adulto... digo, processando.',
    'Fazendo bip boop.',
    'Buffering... porque até as IAs precisam de um momento.',
    'Entrelaçando partículas quânticas para uma resposta mais rápida...',
    'Polindo o cromo... nos algoritmos.',
    'Você não está entretido? (Trabalhando nisso!)',
    'Invocando os gremlins do código... para ajudar, é claro.',
    'Só esperando o som da conexão discada terminar...',
    'Recalibrando o humorômetro.',
    'Minha outra tela de carregamento é ainda mais engraçada.',
    'Tenho quase certeza que tem um gato andando no teclado em algum lugar...',
    'Aumentando... Aumentando... Ainda carregando.',
    'Não é um bug, é um recurso... desta tela de carregamento.',
    'Você já tentou desligar e ligar de novo? (A tela de carregamento, não eu.)',
    'Construindo pilares adicionais...',
  ],

  // ============================================================================
  // Extension Settings Input
  // ============================================================================
  'Enter value...': 'Digite o valor...',
  'Enter sensitive value...': 'Digite o valor sensível...',
  'Press Enter to submit, Escape to cancel':
    'Pressione Enter para enviar, Escape para cancelar',

  // ============================================================================
  // Command Migration Tool
  // ============================================================================
  'Markdown file already exists: {{filename}}':
    'Arquivo Markdown já existe: {{filename}}',
  'TOML Command Format Deprecation Notice':
    'Aviso de Obsolescência do Formato de Comando TOML',
  'Found {{count}} command file(s) in TOML format:':
    'Encontrado(s) {{count}} arquivo(s) de comando no formato TOML:',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    'O formato TOML para comandos está sendo descontinuado em favor do formato Markdown.',
  'Markdown format is more readable and easier to edit.':
    'O formato Markdown é mais legível e fácil de editar.',
  'You can migrate these files automatically using:':
    'Você pode migrar esses arquivos automaticamente usando:',
  'Or manually convert each file:': 'Ou converter manualmente cada arquivo:',
  'TOML: prompt = "..." / description = "..."':
    'TOML: prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content':
    'Markdown: YAML frontmatter + conteúdo',
  'The migration tool will:': 'A ferramenta de migração irá:',
  'Convert TOML files to Markdown': 'Converter arquivos TOML para Markdown',
  'Create backups of original files': 'Criar backups dos arquivos originais',
  'Preserve all command functionality':
    'Preservar toda a funcionalidade do comando',
  'TOML format will continue to work for now, but migration is recommended.':
    'O formato TOML continuará a funcionar por enquanto, mas a migração é recomendada.',

  // ============================================================================
  // Extensions - Explore Command
  // ============================================================================
  'Open extensions page in your browser':
    'Abrir página de extensões no seu navegador',
  'Unknown extensions source: {{source}}.':
    'Fonte de extensões desconhecida: {{source}}.',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    'Abriria a página de extensões no seu navegador: {{url}} (pulado no ambiente de teste)',
  'View available extensions at {{url}}':
    'Ver extensões disponíveis em {{url}}',
  'Opening extensions page in your browser: {{url}}':
    'Abrindo página de extensões no seu navegador: {{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    'Falha ao abrir o navegador. Confira a galeria de extensões em {{url}}',

  // ============================================================================
  // Custom API-KEY Configuration
  // ============================================================================
  'For advanced users who want to configure models manually.':
    'Para usuários avançados que desejam configurar modelos manualmente.',
  'Please configure your models in settings.json:':
    'Por favor, configure seus modelos em settings.json:',
  'Set API key via environment variable (e.g., OPENAI_API_KEY)':
    'Defina a chave de API via variável de ambiente (ex: OPENAI_API_KEY)',
  "Add model configuration to modelProviders['openai'] (or other auth types)":
    "Adicione a configuração do modelo a modelProviders['openai'] (ou outros tipos de autenticação)",
  'Each provider needs: id, envKey (required), plus optional baseUrl, generationConfig':
    'Cada provedor precisa de: id, envKey (obrigatório), além de baseUrl e generationConfig opcionais',
  'Use /model command to select your preferred model from the configured list':
    'Use o comando /model para selecionar seu modelo preferido da lista configurada',
  'Supported auth types: openai, anthropic, gemini, vertex-ai, etc.':
    'Tipos de autenticação suportados: openai, anthropic, gemini, vertex-ai, etc.',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'Please enter your API key:': 'Por favor, digite sua chave de API:',
  'API key cannot be empty.': 'A chave de API não pode estar vazia.',
  'You can get your exclusive Coding Plan API-KEY here:':
    'Você pode obter sua chave de API exclusiva do Coding Plan aqui:',
  'New model configurations are available for Bailian Coding Plan. Update now?':
    'Novas configurações de modelo estão disponíveis para o Bailian Coding Plan. Atualizar agora?',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Configuração do Coding Plan atualizada com sucesso. Novos modelos agora estão disponíveis.',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    'Chave de API do Coding Plan não encontrada. Por favor, re-autentique com o Coding Plan.',
  'Failed to update Coding Plan configuration: {{message}}':
    'Falha ao atualizar a configuração do Coding Plan: {{message}}',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  "Paste your api key of Bailian Coding Plan and you're all set!":
    'Cole sua chave de API do Bailian Coding Plan e pronto!',
  Custom: 'Personalizado',
  'More instructions about configuring `modelProviders` manually.':
    'Mais instruções sobre como configurar `modelProviders` manualmente.',
  'Select API-KEY configuration mode:':
    'Selecione o modo de configuração da API-KEY:',
  '(Press Escape to go back)': '(Pressione Escape para voltar)',
  '(Press Enter to submit, Escape to cancel)':
    '(Pressione Enter para enviar, Escape para cancelar)',
  'More instructions please check:': 'Mais instruções, consulte:',
};
