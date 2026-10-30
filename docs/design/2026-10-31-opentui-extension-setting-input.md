# OpenTUI direct extension setting input

[English](2026-10-31-opentui-extension-setting-input.md) | [简体中文](2026-10-31-opentui-extension-setting-input.zh-CN.md)

## Problem and scope

The direct-install consent fix does not own subsequent required setting input. In the current native reproduction, a non-sensitive value reached the installed .env, but the same typing also entered the composer and public quit failed to exit naturally. Global Ink and both candidate Ink profiles completed the same fixture. This is an input-ownership defect, not evidence of a failed save or a Core policy bug.

## Design

Register a setting callback alongside the current Config-owned consent callback. Reuse the existing Source extension setting widget, exported without changing its input, password, editing, or settlement behavior. Setting requests join the shell's existing FIFO modal queue, so the composer remains unmounted while a setting is active. Each request has an independent value/cancel promise and owner. Ordinary rerenders preserve requests; Config replacement, unmount, Escape, and stale captured callbacks reject. A late submit cannot settle a replacement. Cleanup never restores a no-op or overwrites a later registration. Explicit Source acquisition callbacks continue to win over the global manager callback.

Keep Core APIs, installation transactions, approval mode, marketplace choice, providers and headless CLI unchanged. A cancellation cannot roll back a Core commit. The setting widget may still handle sensitive values under its existing contract; the public reproduction uses only a non-sensitive owned label and makes no device or secret-storage qualification.

## Verification

The original public native run persisted the exact non-sensitive value, but input also reached the composer and quit did not exit naturally. That complete failure remains preserved alongside the Ink controls. The implementation passed normal full build, typecheck, lint, bundle and native layout checks, plus298 tests in five whole CLI files. Shell regressions cover exact values, cancellation, consent/setting FIFO, consecutive independent settings, ordinary rerenders, configuration replacement, stale callbacks and unmount; the existing real Source widget tests remain included.

Two public cases passed under strict Bun+OpenTUI, Node+Ink and Bun+Ink for the precommit setting bridge based on b74f34b9 (the test-only descendant of ec0e), with actual entry `7fd97e9ee34f8461a8e828d8439fab34661fff0a47790e2dca27ee878bbd3852`. A separate installed global Ink baseline with unknown source identity passed both cases too: eight executions of two unique cases,12 explicit natural exit0/signal0 outcomes, zero model requests and no cleanup errors. Save retains the exact native manifest, local source and .env value, avoids composer submission, then naturally exits. A cold restart preserves the entire authority/artifact/raw snapshot and exact .env, publicly lists the extension and naturally exits again. This is text-list visibility, not manager-dialog navigation. In a separate fresh workspace, one Escape at setting input acknowledges cancellation, preserves the complete initialized snapshot and allows ordinary natural quit.

Independent saved-result review matched these scoped outcomes. The readonly publisher stayed unchanged. After inheriting the test-only manager fixture correction, the additional real-shell voice whole file passed24 tests in this setting-bridge worktree. Recording, devices and transports remain mocked. These24 are separate from the298 affected tests above. No real audio/device permission, sensitive/keychain storage, other setting scope, complete generated dependency closure, installed/final-merged-main artifact or Core hook-lifecycle qualification is claimed. Overall migration and other callback gaps remain open.
