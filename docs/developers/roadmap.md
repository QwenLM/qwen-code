# Qwen Code RoadMap

> **Objective**: Catch up with Claude Code's product functionality, continuously refine details, and enhance user experience.

| Category                        | Phase 1                                                                                                                                                                            | Phase 2                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| User Experience                 | ✅ Terminal UI<br>✅ Support OpenAI Protocol<br>✅ Settings<br>✅ OAuth<br>✅ Cache Control<br>✅ Memory<br>✅ Compress<br>✅ Theme                                                | Better UI<br>OnBoarding<br>LogView<br>✅ Session<br>Permission<br>🔄 Cross-platform Compatibility |
| Coding Workflow                 | ✅ Slash Commands<br>✅ MCP<br>✅ PlanMode<br>✅ TodoWrite<br>✅ SubAgent<br>✅ Multi Model<br>✅ Chat Management<br>✅ Tools (WebFetch, Bash, TextSearch, FileReadFile, EditFile) | 🔄 Hooks<br>SubAgent (enhanced)<br>✅ Skill<br>✅ Headless Mode<br>✅ Tools (WebSearch)           |
| Building Open Capabilities      | ✅ Custom Commands                                                                                                                                                                 | ✅ QwenCode SDK<br> Extension                                                                     |
| Integrating Community Ecosystem |                                                                                                                                                                                    | ✅ VSCode Plugin<br>🔄 ACP/Zed<br>✅ GHA                                                          |
| Administrative Capabilities     | ✅ Stats<br>✅ Feedback                                                                                                                                                            | Costs<br>Dashboard                                                                                |

> For more details, please see the list below.

## Features

#### Completed Features

| Feature                 | Version   | Description                                             | Category                        |
| ----------------------- | --------- | ------------------------------------------------------- | ------------------------------- |
| Skill                   | `V0.6.0`  | Extensible custom AI skills                             | Coding Workflow                 |
| Github Actions          | `V0.5.0`  | qwen-code-action and automation                         | Integrating Community Ecosystem |
| VSCode Plugin           | `V0.5.0`  | VSCode extension plugin                                 | Integrating Community Ecosystem |
| QwenCode SDK            | `V0.4.0`  | Open SDK for third-party integration                    | Building Open Capabilities      |
| Session                 | `V0.4.0`  | Enhanced session management                             | User Experience                 |
| i18n                    | `V0.3.0`  | Internationalization and multilingual support           | User Experience                 |
| Headless Mode           | `V0.3.0`  | Headless mode (non-interactive)                         | Coding Workflow                 |
| ACP/Zed                 | `V0.2.0`  | ACP and Zed editor integration                          | Integrating Community Ecosystem |
| Terminal UI             | `V0.1.0+` | Interactive terminal user interface                     | User Experience                 |
| Settings                | `V0.1.0+` | Configuration management system                         | User Experience                 |
| Theme                   | `V0.1.0+` | Multi-theme support                                     | User Experience                 |
| Support OpenAI Protocol | `V0.1.0+` | Support for OpenAI API protocol                         | User Experience                 |
| Chat Management         | `V0.1.0+` | Session management (save, restore, browse)              | Coding Workflow                 |
| MCP                     | `V0.1.0+` | Model Context Protocol integration                      | Coding Workflow                 |
| Multi Model             | `V0.1.0+` | Multi-model support and switching                       | Coding Workflow                 |
| Slash Commands          | `V0.1.0+` | Slash command system                                    | Coding Workflow                 |
| Tool: Bash              | `V0.1.0+` | Shell command execution tool (with is_background param) | Coding Workflow                 |
| Tool: FileRead/EditFile | `V0.1.0+` | File read/write and edit tools                          | Coding Workflow                 |
| Custom Commands         | `V0.1.0+` | Custom command loading                                  | Building Open Capabilities      |
| Feedback                | `V0.1.0+` | Feedback mechanism (/bug command)                       | Administrative Capabilities     |
| Stats                   | `V0.1.0+` | Usage statistics and quota display                      | Administrative Capabilities     |
| Memory                  | `V0.0.9+` | Project-level and global memory management              | User Experience                 |
| Cache Control           | `V0.0.9+` | DashScope cache control                                 | User Experience                 |
| PlanMode                | `V0.0.14` | Task planning mode                                      | Coding Workflow                 |
| Compress                | `V0.0.11` | Chat compression mechanism                              | User Experience                 |
| SubAgent                | `V0.0.11` | Dedicated sub-agent system                              | Coding Workflow                 |
| TodoWrite               | `V0.0.10` | Task management and progress tracking                   | Coding Workflow                 |
| Tool: TextSearch        | `V0.0.8+` | Text search tool (grep, supports .qwenignore)           | Coding Workflow                 |
| Tool: WebFetch          | `V0.0.7+` | Web content fetching tool                               | Coding Workflow                 |
| Tool: WebSearch         | `V0.0.7+` | Web search tool (using Tavily API)                      | Coding Workflow                 |
| OAuth                   | `V0.0.5+` | OAuth login authentication (Qwen OAuth)                 | User Experience                 |

#### Features to Develop

| Feature                      | Priority | Status      | Description                       | Category                    |
| ---------------------------- | -------- | ----------- | --------------------------------- | --------------------------- |
| Better UI                    | P1       | Planned     | Optimized terminal UI interaction | User Experience             |
| OnBoarding                   | P1       | Planned     | New user onboarding flow          | User Experience             |
| Permission                   | P1       | Planned     | Permission system optimization    | User Experience             |
| Cross-platform Compatibility | P1       | In Progress | Windows/Linux/macOS compatibility | User Experience             |
| LogView                      | P2       | Planned     | Log viewing and debugging feature | User Experience             |
| Hooks                        | P2       | In Progress | Extension hooks system            | Coding Workflow             |
| Extension                    | P2       | Planned     | Extension system                  | Building Open Capabilities  |
| Costs                        | P2       | Planned     | Cost tracking and analysis        | Administrative Capabilities |
| Dashboard                    | P2       | Planned     | Management dashboard              | Administrative Capabilities |

#### Distinctive Features to Discuss

| Feature          | Status   | Description                                           |
| ---------------- | -------- | ----------------------------------------------------- |
| Home Spotlight   | Research | Project discovery and quick launch                    |
| Competitive Mode | Research | Competitive mode                                      |
| Pulse            | Research | User activity pulse analysis (OpenAI Pulse reference) |
| Code Wiki        | Research | Project codebase wiki/documentation system            |
