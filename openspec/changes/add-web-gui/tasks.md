# Implementation Tasks

## 1. Infrastructure Setup

- [x] 1.1 Create `packages/web-app` package with proper configuration
- [x] 1.2 Set up Vite build configuration for frontend
- [x] 1.3 Configure Express/Fastify server with TypeScript
- [x] 1.4 Set up WebSocket server infrastructure
- [x] 1.5 Configure workspace dependencies and build scripts

## 2. Backend API Development

- [x] 2.1 Implement session management API routes
  - [x] GET /api/sessions - List all sessions
  - [x] POST /api/sessions - Create new session
  - [x] GET /api/sessions/:id - Get session details
  - [x] DELETE /api/sessions/:id - Delete session
- [x] 2.2 Implement config API routes
  - [x] GET /api/config - Get current configuration
  - [x] PUT /api/config - Update configuration
- [x] 2.3 Implement WebSocket message handler
  - [x] Handle incoming user messages
  - [x] **AI Integration: Stream real AI responses** (basic implementation done)
  - [x] Handle permission requests/responses
  - [ ] Implement session status broadcasting

## 3. Frontend Application

- [x] 3.1 Create main App component with layout structure
- [x] 3.2 Implement Sidebar component
  - [x] Session list with date grouping
  - [x] Search functionality
  - [x] New session creation
  - [ ] **Theme toggle button**
- [x] 3.3 Implement ChatArea component
  - [x] Message list display
  - [x] Auto-scroll behavior
  - [ ] **Context usage indicator**
- [x] 3.4 Integrate existing webui components
  - [x] ChatViewer / Message components
  - [ ] **Use webui InputForm component** (currently using custom textarea)
  - [ ] **ToolCall components integration**
  - [x] PermissionDrawer component (basic modal)
- [x] 3.5 Implement WebSocket client hooks
  - [x] useWebSocket hook for connection management
  - [x] Message state management
  - [x] Reconnection handling
- [ ] **3.6 Implement Settings panel**
  - [ ] Theme settings (Light/Dark/System)
  - [ ] Model configuration
  - [ ] Other preferences

## 4. CLI Integration

- [x] 4.1 Create `/web` command handler
- [x] 4.2 Implement server startup logic
  - [x] Port availability check
  - [x] Auto port increment on conflict
  - [x] Browser auto-open functionality
- [x] 4.3 Register command in BuiltinCommandLoader
- [x] 4.4 Add command-line argument parsing (--port, --host, --no-open)

## 5. Core Integration (AI Model)

- [ ] **5.1 Create session runner bridge**
  - [ ] Start/stop session processes
  - [ ] Message routing between WebSocket and Core
  - [ ] Integrate with GeminiClient/ModelClient
- [ ] **5.2 Implement permission request flow**
  - [ ] Tool execution approval
  - [ ] Shell command approval
- [ ] **5.3 Handle tool call execution and streaming**
  - [ ] Real-time tool call status updates
  - [ ] Tool result display

## 6. Testing

- [ ] 6.1 Unit tests for API routes
- [ ] 6.2 Unit tests for WebSocket handler
- [ ] 6.3 Component tests for frontend
- [ ] 6.4 Integration tests for full flow
- [ ] 6.5 E2E tests for critical user journeys

## 7. Documentation

- [ ] 7.1 Update CLI documentation with /web command
- [ ] 7.2 Add Web GUI user guide
- [ ] 7.3 Add developer documentation for web-app package

---

## Summary of Remaining Work

### High Priority (Core Functionality)
1. **AI Model Integration** - Connect WebSocket to actual AI model for real responses
2. **Tool Call Streaming** - Display tool calls in real-time

### Medium Priority (UI Enhancement)
3. **Settings Panel** - Theme and configuration management
4. **InputForm Integration** - Use webui InputForm component
5. **Context Indicator** - Show context usage percentage

### Lower Priority (Polish)
6. **Theme Toggle** - Light/dark mode support
7. **Testing** - Comprehensive test coverage
8. **Documentation** - User and developer guides
