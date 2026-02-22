# Remove LspLanguageDetector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove LspLanguageDetector and all usage so LSP setup is purely config-driven without automatic language scanning.

**Architecture:** Delete the detector class and its export, and simplify NativeLspService.discoverAndPrepare() to skip language detection. Add a regression test that proves discoverAndPrepare no longer triggers workspace scanning.

**Tech Stack:** TypeScript, Vitest, Node.js

### Task 1: Add a regression test that discoverAndPrepare does not scan files

**Files:**

- Modify: `packages/core/src/lsp/NativeLspService.test.ts`
- Test: `packages/core/src/lsp/NativeLspService.test.ts`

**Step 1: Write the failing test**

```ts
test('discoverAndPrepare should not scan workspace files without detection', async () => {
  const throwingDiscovery = {
    discoverFiles: vi.fn(async () => {
      throw new Error('discoverFiles should not be called');
    }),
    shouldIgnoreFile: () => false,
  };

  const service = new NativeLspService(
    mockConfig as unknown as CoreConfig,
    mockWorkspace as unknown as WorkspaceContext,
    eventEmitter,
    throwingDiscovery as unknown as FileDiscoveryService,
    mockIdeStore as unknown as IdeContextStore,
  );

  await expect(service.discoverAndPrepare()).resolves.toBeUndefined();
  expect(throwingDiscovery.discoverFiles).not.toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lsp/NativeLspService.test.ts --reporter=dot`
Expected: FAIL (because discoverAndPrepare still triggers detection).

**Step 3: Write minimal implementation**

Remove language detection from `discoverAndPrepare()` so file scanning is not invoked.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lsp/NativeLspService.test.ts --reporter=dot`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/lsp/NativeLspService.test.ts
git commit -m "test: cover discoverAndPrepare without language detection"
```

### Task 2: Remove LspLanguageDetector usage in NativeLspService

**Files:**

- Modify: `packages/core/src/lsp/NativeLspService.ts`

**Step 1: Write the failing test**

Reuse Task 1 test; no new test required.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lsp/NativeLspService.test.ts --reporter=dot`
Expected: FAIL before code change.

**Step 3: Write minimal implementation**

Remove:

- `import { LspLanguageDetector } ...`
- `private languageDetector` field
- constructor initialization
- `detectLanguages()` call + related variables

Keep `mergeConfigs()` using only extension + user configs.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lsp/NativeLspService.test.ts --reporter=dot`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/lsp/NativeLspService.ts
git commit -m "refactor: remove LspLanguageDetector usage"
```

### Task 3: Remove LspLanguageDetector module and export

**Files:**

- Delete: `packages/core/src/lsp/LspLanguageDetector.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

No new test; rely on TypeScript compile (or build) to catch missing imports.

**Step 2: Run test to verify it fails**

Run: `npm run typecheck --workspace=packages/core --if-present`
Expected: FAIL if any imports remain.

**Step 3: Write minimal implementation**

Delete the file and remove the export from `packages/core/src/index.ts`.

**Step 4: Run test to verify it passes**

Run: `npm run typecheck --workspace=packages/core --if-present`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/index.ts
git add -u packages/core/src/lsp/LspLanguageDetector.ts
git commit -m "refactor: remove LspLanguageDetector module"
```
