# Sidepanel Components Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove `sidepanel/components` entirely and import UI directly from `@qwen-code/webui`, keeping only platform adapters under `sidepanel/platform`.

**Architecture:** Move Chrome-specific adapters (InputForm/EmptyState/Onboarding) into `sidepanel/platform`, update all consumers to import WebUI components/types directly, then delete the old `sidepanel/components` directory and fix any remaining references.

**Tech Stack:** React 18, TypeScript, `@qwen-code/webui`, Chrome extension runtime APIs.

### Task 1: Move platform adapters into `sidepanel/platform`

**Files:**

- Create: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/platform/InputForm.tsx`
- Create: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/platform/EmptyState.tsx`
- Create: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/platform/Onboarding.tsx`
- Delete: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/components/layout/InputForm.tsx`
- Delete: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/components/layout/EmptyState.tsx`
- Delete: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/components/layout/Onboarding.tsx`

**Step 1: Write the failing test**

No new tests (refactor only).

**Step 2: Run test to verify it fails**

Skip.

**Step 3: Write minimal implementation**

Create `platform/InputForm.tsx` (copy adapter from previous location):

```tsx
import type { FC } from 'react';
import { InputForm as BaseInputForm, getEditModeIcon } from '@qwen-code/webui';
import type {
  InputFormProps as BaseInputFormProps,
  EditModeInfo,
} from '@qwen-code/webui';
import { getApprovalModeInfoFromString } from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';

export interface InputFormProps extends Omit<
  BaseInputFormProps,
  'editModeInfo' | 'contextUsage'
> {
  editMode: ApprovalModeValue;
  contextUsage?: BaseInputFormProps['contextUsage'];
}

const getEditModeInfo = (editMode: ApprovalModeValue): EditModeInfo => {
  const info = getApprovalModeInfoFromString(editMode);
  return {
    label: info.label,
    title: info.title,
    icon: info.iconType ? getEditModeIcon(info.iconType) : null,
  };
};

export const InputForm: FC<InputFormProps> = ({
  editMode,
  contextUsage,
  ...rest
}) => {
  const editModeInfo = getEditModeInfo(editMode);
  const resolvedContextUsage = contextUsage ?? null;
  return (
    <BaseInputForm
      editModeInfo={editModeInfo}
      contextUsage={resolvedContextUsage}
      {...rest}
    />
  );
};
```

Create `platform/EmptyState.tsx`:

```tsx
import type { FC } from 'react';
import { EmptyState as BaseEmptyState } from '@qwen-code/webui';

interface EmptyStateProps {
  isAuthenticated?: boolean;
  loadingMessage?: string;
}

function getExtensionAssetUrl(assetPath: string): string {
  if (
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    chrome.runtime.getURL
  ) {
    return chrome.runtime.getURL(assetPath);
  }
  return assetPath;
}

export const EmptyState: FC<EmptyStateProps> = ({
  isAuthenticated = false,
  loadingMessage,
}) => {
  const logoUrl = getExtensionAssetUrl('icons/icon-source.png');
  return (
    <BaseEmptyState
      isAuthenticated={isAuthenticated}
      loadingMessage={loadingMessage}
      logoUrl={logoUrl}
      appName="Qwen Code"
    />
  );
};
```

Create `platform/Onboarding.tsx`:

```tsx
import type { FC } from 'react';
import { Onboarding as BaseOnboarding } from '@qwen-code/webui';
import { generateIconUrl } from '../utils/resourceUrl.js';

interface OnboardingPageProps {
  onLogin: () => void;
}

export const Onboarding: FC<OnboardingPageProps> = ({ onLogin }) => {
  const iconUrl = generateIconUrl('icon.png');
  return <BaseOnboarding iconUrl={iconUrl} onGetStarted={onLogin} />;
};
```

Delete the old `components/layout/*` adapter files.

**Step 4: Run test to verify it passes**

Skip.

**Step 5: Commit**

```bash
git add packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/platform \
  packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/components/layout
git commit -m "refactor(sidepanel): move adapters to platform"
```

### Task 2: Update imports to WebUI + platform adapters

**Files:**

- Modify: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/App.tsx`
- Modify: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/hooks/useWebViewMessages.ts`
- Modify: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/hooks/useToolCalls.ts`

**Step 1: Write the failing test**

No new tests (import refactor).

**Step 2: Run test to verify it fails**

Skip.

**Step 3: Write minimal implementation**

Update `App.tsx` imports:

```tsx
import { InputForm } from './platform/InputForm.js';
import { EmptyState } from './platform/EmptyState.js';
import {
  UserMessage,
  AssistantMessage,
  WaitingMessage,
} from '@qwen-code/webui';
import { PermissionDrawer } from '@qwen-code/webui';
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';
```

Replace local `ToolCall` alias with `PermissionToolCall`.

Update `useWebViewMessages.ts` to import types from WebUI:

```ts
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';
```

Update `useToolCalls.ts` to import `ToolCallData` from WebUI:

```ts
import type { ToolCallData } from '@qwen-code/webui';
```

**Step 4: Run test to verify it passes**

Skip.

**Step 5: Commit**

```bash
git add packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/App.tsx \
  packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/hooks/useWebViewMessages.ts \
  packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/hooks/useToolCalls.ts
git commit -m "refactor(sidepanel): import webui components directly"
```

### Task 3: Delete `sidepanel/components` and fix any remaining references

**Files:**

- Delete: `packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel/components/`
- Modify: any file still referencing `sidepanel/components` paths

**Step 1: Write the failing test**

No new tests.

**Step 2: Run test to verify it fails**

Skip.

**Step 3: Write minimal implementation**

Remove the entire `components` directory and run `rg` to confirm there are no remaining imports from it. Replace any leftover imports with `@qwen-code/webui` or `./platform/*` adapters.

**Step 4: Run test to verify it passes**

Skip.

**Step 5: Commit**

```bash
git add packages/mcp-chrome-integration/app/chrome-extension/src/sidepanel
git commit -m "refactor(sidepanel): remove local components directory"
```
