# Desktop Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable stable-channel desktop auto-updates with brand-owned GitHub Release feeds and a Settings UI for manual checks and restart-to-update.

**Architecture:** Store update feed ownership in the existing brand config, generate `electron-builder` publish metadata from that config, enable `electron-updater` only in packaged builds with a configured feed, and connect the existing renderer update hook to the existing RPC channels. Keep the first version stable-only and user-initiated for installation.

**Tech Stack:** Electron, electron-builder, electron-updater, React, TypeScript, i18next, GitHub Releases.

---

### Task 1: Add Brand Update Feed Config

**Files:**
- Modify: `packages/shared/src/branding.ts`
- Modify: `scripts/electron-builder-config.ts`

- [x] Add an `updates` field to `BrandConfig`:

```ts
updates?: {
  provider: 'github';
  owner: string;
  repo: string;
  releasePageUrl: string;
};
```

- [x] Configure `openwork` as `modelstudioai/openwork` and `qwen-code` as `QwenLM/qwen-code`.
- [x] Update `scripts/electron-builder-config.ts` so `config.publish` is generated from `BRAND.updates`.
- [x] Run `CRAFT_BRAND=openwork bun run electron:builder-config` and verify `apps/electron/electron-builder.generated.yml` contains the OpenWork GitHub provider.
- [x] Run `CRAFT_BRAND=qwen-code bun run electron:builder-config` and verify the generated config points to QwenLM/qwen-code.

### Task 2: Enable Packaged Auto-Update Runtime

**Files:**
- Modify: `apps/electron/src/main/auto-update.ts`

- [x] Replace the hard disabled constant with a packaged-build enablement check based on `BRAND.updates`.
- [x] Set `autoUpdater.autoDownload` from that enablement check and keep the default `electron-updater` install-on-quit behavior.
- [x] Keep development builds disabled.
- [x] Add logs that identify the configured provider and repo when checks run.
- [x] Preserve current dismissed-version and quit-and-install behavior.

### Task 3: Connect Renderer Hook to Existing RPC

**Files:**
- Modify: `apps/electron/src/renderer/hooks/useUpdateChecker.ts`

- [x] Load initial update info from `window.electronAPI.getUpdateInfo()`.
- [x] Subscribe to `onUpdateAvailable` and `onUpdateDownloadProgress`.
- [x] Implement `checkForUpdates()` through `window.electronAPI.checkForUpdates()`.
- [x] Implement `installUpdate()` through `window.electronAPI.installUpdate()`.
- [x] Track `isChecking` so the Settings button cannot issue duplicate checks.

### Task 4: Add Settings App Update Controls

**Files:**
- Modify: `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx`
- Modify: `packages/shared/src/i18n/locales/en.json`
- Modify: `packages/shared/src/i18n/locales/de.json`
- Modify: `packages/shared/src/i18n/locales/es.json`
- Modify: `packages/shared/src/i18n/locales/hu.json`
- Modify: `packages/shared/src/i18n/locales/ja.json`
- Modify: `packages/shared/src/i18n/locales/pl.json`
- Modify: `packages/shared/src/i18n/locales/zh-Hans.json`

- [x] Add an Updates section near About.
- [x] Show current version, latest version when present, and download progress.
- [x] Add a primary button that maps state to check, checking, downloading, or restart-to-update.
- [x] Show concise error copy when `downloadState` is `error`.
- [x] Add matching i18n keys to every locale file so parity stays green.

### Task 5: Verify

**Files:**
- Test generated config and touched TypeScript.

- [x] Run `bun run lint:i18n:parity`.
- [ ] Run `bun run typecheck:electron`.
- [x] Run `CRAFT_BRAND=openwork bun run electron:builder-config`.
- [x] Run `CRAFT_BRAND=qwen-code bun run electron:builder-config`.
- [x] Inspect generated `publish` blocks manually.
- [x] Do not commit generated `apps/electron/electron-builder.generated.yml` unless it is already tracked and intentionally changed.

`bun run typecheck:electron` currently fails on pre-existing test typing issues outside this change:

- `src/main/handlers/__tests__/settings-default-thinking.test.ts`
- `src/renderer/lib/__tests__/session-delete-navigation.test.ts`
- `src/renderer/lib/__tests__/skills-loading.test.ts`
