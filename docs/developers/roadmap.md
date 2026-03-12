# Qwen Code RoadMap

> **Objective**: Catch up with Claude Code's product functionality, continuously refine details, and enhance user experience.

| Category                        | Phase 1                                                                                                                                                                            | Phase 2                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User Experience                 | ✅ Terminal UI<br>✅ Support OpenAI Protocol<br>✅ Settings<br>✅ OAuth<br>✅ Cache Control<br>✅ Memory<br>✅ Compress<br>✅ Theme                                                | Better UI<br>OnBoarding<br>LogView<br>✅ Session<br>Permission<br>🔄 Cross-platform Compatibility<br>✅ Coding Plan<br>✅ Anthropic Provider<br>✅ Multimodal Input<br>✅ Unified WebUI |
| Coding Workflow                 | ✅ Slash Commands<br>✅ MCP<br>✅ PlanMode<br>✅ TodoWrite<br>✅ SubAgent<br>✅ Multi Model<br>✅ Chat Management<br>✅ Tools (WebFetch, Bash, TextSearch, FileReadFile, EditFile) | 🔄 Hooks<br>✅ Skill<br>✅ Headless Mode<br>✅ Tools (WebSearch)<br>✅ LSP Support<br>✅ Concurrent Runner                                                                              |
| Building Open Capabilities      | ✅ Custom Commands                                                                                                                                                                 | ✅ QwenCode SDK<br>✅ Extension System                                                                                                                                                  |
| Integrating Community Ecosystem |                                                                                                                                                                                    | ✅ VSCode Plugin<br>✅ ACP/Zed<br>✅ GHA                                                                                                                                                |
| Administrative Capabilities     | ✅ Stats<br>✅ Feedback                                                                                                                                                            | Costs<br>Dashboard<br>✅ User Feedback Dialog                                                                                                                                           |

> For more details, please see the list below.

## Features

#### Completed Features

| Feature                 | Version   | Description                                             | Category                        | Phase |
| ----------------------- | --------- | ------------------------------------------------------- | ------------------------------- | ----- |
| **Coding Plan**         | `V0.10.0` | Alibaba Cloud Coding Plan authentication & models       | User Experience                 | 2     |
| Unified WebUI           | `V0.9.0`  | Shared WebUI component library for VSCode/CLI           | User Experience                 | 2     |
| Export Chat             | `V0.8.0`  | Export sessions to Markdown/HTML/JSON/JSONL             | User Experience                 | 2     |
| Extension System        | `V0.8.0`  | Full extension management with slash commands           | Building Open Capabilities      | 2     |
| LSP Support             | `V0.7.0`  | Experimental LSP service (`--experimental-lsp`)         | Coding Workflow                 | 2     |
| Anthropic Provider      | `V0.7.0`  | Anthropic API provider support                          | User Experience                 | 2     |
| User Feedback Dialog    | `V0.7.0`  | In-app feedback collection with fatigue mechanism       | Administrative Capabilities     | 2     |
| Concurrent Runner       | `V0.6.0`  | Batch CLI execution with Git integration                | Coding Workflow                 | 2     |
| Multimodal Input        | `V0.6.0`  | Image, PDF, audio, video input support                  | User Experience                 | 2     |
| Skill                   | `V0.6.0`  | Extensible custom AI skills (experimental)              | Coding Workflow                 | 2     |
| Github Actions          | `V0.5.0`  | qwen-code-action and automation                         | Integrating Community Ecosystem | 1     |
| VSCode Plugin           | `V0.5.0`  | VSCode extension plugin                                 | Integrating Community Ecosystem | 1     |
| QwenCode SDK            | `V0.4.0`  | Open SDK for third-party integration                    | Building Open Capabilities      | 1     |
| Session                 | `V0.4.0`  | Enhanced session management                             | User Experience                 | 1     |
| i18n                    | `V0.3.0`  | Internationalization and multilingual support           | User Experience                 | 1     |
| Headless Mode           | `V0.3.0`  | Headless mode (non-interactive)                         | Coding Workflow                 | 1     |
| ACP/Zed                 | `V0.2.0`  | ACP and Zed editor integration                          | Integrating Community Ecosystem | 1     |
| Terminal UI             | `V0.1.0+` | Interactive terminal user interface                     | User Experience                 | 1     |
| Settings                | `V0.1.0+` | Configuration management system                         | User Experience                 | 1     |
| Theme                   | `V0.1.0+` | Multi-theme support                                     | User Experience                 | 1     |
| Support OpenAI Protocol | `V0.1.0+` | Support for OpenAI API protocol                         | User Experience                 | 1     |
| Chat Management         | `V0.1.0+` | Session management (save, restore, browse)              | Coding Workflow                 | 1     |
| MCP                     | `V0.1.0+` | Model Context Protocol integration                      | Coding Workflow                 | 1     |
| Multi Model             | `V0.1.0+` | Multi-model support and switching                       | Coding Workflow                 | 1     |
| Slash Commands          | `V0.1.0+` | Slash command system                                    | Coding Workflow                 | 1     |
| Tool: Bash              | `V0.1.0+` | Shell command execution tool (with is_background param) | Coding Workflow                 | 1     |
| Tool: FileRead/EditFile | `V0.1.0+` | File read/write and edit tools                          | Coding Workflow                 | 1     |
| Custom Commands         | `V0.1.0+` | Custom command loading                                  | Building Open Capabilities      | 1     |
| Feedback                | `V0.1.0+` | Feedback mechanism (/bug command)                       | Administrative Capabilities     | 1     |
| Stats                   | `V0.1.0+` | Usage statistics and quota display                      | Administrative Capabilities     | 1     |
| Memory                  | `V0.0.9+` | Project-level and global memory management              | User Experience                 | 1     |
| Cache Control           | `V0.0.9+` | Prompt caching control (Anthropic, DashScope)           | User Experience                 | 1     |
| PlanMode                | `V0.0.14` | Task planning mode                                      | Coding Workflow                 | 1     |
| Compress                | `V0.0.11` | Chat compression mechanism                              | User Experience                 | 1     |
| SubAgent                | `V0.0.11` | Dedicated sub-agent system                              | Coding Workflow                 | 1     |
| TodoWrite               | `V0.0.10` | Task management and progress tracking                   | Coding Workflow                 | 1     |
| Tool: TextSearch        | `V0.0.8+` | Text search tool (grep, supports .qwenignore)           | Coding Workflow                 | 1     |
| Tool: WebFetch          | `V0.0.7+` | Web content fetching tool                               | Coding Workflow                 | 1     |
| Tool: WebSearch         | `V0.0.7+` | Web search tool (using Tavily API)                      | Coding Workflow                 | 1     |
| OAuth                   | `V0.0.5+` | OAuth login authentication (Qwen OAuth)                 | User Experience                 | 1     |

#### Features to Develop

| Feature                      | Priority | Status      | Description                       | Category                    |
| ---------------------------- | -------- | ----------- | --------------------------------- | --------------------------- |
| Better UI                    | P1       | Planned     | Optimized terminal UI interaction | User Experience             |
| OnBoarding                   | P1       | Planned     | New user onboarding flow          | User Experience             |
| Permission                   | P1       | Planned     | Permission system optimization    | User Experience             |
| Cross-platform Compatibility | P1       | In Progress | Windows/Linux/macOS compatibility | User Experience             |
| LogView                      | P2       | Planned     | Log viewing and debugging feature | User Experience             |
| Hooks                        | P2       | In Progress | Extension hooks system            | Coding Workflow             |
| Costs                        | P2       | Planned     | Cost tracking and analysis        | Administrative Capabilities |
| Dashboard                    | P2       | Planned     | Management dashboard              | Administrative Capabilities |

#### Distinctive Features to Discuss

| Feature          | Status   | Description                                           |
| ---------------- | -------- | ----------------------------------------------------- |
| Home Spotlight   | Research | Project discovery and quick launch                    |
| Competitive Mode | Research | Competitive mode                                      |
| Pulse            | Research | User activity pulse analysis (OpenAI Pulse reference) |
| Code Wiki        | Research | Project codebase wiki/documentation system            |
