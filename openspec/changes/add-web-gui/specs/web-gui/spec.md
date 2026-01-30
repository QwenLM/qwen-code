## ADDED Requirements

### Requirement: Web Command

The CLI SHALL provide a `/web` slash command that starts a local HTTP server to serve the Web GUI.

#### Scenario: Default startup
- **WHEN** user executes `/web` command without arguments
- **THEN** system SHALL start HTTP server on `127.0.0.1:5494`
- **AND** system SHALL automatically open the default browser to the server URL
- **AND** CLI SHALL display startup information including URL and port

#### Scenario: Custom port
- **WHEN** user executes `/web --port 8080`
- **THEN** system SHALL start HTTP server on port 8080
- **AND** if port 8080 is unavailable, system SHALL try subsequent ports

#### Scenario: LAN access
- **WHEN** user executes `/web --host 0.0.0.0`
- **THEN** system SHALL bind to all network interfaces
- **AND** system SHALL display a warning about LAN exposure

#### Scenario: Disable browser auto-open
- **WHEN** user executes `/web --no-open`
- **THEN** system SHALL NOT automatically open the browser
- **AND** system SHALL still display the server URL in terminal

---

### Requirement: Session Management API

The Web server SHALL provide REST API endpoints for managing sessions.

#### Scenario: List sessions
- **WHEN** client sends GET request to `/api/sessions`
- **THEN** server SHALL return a list of all sessions
- **AND** each session SHALL include id, title, lastUpdated, and status fields

#### Scenario: Create session
- **WHEN** client sends POST request to `/api/sessions`
- **THEN** server SHALL create a new session in the existing storage location
- **AND** server SHALL return the created session details
- **AND** session SHALL be immediately available for use

#### Scenario: Get session details
- **WHEN** client sends GET request to `/api/sessions/:id`
- **THEN** server SHALL return full session details including message history
- **AND** if session does not exist, server SHALL return 404 status

---

### Requirement: Real-time Chat Communication

The Web server SHALL provide WebSocket connection for real-time chat communication.

#### Scenario: User sends message
- **WHEN** client sends a message through WebSocket
- **THEN** server SHALL forward the message to the AI model
- **AND** server SHALL stream AI response back to client in real-time
- **AND** server SHALL send tool call events as they occur

#### Scenario: Cancel generation
- **WHEN** client sends cancel request through WebSocket
- **THEN** server SHALL stop the current AI generation
- **AND** server SHALL send confirmation of cancellation to client

#### Scenario: Permission request
- **WHEN** AI requires permission for a sensitive operation
- **THEN** server SHALL send permission request to client via WebSocket
- **AND** server SHALL wait for client response before proceeding
- **AND** client response SHALL be one of: allow_once, allow_session, always_allow, deny

---

### Requirement: Web GUI Layout

The Web GUI SHALL provide a responsive layout with sidebar and main content area.

#### Scenario: Sidebar session list
- **WHEN** user views the Web GUI
- **THEN** sidebar SHALL display list of sessions grouped by date
- **AND** sidebar SHALL include search input for filtering sessions
- **AND** sidebar SHALL include button to create new session
- **AND** current session SHALL be visually highlighted

#### Scenario: Main chat area
- **WHEN** user selects a session
- **THEN** main area SHALL display session title and context usage
- **AND** main area SHALL display message history with user, assistant, and tool call messages
- **AND** main area SHALL auto-scroll to latest message
- **AND** main area SHALL include input form at the bottom

---

### Requirement: Message Display

The Web GUI SHALL display chat messages with appropriate formatting and tool call visualization.

#### Scenario: User message display
- **WHEN** displaying a user message
- **THEN** system SHALL show message content with user styling
- **AND** system SHALL show any attached file contexts

#### Scenario: Assistant message display
- **WHEN** displaying an assistant message
- **THEN** system SHALL render Markdown content
- **AND** system SHALL syntax-highlight code blocks
- **AND** system SHALL make file paths clickable

#### Scenario: Thinking message display
- **WHEN** displaying a thinking message
- **THEN** system SHALL show thinking content in collapsible section
- **AND** section SHALL be collapsed by default
- **AND** user SHALL be able to expand/collapse

#### Scenario: Tool call display
- **WHEN** displaying a tool call
- **THEN** system SHALL show tool name and status indicator
- **AND** system SHALL show tool parameters
- **AND** system SHALL show tool output in collapsible section
- **AND** different tool types SHALL have specialized visualizations

---

### Requirement: Input Form

The Web GUI SHALL provide an input form for composing and sending messages.

#### Scenario: Send message
- **WHEN** user types message and presses Enter
- **THEN** message SHALL be sent to the server
- **AND** input field SHALL be cleared
- **AND** message SHALL appear in chat immediately

#### Scenario: Stop generation
- **WHEN** AI is generating and user clicks stop button
- **THEN** generation SHALL be cancelled
- **AND** partial response SHALL remain visible

#### Scenario: Edit mode toggle
- **WHEN** user clicks edit mode button
- **THEN** system SHALL cycle through available edit modes
- **AND** current mode SHALL be visually indicated

---

### Requirement: Theme Support

The Web GUI SHALL support light and dark themes.

#### Scenario: Theme toggle
- **WHEN** user clicks theme toggle button
- **THEN** system SHALL switch between light and dark themes
- **AND** theme preference SHALL be persisted in local storage

#### Scenario: System theme
- **WHEN** theme is set to system/auto
- **THEN** system SHALL follow OS dark mode preference
- **AND** system SHALL update when OS preference changes
