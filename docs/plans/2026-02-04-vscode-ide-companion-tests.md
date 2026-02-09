# VSCode IDE Companion Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the broken test import and add the missing unit tests called out in `packages/vscode-ide-companion/docs/TESTING_PLAN.md` (InputForm, PermissionDrawer, useSessionManagement, ToolCall).

**Architecture:** Add focused unit tests using Vitest + @testing-library/react + jsdom. Mock @qwen-code/webui where needed to isolate adapter logic and toolcall routing. Keep tests small and deterministic with existing test utils.

**Tech Stack:** React 18, Vitest, @testing-library/react, jsdom.

---

### Task 1: Fix broken PermissionRequest import in useWebViewMessages test

**Files:**

- Modify: `packages/vscode-ide-companion/src/webview/hooks/useWebViewMessages.test.tsx`

**Step 1: Write the failing test**

- No new test needed; this is a compile-time import error.

**Step 2: Run test to verify it fails**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/hooks/useWebViewMessages.test.tsx`
- Expected: FAIL with module not found for `../components/PermissionDrawer/PermissionRequest.js`.

**Step 3: Write minimal implementation**

- Update the import to use the shared webui types:

```ts
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';
```

- Replace the alias:

```ts
ToolCall as PermissionToolCall;
```

with:

```ts
PermissionToolCall;
```

**Step 4: Run test to verify it passes**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/hooks/useWebViewMessages.test.tsx`
- Expected: PASS (or next failures unrelated to missing module).

**Step 5: Commit**

```bash
git add packages/vscode-ide-companion/src/webview/hooks/useWebViewMessages.test.tsx
git commit -m "test: fix permission request import"
```

---

### Task 2: Add InputForm adapter tests

**Files:**

- Create: `packages/vscode-ide-companion/src/webview/components/layout/InputForm.test.tsx`

**Step 1: Write the failing test**

```tsx
/** @vitest-environment jsdom */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils/render.js';
import type { ApprovalModeValue } from '../../../types/approvalModeValueTypes.js';
import type { ModelInfo } from '../../../types/acpTypes.js';

vi.mock('@qwen-code/webui', () => ({
  InputForm: ({
    editModeInfo,
  }: {
    editModeInfo: { label: string; title: string; icon: unknown };
  }) => (
    <div
      data-testid="base-input"
      data-edit-label={editModeInfo?.label}
      data-edit-title={editModeInfo?.title}
      data-edit-icon={String(editModeInfo?.icon ?? '')}
    />
  ),
  getEditModeIcon: (type: string) => `icon:${type}`,
  PlanCompletedIcon: () => <span data-testid="plan-icon" />,
}));

import { InputForm } from './InputForm.js';

const baseProps = {
  inputText: '',
  setInputText: vi.fn(),
  onSubmit: vi.fn(),
  onStop: vi.fn(),
  onToggleThinking: vi.fn(),
  onToggleEditMode: vi.fn(),
  editMode: 'auto-edit' as ApprovalModeValue,
};

const models: ModelInfo[] = [
  { modelId: 'qwen3', name: 'Qwen 3' },
  { modelId: 'qwen2', name: 'Qwen 2', description: 'Fallback' },
];

describe('InputForm adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converts editMode into editModeInfo for webui InputForm', () => {
    render(<InputForm {...baseProps} />);

    const baseInput = screen.getByTestId('base-input');
    expect(baseInput).toHaveAttribute('data-edit-label', 'Edit automatically');
    expect(baseInput).toHaveAttribute(
      'data-edit-title',
      'Qwen will edit files automatically. Click to switch modes.',
    );
    expect(baseInput.getAttribute('data-edit-icon')).toContain('icon:auto');
  });

  it('renders ModelSelector overlay when enabled', () => {
    render(
      <InputForm
        {...baseProps}
        showModelSelector
        availableModels={models}
        currentModelId="qwen3"
        onSelectModel={vi.fn()}
        onCloseModelSelector={vi.fn()}
      />,
    );

    expect(screen.getByText('Select a model')).toBeInTheDocument();
    expect(screen.getByText('Qwen 3')).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/components/layout/InputForm.test.tsx`
- Expected: FAIL until mocks/props are correct.

**Step 3: Write minimal implementation**

- Adjust mocks/props as needed to satisfy the test, but do not change production code.

**Step 4: Run test to verify it passes**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/components/layout/InputForm.test.tsx`
- Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vscode-ide-companion/src/webview/components/layout/InputForm.test.tsx
git commit -m "test: add InputForm adapter coverage"
```

---

### Task 3: Add PermissionDrawer unit test (webui usage)

**Files:**

- Create: `packages/vscode-ide-companion/src/webview/components/PermissionDrawer.test.tsx`

**Step 1: Write the failing test**

```tsx
/** @vitest-environment jsdom */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '../test-utils/render.js';
import { PermissionDrawer } from '@qwen-code/webui';
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';

const options: PermissionOption[] = [
  { name: 'Allow once', kind: 'allow_once', optionId: 'allow_once' },
  { name: 'Reject', kind: 'reject', optionId: 'reject' },
];

const toolCall: PermissionToolCall = {
  kind: 'edit',
  title: 'Edit file',
  locations: [{ path: '/repo/src/file.ts' }],
};

describe('PermissionDrawer (webview)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders affected file name for edit tool calls', () => {
    const { container } = render(
      <PermissionDrawer
        isOpen
        options={options}
        toolCall={toolCall}
        onResponse={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('file.ts');
  });

  it('selects option on number key press', () => {
    const onResponse = vi.fn();
    render(
      <PermissionDrawer
        isOpen
        options={options}
        toolCall={toolCall}
        onResponse={onResponse}
      />,
    );

    fireEvent.keyDown(window, { key: '1' });

    expect(onResponse).toHaveBeenCalledWith('allow_once');
  });

  it('rejects and closes on Escape', () => {
    const onResponse = vi.fn();
    const onClose = vi.fn();
    render(
      <PermissionDrawer
        isOpen
        options={options}
        toolCall={toolCall}
        onResponse={onResponse}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onResponse).toHaveBeenCalledWith('reject');
    expect(onClose).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/components/PermissionDrawer.test.tsx`
- Expected: FAIL until dependencies or setup are correct.

**Step 3: Write minimal implementation**

- Adjust test utilities/mocks only if needed to satisfy runtime behavior (no production code changes).

**Step 4: Run test to verify it passes**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/components/PermissionDrawer.test.tsx`
- Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vscode-ide-companion/src/webview/components/PermissionDrawer.test.tsx
git commit -m "test: add PermissionDrawer coverage"
```

---

### Task 4: Add useSessionManagement hook tests

**Files:**

- Create: `packages/vscode-ide-companion/src/webview/hooks/session/useSessionManagement.test.tsx`

**Step 1: Write the failing test**

```tsx
/** @vitest-environment jsdom */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { VSCodeAPI } from '../useVSCode.js';
import { useSessionManagement } from './useSessionManagement.js';

function HookHarness({
  api,
  resultRef,
}: {
  api: VSCodeAPI;
  resultRef: React.MutableRefObject<ReturnType<
    typeof useSessionManagement
  > | null>;
}) {
  const result = useSessionManagement(api);
  resultRef.current = result;
  return null;
}

const renderHook = (api: VSCodeAPI) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const resultRef: React.MutableRefObject<ReturnType<
    typeof useSessionManagement
  > | null> = {
    current: null,
  };

  act(() => {
    root.render(<HookHarness api={api} resultRef={resultRef} />);
  });

  return {
    resultRef: resultRef as React.MutableRefObject<
      ReturnType<typeof useSessionManagement>
    >,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

describe('useSessionManagement', () => {
  let api: VSCodeAPI;

  beforeEach(() => {
    api = {
      postMessage: vi.fn(),
      getState: vi.fn(() => ({})),
      setState: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('loads sessions and opens selector', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.handleLoadQwenSessions();
    });

    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'getQwenSessions',
      data: { size: 20 },
    });
    expect(resultRef.current.showSessionSelector).toBe(true);
    expect(resultRef.current.isLoading).toBe(true);
    expect(resultRef.current.nextCursor).toBeUndefined();
    expect(resultRef.current.hasMore).toBe(true);

    unmount();
  });

  it('loads more sessions when cursor is available', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.setNextCursor(42);
      resultRef.current.setHasMore(true);
      resultRef.current.setIsLoading(false);
    });

    act(() => {
      resultRef.current.handleLoadMoreSessions();
    });

    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'getQwenSessions',
      data: { cursor: 42, size: 20 },
    });

    unmount();
  });

  it('does not switch when selecting current session', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.setCurrentSessionId('abc');
    });

    act(() => {
      resultRef.current.handleSwitchSession('abc');
    });

    expect(api.postMessage).not.toHaveBeenCalled();
    expect(resultRef.current.showSessionSelector).toBe(false);

    unmount();
  });

  it('switches session and posts message for new id', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.handleSwitchSession('xyz');
    });

    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'switchQwenSession',
      data: { sessionId: 'xyz' },
    });

    unmount();
  });

  it('stores saved session tags from response', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.handleSaveSessionResponse({
        success: true,
        message: 'saved with tag: foo',
      });
    });

    expect(resultRef.current.savedSessionTags).toEqual(['foo']);

    unmount();
  });
});
```

**Step 2: Run test to verify it fails**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/hooks/session/useSessionManagement.test.tsx`
- Expected: FAIL until setup is correct.

**Step 3: Write minimal implementation**

- Adjust test helper/mocks only if needed (no production code changes).

**Step 4: Run test to verify it passes**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/hooks/session/useSessionManagement.test.tsx`
- Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vscode-ide-companion/src/webview/hooks/session/useSessionManagement.test.tsx
git commit -m "test: add session management hook coverage"
```

---

### Task 5: Add ToolCall routing tests

**Files:**

- Create: `packages/vscode-ide-companion/src/webview/components/messages/toolcalls/ToolCall.test.tsx`

**Step 1: Write the failing test**

```tsx
/** @vitest-environment jsdom */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../../test-utils/render.js';
import { ToolCall } from './ToolCall.js';
import { getToolCallComponent, ToolCallRouter } from './index.js';
import {
  ReadToolCall,
  ShellToolCall,
  UpdatedPlanToolCall,
  GenericToolCall,
  type ToolCallData,
} from '@qwen-code/webui';

vi.mock('@qwen-code/webui', () => {
  const make = (id: string) => (props: { toolCall: { kind: string } }) => (
    <div data-testid={id}>{props.toolCall.kind}</div>
  );
  return {
    shouldShowToolCall: vi.fn(() => true),
    GenericToolCall: make('generic'),
    ThinkToolCall: make('think'),
    SaveMemoryToolCall: make('save-memory'),
    EditToolCall: make('edit'),
    WriteToolCall: make('write'),
    SearchToolCall: make('search'),
    UpdatedPlanToolCall: make('updated-plan'),
    ShellToolCall: make('shell'),
    ReadToolCall: make('read'),
    WebFetchToolCall: make('fetch'),
  };
});

const baseToolCall: ToolCallData = {
  toolCallId: '1',
  kind: 'read',
  title: 'Read file',
  status: 'completed',
};

describe('ToolCall routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps tool call kind to the correct component', () => {
    expect(getToolCallComponent('read')).toBe(ReadToolCall);
    expect(getToolCallComponent('bash')).toBe(ShellToolCall);
    expect(getToolCallComponent('updated_plan')).toBe(UpdatedPlanToolCall);
    expect(getToolCallComponent('unknown')).toBe(GenericToolCall);
  });

  it('renders tool call via router when visible', () => {
    render(<ToolCallRouter toolCall={baseToolCall} />);
    expect(screen.getByTestId('read')).toBeInTheDocument();
  });

  it('renders ToolCall wrapper', () => {
    render(<ToolCall toolCall={baseToolCall} />);
    expect(screen.getByTestId('read')).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/components/messages/toolcalls/ToolCall.test.tsx`
- Expected: FAIL until mocks/exports resolve.

**Step 3: Write minimal implementation**

- Adjust test mocks or assertions as needed (no production code changes).

**Step 4: Run test to verify it passes**

- Run: `npm -w packages/vscode-ide-companion run test -- src/webview/components/messages/toolcalls/ToolCall.test.tsx`
- Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vscode-ide-companion/src/webview/components/messages/toolcalls/ToolCall.test.tsx
git commit -m "test: add ToolCall router coverage"
```

---

### Task 6: Align GitHub Actions matrix and permissions with design doc

**Files:**

- Modify: `.github/workflows/vscode-extension-test.yml`

**Step 1: Write the failing test**

- No automated tests; this is workflow configuration.

**Step 2: Run test to verify it fails**

- Manual verification only. Expect no validation step at this stage.

**Step 3: Write minimal implementation**

- Update `unit-test` matrix to include:
  - `ubuntu-latest`, `macos-latest`, `windows-latest`
  - `node-version`: `20.x`, `22.x`
- Keep integration/e2e jobs on `ubuntu-latest`.
- Add `issues: write` permission so `create-issue` can succeed.

**Step 4: Run test to verify it passes**

- Optional (if available): run `actionlint` locally.
- Otherwise: review `git diff` to confirm YAML is valid.

**Step 5: Commit**

```bash
git add .github/workflows/vscode-extension-test.yml
git commit -m "ci: expand vscode extension test matrix and permissions"
```

---

### Task 7: Add VSCode extension tests to release workflow

**Files:**

- Modify: `.github/workflows/release.yml`

**Step 1: Write the failing test**

- No automated tests; this is workflow configuration.

**Step 2: Run test to verify it fails**

- Manual verification only. Expect no validation step at this stage.

**Step 3: Write minimal implementation**

- In the `Run Tests` step, append:
  - `npm run test:ci --workspace=packages/vscode-ide-companion`
  - `xvfb-run -a npm run test:integration --workspace=packages/vscode-ide-companion`

**Step 4: Run test to verify it passes**

- Optional (if available): run `actionlint` locally.
- Otherwise: review `git diff` to confirm YAML changes.

**Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add vscode extension tests to release workflow"
```

---

## Final Verification

- Run: `npm -w packages/vscode-ide-companion run test`
- Expected: All new tests pass.
