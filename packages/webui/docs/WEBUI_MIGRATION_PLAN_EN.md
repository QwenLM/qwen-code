# WebUI Component Library Extraction Plan

## 1. Background and Goals

### 1.1 Background

`packages/vscode-ide-companion` is a VSCode extension whose core content is a WebView page with UI components provided by React. As the product line expands, more scenarios require building products with Web UI:

- **Chrome Browser Extension** - Sidebar chat interface
- **Web Chat Page** - Pure web application
- **Conversation Share Page** - Render conversations as static HTML

For excellent software engineering architecture, we need to unify and reuse UI components across products.

### 1.2 Goals

1. Extract components from `vscode-ide-companion/src/webview/` into an independent `@qwen-code/webui` package
2. Establish a layered architecture: Pure UI components + Business UI components
3. Use Vite + Storybook for development and component showcase
4. Abstract platform capabilities through Platform Context for cross-platform reuse
5. Provide Tailwind CSS preset to ensure UI consistency across products

---

## 2. Current State Analysis

### 2.1 Current Code Structure

`packages/vscode-ide-companion/src/webview/` contains 77 files:

```
webview/
├── App.tsx                    # Main entry
├── components/
│   ├── icons/                 # 8 icon components
│   ├── layout/                # 8 layout components
│   │   ├── ChatHeader.tsx
│   │   ├── InputForm.tsx
│   │   ├── SessionSelector.tsx
│   │   ├── EmptyState.tsx
│   │   ├── Onboarding.tsx
│   │   └── ...
│   ├── messages/              # Message display components
│   │   ├── UserMessage.tsx
│   │   ├── Assistant/
│   │   ├── MarkdownRenderer/
│   │   ├── ThinkingMessage.tsx
│   │   ├── Waiting/
│   │   └── toolcalls/         # 16 tool call components
│   ├── PermissionDrawer/      # Permission request drawer
│   └── Tooltip.tsx
├── hooks/                     # Custom hooks
├── handlers/                  # Message handlers
├── styles/                    # CSS styles
└── utils/                     # Utility functions
```

### 2.2 Key Dependency Analysis

**Platform Coupling Points:**

- `useVSCode` hook - Calls `acquireVsCodeApi()` for message communication
- `handlers/` - Handles VSCode message protocol
- Some type definitions come from `../types/` directory

```
┌─────────────────────────────────────────────────────────┐
│                    App.tsx (Entry)                       │
├─────────────────────────────────────────────────────────┤
│  hooks/          │  handlers/       │  components/      │
│  ├─useVSCode ◄───┼──────────────────┼──────────────────┤
│  ├─useSession    │  ├─MessageRouter │  ├─icons/        │
│  ├─useFileContext│  ├─AuthHandler   │  ├─layout/       │
│  └─...           │  └─...           │  ├─messages/     │
│                  │                  │  └─PermDrawer/   │
├─────────────────────────────────────────────────────────┤
│            VSCode API (acquireVsCodeApi)                │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Target Architecture

### 3.1 Layered Architecture Design

```
┌─────────────────────────────────────────────────────────┐
│              Layer 3: Platform Adapters                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│  │VSCode Adapter│ │Chrome Adapter│ │ Web Adapter  │    │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘    │
├─────────┼────────────────┼────────────────┼────────────┤
│         │                │                │             │
│         ▼                ▼                ▼             │
│  ┌─────────────────────────────────────────────────┐   │
│  │           Platform Context Provider              │   │
│  └─────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│              Layer 2: Chat Components                   │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐          │
│  │ MessageList│ │ ChatHeader │ │ InputForm  │          │
│  └────────────┘ └────────────┘ └────────────┘          │
├─────────────────────────────────────────────────────────┤
│              Layer 1: Primitives (Pure UI)              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │
│  │ Button │ │ Input  │ │ Icons  │ │Tooltip │          │
│  └────────┘ └────────┘ └────────┘ └────────┘          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Platform Context Design

```typescript
// @qwen-code/webui/src/context/PlatformContext.ts
interface PlatformContext {
  // Message communication
  postMessage: (message: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => () => void;

  // File operations
  openFile?: (path: string) => void;
  attachFile?: () => void;

  // Authentication
  login?: () => void;

  // Platform info
  platform: 'vscode' | 'chrome' | 'web' | 'share';
}
```

---

## 4. Technical Solution

### 4.1 Build Configuration (Vite Library Mode)

**Output formats:**

- ESM (`dist/index.js`) - Primary format
- CJS (`dist/index.cjs`) - Compatibility
- TypeScript declarations (`dist/index.d.ts`)

```javascript
// vite.config.ts
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
    },
  },
});
```

### 4.2 Tailwind Preset Solution

```javascript
// @qwen-code/webui/tailwind.preset.js
module.exports = {
  theme: {
    extend: {
      colors: {
        'app-primary': 'var(--app-primary)',
        'app-background': 'var(--app-primary-background)',
        'app-foreground': 'var(--app-primary-foreground)',
      },
    },
  },
};

// Consumer's tailwind.config.js
module.exports = {
  presets: [require('@qwen-code/webui/tailwind.preset')],
  content: [
    './src/**/*.{ts,tsx}',
    './node_modules/@qwen-code/webui/dist/**/*.js',
  ],
};
```

### 4.3 Storybook Configuration

```
packages/webui/
├── .storybook/
│   ├── main.ts      # Storybook config
│   ├── preview.ts   # Global decorators
│   └── manager.ts   # UI config
└── src/
    └── stories/     # Story files
```

---

## 5. Component Migration Classification

### 5.1 Batch 1: No-dependency Components (Ready to migrate)

| Component          | Source Path              | Complexity | Notes                       |
| ------------------ | ------------------------ | ---------- | --------------------------- |
| Icons              | `components/icons/`      | Low        | 8 icon components, pure SVG |
| Tooltip            | `components/Tooltip.tsx` | Low        | Pure UI                     |
| WaitingMessage     | `messages/Waiting/`      | Low        | Loading state display       |
| InterruptedMessage | `messages/Waiting/`      | Low        | Interrupted state display   |

### 5.2 Batch 2: Light-dependency Components (Need props abstraction)

| Component        | Source Path                    | Dependency  | Refactoring      |
| ---------------- | ------------------------------ | ----------- | ---------------- |
| UserMessage      | `messages/UserMessage.tsx`     | onFileClick | Props injection  |
| AssistantMessage | `messages/Assistant/`          | onFileClick | Props injection  |
| ThinkingMessage  | `messages/ThinkingMessage.tsx` | onFileClick | Props injection  |
| MarkdownRenderer | `messages/MarkdownRenderer/`   | None        | Direct migration |
| EmptyState       | `layout/EmptyState.tsx`        | None        | Direct migration |
| ChatHeader       | `layout/ChatHeader.tsx`        | callbacks   | Props injection  |

### 5.3 Batch 3: Medium-dependency Components (Need Context)

| Component           | Source Path                  | Dependency            | Refactoring       |
| ------------------- | ---------------------------- | --------------------- | ----------------- |
| InputForm           | `layout/InputForm.tsx`       | Multiple callbacks    | Context + Props   |
| SessionSelector     | `layout/SessionSelector.tsx` | session data          | Props injection   |
| CompletionMenu      | `layout/CompletionMenu.tsx`  | items data            | Props injection   |
| PermissionDrawer    | `PermissionDrawer/`          | callbacks             | Context + Props   |
| ToolCall components | `messages/toolcalls/`        | Various tool displays | Modular migration |

### 5.4 Batch 4: Heavy-dependency (Keep in platform package)

| Component/Module | Notes                                             |
| ---------------- | ------------------------------------------------- |
| App.tsx          | Main entry, contains business orchestration logic |
| hooks/           | Most require platform adaptation                  |
| handlers/        | VSCode message handling                           |
| Onboarding       | Authentication related, platform-specific         |

---

## 6. Incremental Migration Strategy

### 6.1 Migration Principles

1. **Bidirectional compatibility**: During migration, vscode-ide-companion can import from both webui and local
2. **One-by-one replacement**: For each migrated component, replace import path in VSCode extension and verify
3. **No breaking changes**: Ensure the extension builds and runs normally after each migration

### 6.2 Migration Workflow

```
Developer ──► @qwen-code/webui ──► vscode-ide-companion
  │              │                      │
  │   1. Copy component to webui        │
  │   2. Add Story for verification     │
  │   3. Export from index.ts           │
  │              │                      │
  │              └──────────────────────┤
  │                                     │
  │                      4. Update import path
  │                      5. Delete original component
  │                      6. Build and test
```

### 6.3 Example: Migrating Icons

```typescript
// Before: vscode-ide-companion/src/webview/components/icons/index.ts
export { FileIcon } from './FileIcons.js';

// After: Update import
import { FileIcon } from '@qwen-code/webui';
// or import { FileIcon } from '@qwen-code/webui/icons';
```

---

## 7. Task Breakdown

### Phase 0: Infrastructure Setup (Prerequisites)

- [ ] **T0-1**: Vite build configuration
- [ ] **T0-2**: Storybook configuration
- [ ] **T0-3**: Tailwind preset creation
- [ ] **T0-4**: Platform Context definition
- [ ] **T0-5**: Shared types migration

### Phase 1: Pure UI Components Migration

- [ ] **T1-1**: Icons components migration (8 files)
- [ ] **T1-2**: Tooltip component migration
- [ ] **T1-3**: WaitingMessage / InterruptedMessage migration
- [ ] **T1-4**: Basic Button/Input components refinement

### Phase 2: Message Components Migration

- [ ] **T2-1**: MarkdownRenderer migration
- [ ] **T2-2**: UserMessage migration
- [ ] **T2-3**: AssistantMessage migration
- [ ] **T2-4**: ThinkingMessage migration

### Phase 3: Layout Components Migration

- [ ] **T3-1**: ChatHeader migration
- [ ] **T3-2**: EmptyState migration
- [ ] **T3-3**: InputForm migration (requires Context)
- [ ] **T3-4**: SessionSelector migration
- [ ] **T3-5**: CompletionMenu migration

### Phase 4: Complex Components Migration

- [ ] **T4-1**: PermissionDrawer migration
- [ ] **T4-2**: ToolCall series components migration (16 files)

### Phase 5: Platform Adapters

- [ ] **T5-1**: VSCode Adapter implementation
- [ ] **T5-2**: Chrome Extension Adapter
- [ ] **T5-3**: Web/Share Page Adapter

---

## 8. Risks and Considerations

### 8.1 Common Pitfalls

1. **Tailwind Class Name Tree Shaking**
   - Problem: Tailwind class names may be removed after library bundling
   - Solution: Consumer's `content` config needs to include `node_modules/@qwen-code/webui`

2. **CSS Variable Scope**
   - Problem: Variables like `var(--app-primary)` need to be defined by consumers
   - Solution: Provide default CSS variables file, or define fallbacks in Tailwind preset

3. **React Version Compatibility**
   - Current vscode-ide-companion uses React 19, webui's peerDependencies is React 18
   - Need to update peerDependencies to `"react": "^18.0.0 || ^19.0.0"`

4. **ESM/CJS Compatibility**
   - VSCode extensions may require CJS format
   - Vite needs to be configured for dual format output

### 8.2 Industry References

- **Radix UI**: Pure Headless components, styles completely controlled by consumers
- **shadcn/ui**: Copy components into project, rather than importing as dependency
- **Ant Design**: Complete component library, customization through ConfigProvider

### 8.3 Acceptance Criteria

Each migration task completion requires:

1. Component has corresponding Storybook Story
2. Import in vscode-ide-companion has been updated
3. Extension builds successfully (`npm run build:vscode`)
4. Extension functionality works (manual testing or existing tests pass)

---

## 9. Time Estimation

| Phase   | Tasks | Estimated Days | Parallelizable |
| ------- | ----- | -------------- | -------------- |
| Phase 0 | 5     | 2-3 days       | Partially      |
| Phase 1 | 4     | 1-2 days       | Fully          |
| Phase 2 | 4     | 2-3 days       | Fully          |
| Phase 3 | 5     | 3-4 days       | Partially      |
| Phase 4 | 2     | 3-4 days       | Yes            |
| Phase 5 | 3     | 2-3 days       | Yes            |

**Total**: Approximately 13-19 person-days (sequential execution), can be reduced to 1-2 weeks with parallel work

---

## 10. Development and Debugging Workflow

### 10.1 Component Development Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Development Workflow                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Develop/Modify Component                                     │
│     └── Edit files in @qwen-code/webui/src/                     │
│                                                                  │
│  2. Debug with Storybook                                         │
│     └── npm run storybook (port 6006)                           │
│     └── View component in isolation                              │
│     └── Test different props/states                              │
│                                                                  │
│  3. Build Library                                                │
│     └── npm run build                                            │
│     └── Outputs: dist/index.js, dist/index.cjs, dist/index.d.ts │
│                                                                  │
│  4. Use in VSCode Extension                                      │
│     └── import { Component } from '@qwen-code/webui'            │
│     └── No UI code modifications in vscode-ide-companion        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 10.2 Debugging Commands

```bash
# Start Storybook for component development
cd packages/webui
npm run storybook

# Watch mode for library development
npm run dev

# Build library for production
npm run build

# Type checking
npm run typecheck
```

### 10.3 Key Principles

1. **Single Source of Truth**: All UI components live in `@qwen-code/webui`
2. **Storybook First**: Debug and validate components in Storybook before integration
3. **No UI Code in Consumers**: `vscode-ide-companion` only imports and uses components
4. **Platform Abstraction**: Use `PlatformContext` for platform-specific behaviors
