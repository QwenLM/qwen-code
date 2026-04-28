# Qwen Code Component Inventory

## Overview

This document catalogs all UI components and their purposes across Qwen Code packages. Components are organized by package and category.

## CLI Package Components (`packages/cli/src/ui/components/`)

### Layout Components

| Component          | File                   | Purpose                          |
| ------------------ | ---------------------- | -------------------------------- |
| `MainContent`      | `MainContent.tsx`      | Main container for CLI content   |
| `Header`           | `Header.tsx`           | Application header with branding |
| `Footer`           | `Footer.tsx`           | Footer with keyboard shortcuts   |
| `DialogManager`    | `DialogManager.tsx`    | Manages modal dialogs            |
| `WebviewContainer` | `WebviewContainer.tsx` | Container for webview content    |

### Chat & Messages

| Component                 | File                          | Purpose                        |
| ------------------------- | ----------------------------- | ------------------------------ |
| `Composer`                | `Composer.tsx`                | Message input composer         |
| `HistoryItemDisplay`      | `HistoryItemDisplay.tsx`      | Displays conversation history  |
| `DetailedMessagesDisplay` | `DetailedMessagesDisplay.tsx` | Shows detailed message content |
| `QueuedMessageDisplay`    | `QueuedMessageDisplay.tsx`    | Displays queued messages       |
| `SuggestionsDisplay`      | `SuggestionsDisplay.tsx`      | Shows AI suggestions           |
| `TodoDisplay`             | `TodoDisplay.tsx`             | Displays todo list from AI     |

### Input & Prompts

| Component            | File                     | Purpose             |
| -------------------- | ------------------------ | ------------------- |
| `InputPrompt`        | `InputPrompt.tsx`        | Text input prompt   |
| `ShellInputPrompt`   | `ShellInputPrompt.tsx`   | Shell command input |
| `SettingInputPrompt` | `SettingInputPrompt.tsx` | Setting value input |
| `ConsentPrompt`      | `ConsentPrompt.tsx`      | User consent dialog |
| `PluginChoicePrompt` | `PluginChoicePrompt.tsx` | Plugin selection    |
| `OpenAIKeyPrompt`    | `OpenAIKeyPrompt.tsx`    | API key input       |
| `QwenOAuthProgress`  | `QwenOAuthProgress.tsx`  | OAuth flow progress |

### Dialogs

| Component                      | File                               | Purpose                   |
| ------------------------------ | ---------------------------------- | ------------------------- |
| `SettingsDialog`               | `SettingsDialog.tsx`               | Application settings      |
| `ModelDialog`                  | `ModelDialog.tsx`                  | Model selection           |
| `ThemeDialog`                  | `ThemeDialog.tsx`                  | Theme selection           |
| `ModelSwitchDialog`            | `ModelSwitchDialog.tsx`            | Switch model dialog       |
| `EditorSettingsDialog`         | `EditorSettingsDialog.tsx`         | Editor settings           |
| `FolderTrustDialog`            | `FolderTrustDialog.tsx`            | Trust folder dialog       |
| `IdeTrustChangeDialog`         | `IdeTrustChangeDialog.tsx`         | IDE trust changes         |
| `PermissionsModifyTrustDialog` | `PermissionsModifyTrustDialog.tsx` | Modify permissions        |
| `ApprovalModeDialog`           | `ApprovalModeDialog.tsx`           | Approval mode settings    |
| `LoopDetectionConfirmation`    | `LoopDetectionConfirmation.tsx`    | Confirm loop break        |
| `ShellConfirmationDialog`      | `ShellConfirmationDialog.tsx`      | Shell command approval    |
| `ConfigInitDisplay`            | `ConfigInitDisplay.tsx`            | Config initialization     |
| `QuittingDisplay`              | `QuittingDisplay.tsx`              | Quit confirmation         |
| `ExitWarning`                  | `ExitWarning.tsx`                  | Exit warning dialog       |
| `WelcomeBackDialog`            | `WelcomeBackDialog.tsx`            | Welcome back message      |
| `SessionPicker`                | `SessionPicker.tsx`                | Pick existing session     |
| `StandaloneSessionPicker`      | `StandaloneSessionPicker.tsx`      | Standalone session picker |

### Display Components

| Component               | File                        | Purpose               |
| ----------------------- | --------------------------- | --------------------- |
| `AnsiOutput`            | `AnsiOutput.tsx`            | ANSI colored output   |
| `ConsoleSummaryDisplay` | `ConsoleSummaryDisplay.tsx` | Console summary       |
| `ContextSummaryDisplay` | `ContextSummaryDisplay.tsx` | Context summary       |
| `ContextUsageDisplay`   | `ContextUsageDisplay.tsx`   | Context usage metrics |
| `MemoryUsageDisplay`    | `MemoryUsageDisplay.tsx`    | Memory metrics        |
| `ModelStatsDisplay`     | `ModelStatsDisplay.tsx`     | Model statistics      |
| `SessionSummaryDisplay` | `SessionSummaryDisplay.tsx` | Session summary       |
| `StatsDisplay`          | `StatsDisplay.tsx`          | General statistics    |
| `ToolStatsDisplay`      | `ToolStatsDisplay.tsx`      | Tool usage stats      |
| `DebugProfiler`         | `DebugProfiler.tsx`         | Debug profiler view   |
| `PlanSummaryDisplay`    | `PlanSummaryDisplay.tsx`    | Plan mode summary     |
| `AboutBox`              | `AboutBox.tsx`              | About application     |
| `Notifications`         | `Notifications.tsx`         | Notification center   |

### Status Indicators

| Component                 | File                          | Purpose                |
| ------------------------- | ----------------------------- | ---------------------- |
| `Header`                  | `Header.tsx`                  | App header with status |
| `AutoAcceptIndicator`     | `AutoAcceptIndicator.tsx`     | Auto-accept status     |
| `LoadingIndicator`        | `LoadingIndicator.tsx`        | Loading spinner        |
| `GeminiRespondingSpinner` | `GeminiRespondingSpinner.tsx` | AI response spinner    |
| `ShellModeIndicator`      | `ShellModeIndicator.tsx`      | Shell mode indicator   |
| `UpdateNotification`      | `UpdateNotification.tsx`      | Update available       |
| `Tips`                    | `Tips.tsx`                    | Helpful tips           |

### Help & Documentation

| Component           | File                    | Purpose             |
| ------------------- | ----------------------- | ------------------- |
| `Help`              | `Help.tsx`              | Help documentation  |
| `KeyboardShortcuts` | `KeyboardShortcuts.tsx` | Shortcuts reference |
| `ShowMoreLines`     | `ShowMoreLines.tsx`     | Show more content   |

### Specialized Views

| Component          | File                   | Purpose               |
| ------------------ | ---------------------- | --------------------- |
| `PermissionDrawer` | `PermissionDrawer.tsx` | Permission management |
| `AsciiArt`         | `AsciiArt.ts`          | ASCII art display     |

### Sub-agent Components

| Component               | File              | Purpose           |
| ----------------------- | ----------------- | ----------------- |
| `SubagentItemDisplay`   | `subagents/*.tsx` | Sub-agent display |
| `SubagentResultDisplay` | `subagents/*.tsx` | Sub-agent results |

### Chat-specific Components

| Component     | File               | Purpose             |
| ------------- | ------------------ | ------------------- |
| `ChatViewer`  | `ChatViewer/`      | Chat message viewer |
| `ChatMessage` | `ChatViewer/*.tsx` | Individual messages |
| `toolcalls/`  | `toolcalls/`       | Tool call displays  |

### Icon Components

| Component | File     | Purpose         |
| --------- | -------- | --------------- |
| `Icons`   | `icons/` | Icon components |

## WebUI Package Components (`packages/webui/src/components/`)

### Layout Components

| Component   | Category | Purpose               |
| ----------- | -------- | --------------------- |
| `Layout`    | Layout   | Main layout container |
| `Container` | Layout   | Content container     |
| `Stack`     | Layout   | Vertical stack layout |
| `Flex`      | Layout   | Flexbox layout        |
| `Grid`      | Layout   | Grid layout           |

### Form Components

| Component           | Category | Purpose               |
| ------------------- | -------- | --------------------- |
| `Button`            | Forms    | Action button         |
| `Input`             | Forms    | Text input            |
| `Textarea`          | Forms    | Multi-line input      |
| `Select`            | Forms    | Dropdown selection    |
| `Checkbox`          | Forms    | Checkbox input        |
| `Radio`             | Forms    | Radio button          |
| `Switch`            | Forms    | Toggle switch         |
| `Label`             | Forms    | Input label           |
| `FormGroup`         | Forms    | Form field group      |
| `ValidationMessage` | Forms    | Error/success message |

### Display Components

| Component   | Category | Purpose              |
| ----------- | -------- | -------------------- |
| `Avatar`    | Display  | User avatar          |
| `Badge`     | Display  | Status badge         |
| `Card`      | Display  | Card container       |
| `Table`     | Display  | Data table           |
| `List`      | Display  | List component       |
| `Tabs`      | Display  | Tab navigation       |
| `Accordion` | Display  | Collapsible sections |
| `Tooltip`   | Display  | Hover tooltip        |
| `Popover`   | Display  | Popover content      |
| `Spinner`   | Display  | Loading spinner      |
| `Progress`  | Display  | Progress bar         |
| `Skeleton`  | Display  | Loading skeleton     |

### Navigation Components

| Component    | Category   | Purpose          |
| ------------ | ---------- | ---------------- |
| `Nav`        | Navigation | Navigation menu  |
| `Breadcrumb` | Navigation | Breadcrumb trail |
| `Pagination` | Navigation | Page navigation  |
| `TabNav`     | Navigation | Tab-based nav    |

### Chat Components

| Component       | Category | Purpose            |
| --------------- | -------- | ------------------ |
| `ChatWindow`    | Chat     | Chat interface     |
| `MessageList`   | Chat     | Message container  |
| `MessageInput`  | Chat     | Message input      |
| `MessageBubble` | Chat     | Message bubble     |
| `CodeBlock`     | Chat     | Code display       |
| `Markdown`      | Chat     | Markdown rendering |

### Icons

| Component     | Category | Purpose        |
| ------------- | -------- | -------------- |
| `Icon`        | Icons    | Base icon      |
| `IconButton`  | Icons    | Icon as button |
| `ChevronDown` | Icons    | Chevron down   |
| `ChevronUp`   | Icons    | Chevron up     |
| `Check`       | Icons    | Checkmark      |
| `X`           | Icons    | Close/cancel   |
| `Plus`        | Icons    | Add            |
| `Search`      | Icons    | Search         |
| `Settings`    | Icons    | Settings       |
| `User`        | Icons    | User           |
| `Send`        | Icons    | Send message   |

### Modal Components

| Component | Category | Purpose             |
| --------- | -------- | ------------------- |
| `Modal`   | Modal    | Base modal          |
| `Dialog`  | Modal    | Confirmation dialog |
| `Alert`   | Modal    | Alert message       |
| `Drawer`  | Modal    | Slide-out panel     |

## VS Code Extension Components (`packages/vscode-ide-companion/src/`)

| Component      | Purpose                    |
| -------------- | -------------------------- |
| `extension.ts` | Extension entry point      |
| `server/`      | Express server for webview |
| `webview/`     | Webview UI components      |

## SDK TypeScript Components (`packages/sdk-typescript/src/`)

| Component    | Purpose            |
| ------------ | ------------------ |
| `QwenClient` | Main SDK client    |
| `Session`    | Session management |
| `Tool`       | Tool definitions   |
| `Message`    | Message handling   |
| `Config`     | Configuration      |

## Data Models (`packages/core/src/models/`)

| Model         | Purpose                |
| ------------- | ---------------------- |
| `Message`     | Chat message structure |
| `ContextFile` | Context file reference |
| `ToolCall`    | Tool invocation        |
| `ToolResult`  | Tool execution result  |
| `Session`     | Session state          |
| `Config`      | Configuration schema   |

## Tool Components (`packages/core/src/tools/`)

| Tool         | Purpose                 |
| ------------ | ----------------------- |
| `file-ops`   | File read/write/edit    |
| `bash`       | Shell command execution |
| `glob`       | File pattern matching   |
| `grep`       | Content search          |
| `fetch`      | HTTP GET requests       |
| `web-search` | Web search              |
| `mcp`        | MCP server tools        |

## Component Patterns

### React Hooks

| Hook         | Package | Purpose               |
| ------------ | ------- | --------------------- |
| `useChat`    | CLI     | Chat state management |
| `useSession` | Core    | Session lifecycle     |
| `useConfig`  | Shared  | Configuration access  |
| `useTheme`   | WebUI   | Theme management      |
| `useTools`   | Core    | Tool registration     |

### Shared Utilities

| Utility          | Package | Purpose              |
| ---------------- | ------- | -------------------- |
| `formatMessage`  | CLI     | Message formatting   |
| `parseCommand`   | CLI     | Command parsing      |
| `validateConfig` | Core    | Config validation    |
| `generateId`     | Core    | Unique ID generation |

## Component Dependencies

### CLI → WebUI

```typescript
// CLI imports WebUI components
import { Button, Input, Modal } from '@qwen-code/webui';
```

### Core → Models

```typescript
// Core uses models for type safety
import { Message, ToolCall, Session } from '../models/';
```

### SDK → Core

```typescript
// SDK wraps Core functionality
import { QwenClient } from '@qwen-code/sdk';
```

## State Management

### Local State (React)

```typescript
// Component-level state
const [count, setCount] = useState(0);
```

### Shared State

#### Currently Used

| Solution      | Use Case                 |
| ------------- | ------------------------ |
| React Context | Theme, config, user auth |

#### Potential Options _(not currently used in this repo)_

| Library       | Typical Use Case         |
| ------------- | ------------------------ |
| React Query   | Server state, caching    |
| Zustand       | Global UI state          |
| Redux         | Complex session state    |

### Persistence

| Data     | Storage               | Package |
| -------- | --------------------- | ------- |
| Settings | JSON files (~/.qwen/) | CLI     |
| Sessions | Local storage         | CLI     |
| History  | IndexedDB             | Core    |

## Design System

### Styling Approach

| Package | Styling                  |
| ------- | ------------------------ |
| CLI     | Inline styles + Tailwind |
| WebUI   | Tailwind CSS             |
| VS Code | VS Code theme API        |

### Tailwind Configuration

```javascript
// packages/webui/tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: '#...',
        secondary: '#...',
      },
    },
  },
};
```

## Component Testing

### Test Structure

```
Component/
├── Component.tsx
├── Component.test.tsx
└── Component.stories.tsx  (Storybook)
```

### Testing Strategy

| Level       | Framework                      | Examples            |
| ----------- | ------------------------------ | ------------------- |
| Unit        | Vitest + React Testing Library | Component rendering |
| Integration | Vitest                         | User flows          |
| Visual      | Storybook + Chromatic          | UI consistency      |

## Related Documentation

- [Architecture Overview](./architecture.md)
- [Development Guide](./development-guide.md)
- [SDK TypeScript Documentation](./sdk-typescript.md)
- [WebUI Storybook](http://localhost:6006) (local)
