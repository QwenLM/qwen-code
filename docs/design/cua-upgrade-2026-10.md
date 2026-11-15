# qwen-code Computer Use upgrade design and decisions (2026-10-15–16)

[English](cua-upgrade-2026-10.md) | [简体中文](cua-upgrade-2026-10.zh-CN.md)

This document records the background, analysis and decisions from these two days for implementation and later reference.

- Decisions are dated. Detailed evidence is listed in the document index.
- **[Measured]** means supported by tests or data; **[Inference]** means inferred from code or observations; **[Pending]** means verification is required.

---

## 0. Background

**Scope**

- `packages/cua-driver`: the Rust driver forked from trycua/cua `cua-driver-rs-v0.20.0`, distributed as qwen-cua-driver / QwenCuaDriver.app.
- `@qwen-code/cua-sdk` (`packages/cua-driver/typescript`, then 0.20.11).
- `@qwen-code/node-repl-mcp` (`packages/node-repl`, then 0.1.7).
- The bundled `computer-use` skill.
- The browser SDK `@qwen-code/browser-use` (0.25.2), included under topic 5.

**Why upgrade**

1. Other implementations have progressed:
   - Codex `cua_repl` exposes a `js` entry, supplies documentation at runtime, automatically displays state from `getApp`, and returns void from actions.
   - Upstream cua-driver reached 0.35.4, with 499 commits between the two versions.
2. RecreationBench and OSWorld-V2 exposed these problems:
   - **Comparable quality, lower efficiency**: across the final 12 RecreationBench groups and 450 results, our quality and token use were comparable to official Codex and QoderCU, but elapsed time was about 1.5 times higher. Input per round was 110–130k, close to the 128k limit, making cost roughly proportional to round count. **[Measured]**
   - **Too many rounds**: in the first macOS stable20 round, our generation count was 2.47 times the official implementation's, and input per generation was 2.05 times higher. On 41 tasks passed by all three implementations, calls were official 4, Qoder 12 and ours 28. The OSWorld-V2 candidate made about twice as many requests as direct mode. **[Measured]**
   - **Cost of always foregrounding macOS**: commit `0ceac09` on 09-13 changed macOS input to activate B before every input, based on a misattributed Codex Windows document. Total time rose 37%; one five-action cell took 8.61 s versus official 1.61 s. **[Measured]**

**Overall goal, decided 10-15**: complete computer-use tasks with fewer rounds, fewer tokens and clear, concise steps.

---

## 1. Overall direction (10-15)

1. Supply runtime documentation in place of skills and simplify node-repl by removing wait / cancel, following Codex.
2. Maintain one underlying service. The driver remains directly callable; the node-repl path wraps that same driver through the SDK. Upstream synchronization means porting or referencing specific fixes and capabilities rather than merging its entire codebase.
3. Exclude upstream `run_script` / `run_steps` and its upper-level interfaces. Synchronize native operation coverage, reliability and efficiency.
4. Decide foreground/background behavior separately for each platform, as described in section 2.
5. Evaluate rounds, tokens and clarity of steps.

**Addition, 10-16**: direct driver MCP use, without node-repl, must remain fully usable and is equally important.

---

## 2. Foreground / background (topic 4)

The shared scenario is a user typing in A while the agent operates B behind A.

### 2.1 macOS (10-15)

**Analysis**

- There are three ways to deliver input to B:
  1. AX accessibility actions such as press, value writes and focus changes, without foregrounding B.
  2. Process-directed events, optionally telling B that it has been activated through “synthetic focus,” while the actual system foreground remains unchanged.
  3. Global events, requiring B to become the actual foreground and affecting the user's keys and pointer.
- Codex and upstream primarily use 1 and 2; ours primarily uses 3 after `0ceac09`.
- Our implementation waits a **fixed 1 s after each action** to check for new windows (`window_change_detector.rs:152`).

**Decisions**

- Combine AX and process-directed events, drawing on Codex and upstream.
- Initially omit an automatic foreground/global-event route; Codex and upstream do not use it for this path.
- Verify post-action waits: if Codex completes correctly without waiting, that wait may explain the efficiency gap.
- Initially test Codex's directed drag and align paste with Codex.
- Design tests on mini using official Codex and upstream 0.35.4 as comparison targets.

**mini smoke observations, 10-15/16**: one run per case; **[Measured]**, but preliminary. The formal batch finished and still required analysis at the time.

- **Codex returns after dispatch without a fixed wait**: control actions took about 100–150 ms. Opening a sheet and typing without another observation succeeded 3/3. The roughly 2 s smoke delay came from an unanswered system authorization dialog and disappeared after it was handled.
- **Codex synthetic focus works**: B considers itself active and keyboard-focused while system foreground stays A. It can paste with `cmd+v` and press Return in a background sheet; upstream cannot do those two actions but explicitly refuses them.
- **Codex gaps**:
  - `typeText` lost Chinese and emoji, 0/3, while reporting success.
  - Coordinate right-click reached neither A nor B.
  - Drag/drop and list reorder reported success without effect; two of three runs swallowed one user key. Slider drag alone worked.
- **Upstream problems**:
  - Popup `setValue` worked, but text-field `setValue` did not trigger the application's change callback.
  - AXPress on a text field returned -25206 without fallback.
  - Each action took about 1 s.
- **Ours, forced foreground** passed the most cases but took about 1.1 s per action, foregrounded B and moved the pointer. Restoring A closed menus just opened in B.

**Implementation details decided from this evidence**

- Remove the fixed post-action wait. Return after dispatch and move waiting into observation, as described in topic 3.
- Explicitly refuse background drag/drop and list reorder, suggesting alternatives. Use `setValue` for sliders rather than Codex's instantaneous drag.
- Align paste with Codex: temporarily use and then restore the clipboard.
- Use directed keys for ASCII; use AX insertion at the caret plus readback for non-ASCII to avoid Codex's lost text. **[Pending]**
- Implement popup `setValue` by opening the menu and selecting the item, porting upstream behavior.
- Use AXPress for controls that support press; otherwise use a directed click with synthetic focus.
- Port upstream background protection:
  - Do not send A a synthetic deactivation record (#4943).
  - `key_focus_guard` (#4943 #4955 #5091 #5129).
  - Restore A after B activates itself, except when the user moved the mouse or modifiers within 1 s (#4976).
  - Explicitly stamp mouse modifier state (#5051).
  - Save and rename with Apple Events and readback (#5057).
  - Refuse typing without a focused text field using `no_focused_text_input`.
  - Return `write_not_applied` when readback shows no write.
- Merge these protections with existing `app_focus.rs` synthetic focus into one observer.
- Do not implement Codex's visible cursor at this stage; no decision to include it was made.

### 2.2 Windows (10-15/16)

**Analysis**

- Four routes deliver input to B:
  1. UIA semantics without foreground activation.
  2. PostMessage window messages without activation, often ignored by Chromium, WPF and Tk.
  3. Synthetic pointer injection.
  4. SendInput, which requires the actual foreground.
- Current implementations:
  - **Codex** activates B, with up to 20 attempts and an Alt technique, then uses SendInput. It does not guarantee restoring A and monitors user input.
  - **Upstream** prefers background and returns `background_unavailable` for known ignored combinations.
  - **Our App layer** always activates B and uses SendInput, bypassing UIA Invoke even for element clicks, then synchronously restores A. It depends on a signed UIAccess worker.
- The fork already contains upstream background routes and ignored-delivery classifications; App currently forces foreground.
- Known defects:
  - Foreground typing waits only 40 ms before restoring A; trailing characters can enter A.
  - Text is sent as one batch without checking foreground between characters.
  - **Default Windows npm installation is broken**: the distributed worker is unsigned, while the installer requires a valid signature (`install-native.mjs:157`).

**Decision: hybrid mode**

1. Try UIA semantics, window messages and synthetic pointer input first. **Activate B and use SendInput only after pre-dispatch `background_unavailable`, with no side effect.** Dispatched but unconfirmed input reports uncertainty and is never retried.
2. Keep verified restoration of A and preserve a user-selected C. Port #4500, waiting for B to drain input before restoring, and #4901, checking foreground per character.
3. Stop and report an error if the user acts during foreground delivery, following Codex. Do not intercept physical input.
4. Initially use upstream's elevated daemon with ordinary-user tokens for applications it launches. Retain UIAccess code; signing is being requested.
5. `typeText` always inserts at the caret; `setValue` always replaces the whole value.

Other fixes: #3671 avoids fallback after timeout and duplicate clicks; #4774 implements native combo selection; refuse Tk clicks; set VK_LWIN flags; bound worker pipe reads.

### 2.3 Linux (10-16)

**Analysis**

- X11 and Wayland are different display protocols.
  - X11 has a central server and no application isolation, allowing cross-window input, screenshots and global simulation.
  - Wayland delegates to the compositor, isolates applications, and requires compositor-specific automation access.
- Codex supports only X11; its 26.1007 documentation and code contain no Wayland implementation.
- Upstream has full X11 support; Wayland is disabled by default and remains limited when enabled.
- X11 has four input routes:
  1. AT-SPI semantics.
  2. Directed SendEvent plus FocusIn, used by Codex and often ignored by GTK/Chromium.
  3. A virtual second pointer through MPX + uinput, used by upstream and requiring real Xorg and uinput.
  4. Foreground XTest, currently used by ours.

**Decisions**

- **Remove Wayland entirely and support only X11**:
  - Remove 21 fork files: `platform-linux/src/wayland/*`, `video_wayland.rs`, `wayland-helper/`, libei examples, Wayland tests and documentation.
  - Pure Wayland sessions report “X11 only.”
  - X11 applications under XWayland remain supported.
  - Do not synchronize upstream Wayland changes.
- **Design for real shared desktops**; a test machine is only a test environment. Foreground transactions retain “restore A, preserve C.”
- **Use the Windows structure**:
  1. AT-SPI.
  2. Virtual second pointer where supported.
  3. Foreground XTest only after `background_unavailable`.
  4. Stop on user input during foreground delivery.
  5. Never retry dispatched but unconfirmed input.
- Use directed events only for Qt / Tk / Xt applications known to accept them.
- **Audit and port X11 / AT-SPI fixes after upstream 0.20.0**, checking whether the fork already contains each:
  - Input: #3882, #3761, #3762, #3864, #3618, #4248, #4188 and Chinese text loss #5139 / #5158.
  - MPX: #3601, #2888, #5070.
  - AT-SPI: #4903, #4984, #5074, #4375, GTK combo `set_value`, #4292.
  - Other: #3758, #4281, #3814, #4529, #4715, #3658, #3778.
- Repair fork defects as well:
  - Send FocusIn only to Qt5, and follow Codex's FocusOut conditions.
  - Restore focus after X11 activation fails.
  - Fix per-window scaling identified 09-17, with 164 / 76 px offsets; double scaling in `mouse_button_up`; X11 Page_Up / Page_Down; and on-demand Chromium classification.

---

## 3. Topics 1–7 (10-16)

### Topic 1: runtime documentation replaces skills; simplify node-repl, following Codex

- **Tools**: expose only `js` (`code`, `timeout_ms` default 30 s, `title`) and `js_reset`. `add_node_module_dir` is host configuration. Remove wait / cancel and follow Codex timeout behavior.
- **Guidance**:
  - MCP instructions contain one sentence.
  - The `js` description explains only the entry point.
  - First execution imports the SDK, creates global `cua` and prints core documentation for the current platform only.
  - After compaction, the model calls `cua.rewriteDocumentation()`.
- **Entry**: `getApp` displays full state; observations display automatically, with `emit:false` to disable display.
- Remove the bundled computer-use and browser-use `SKILL.md` files afterward. Deleting these content files is the sole exception to leaving qwen-code itself untouched.

**Evidence**: historical wait requests used only to retrieve results occurred 1008 times and consumed 130 million tokens; Codex's five-layer guidance was measured through the MCP handshake.

### Topic 2: driver as the only backend; SDK as a thin wrapper

- **2a Move into the driver**:
  - Application/window resolution: accept `app` directly and resolve in one round trip, replacing at least three SDK round trips per action.
  - Short IDs.
  - Observation rendering, character limits and diff.
  - Foreground/background policy.
  - Structured errors.
- The SDK retains global `cua`, typed methods, automatic display, runtime documentation and serialization per application. Generate MCP descriptions and runtime documentation from one interface definition.
- **2b Simplify tools**: expose a Codex-like set of core operations by default. Upstream recording, cursor themes, zoom, replay, administration and `browser_*` stay disabled by default and are opt-in.
- **2c** MCP tool names and parameters correspond one-to-one to JS methods.

### Topic 3: observation

- Split into `getAXState / getScreenshot / getAXStateAndScreenshot`, following Codex. Return a string, remove `.elements` and display automatically.
- Do not capture screenshots for text-only observations. Remove the SDK's fixed `includeScreenshot:true`; Linux may save 1.6–2 s per observation. **[Inference from the 09-18 diagnosis]**
- Return actions after dispatch. Wait for stability during observation, initially 300–500 ms, with the final limit based on tests.
- First `getApp` and window changes return full AX without a screenshot; later observations default to diff. **All three platforms use diff**, intentionally differing from Codex's full Linux/Windows observations.
- Also repair per-window screenshot mapping, avoid recapture after incomplete AX (4.4–5.3 s in Chrome), match image MIME to bytes, and wake Chromium AT-SPI before its first tree read (#5074).

### Topic 4: action results and errors

- Success returns `void`, without `effect`. Confirm the result through observation within the same code invocation.
- Failures throw `{code, reason, sent: true/false, next-step advice}` from the driver, preserved by SDK and direct MCP. Initial codes:

| Code                                   | Meaning                                      |
| -------------------------------------- | -------------------------------------------- |
| `element_stale`                        | ID from an older snapshot; no input sent     |
| `not_settable`                         | Control cannot be written directly           |
| `write_not_applied`                    | Readback did not change                      |
| `no_focused_text_input`                | Focus is outside a text field                |
| `target_occluded`                      | Target point is covered                      |
| `unsupported_on_platform`              | Operation unsupported on this platform       |
| `user_input_detected`                  | Foreground delivery stopped on user activity |
| `foreground_unavailable`               | Foreground activation failed; no input sent  |
| `app_not_running` / `window_not_found` | Application not running / no window found    |

- Do not expose `background_unavailable` to the model; the driver handles its permitted foreground fallback.
- IDs are valid only for the selected window's latest snapshot. Refuse old IDs before dispatch.
- Sent but unconfirmed input does not throw: return normally with “Sent but not confirmed; observe before retrying.”

**Evidence**: in macOS smoke tests, three distinct failures were rewritten by the SDK into the same generic message, forcing another observation to determine the cause.

### Topic 5: capability gaps

- **5a Browser**: reuse and migrate existing `@qwen-code/browser-use`. It already runs in node-repl, using Playwright over CDP through the Qwen Chrome extension to the user's Chrome, with void actions and coded errors. Expose `getBrowser / getTab / createBrowserTab` under `cua`, **without functional changes or upstream browser code**. Do not add Windows or diff support yet.
- **5b** Add explicit `cua.desktop`: full-display screenshots and screen-coordinate input. This naturally uses foreground and is selected only for explicit desktop operations.
- **5c** Add click modifiers, `click(p, {key})`, and `key_down / key_up`.
- **5d** Do not add per-application authorization.

### Topic 6: distribution and versions

- **6a** Leave qwen-code cli/core unchanged; node-repl remains separately registered MCP.
- **6b** Give SDK, native packages and browser SDK one version. Stop following upstream version numbers; record “ported from upstream #xxxx” in the changelog.
- **6c** Download native payloads on demand and verify SHA256 using the existing mechanism.

### Topic 7: evaluation

- Record tool and model evaluation separately; the user moved OSWorld evaluation after release on 2026-10-20:
  - **Layer 1, tools without models**: compare the candidate, Codex and upstream on the same cases for correctness, action latency, interference and success-without-effect. The driver merge gate is at least the better comparator. The user clarified on 2026-10-20 that the observed transient macOS target/menu cover is acceptable and expected; record it and recovery separately rather than applying a strict zero-cover blocker. This does not accept wrong-target input, changed click semantics or replay after uncertain delivery.
  - **Layer 2, small model/OSWorld evaluation after release**: primary metrics are **rounds, tokens and wall-clock time**, provided success rate does not regress. This is post-release follow-up rather than a pre-release gate; no improvement or nonregression result is claimed before execution.
- **Tasks**:
  - macOS and Windows use 20 OSWorld-V2 tasks selected in two AP groups (`sh-prod-1`, Qoder + Node REPL scaffold, `azure.gpt-6-astra`):
    - `group-5cff67aa55934a09a45160e3194b5801-s1`: macOS, mean 0.26, one full-score task.
    - `group-bc7a3539903b4735bc3508e04e5791d5-s1`: Windows, mean 0.12, zero full-score tasks.
  - Both use task_v2_001, 010, 020, 022, 027, 038, 044, 046, 051, 052, 055, 059, 060, 067, 076, 080, 088, 096, 101, 107.
  - Linux initially uses the same 20 IDs, replacing missing/inapplicable tasks from the Linux set. **[Pending verification]**
- **Rules**: change one variable at a time; record infrastructure failures separately and exclude/rerun them; missing usage yields lower bounds only; reuse existing comparator trajectories.

---

## 4. Implementation checklist by package

**cua-driver, Rust**

- Platform dispatch: macOS section 2.1, Windows hybrid section 2.2 and Linux X11 hybrid section 2.3. The driver decides; SDK no longer forces foreground.
- Remove Wayland and reject pure Wayland sessions.
- Move app/window resolution, short IDs, rendering/diff on all three platforms, waiting and structured errors into the driver.
- Simplify default MCP tools; align tools and JS methods; generate descriptions and documentation from one interface.
- Add desktop operations, click modifiers and `key_down / key_up`.
- Port macOS protection, Windows #4500 #4901 #3671 #4774 and the Linux X11 / AT-SPI list.
- Use the elevated Windows daemon topology; installation no longer depends on signing.

**cua-sdk, TS**

- Thin wrapper: global `cua`, typed methods, automatic display with `emit:false`, platform documentation, `rewriteDocumentation()` and per-app serialization.
- Remove App business logic: forced foreground, generic error rewriting and fixed screenshots.
- Wrap browser-use through `cua.getBrowser / getTab / createBrowserTab`.

**node-repl-mcp**

- `js` + `js_reset`, default 30 s; remove wait / cancel; host-only `add_node_module_dir`.
- Preload `cua` and documentation in the startup banner.

**browser-use**: reference and migrate only, without functional changes.

**qwen-code itself**: delete only the two bundled computer-use/browser-use `SKILL.md` files; no code changes.

**Versions**: one shared version and changelog port references.

---

## 5. Test environment snapshot (10-16)

| Platform | Machine                                               | Status at that time                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | mini, 30.221.187.223, `/Users/tutu/cua-fgbg-20261015` | Five harness problems repaired. Formal three-implementation × three-run batch, covering fixture cases and TextEdit / Excel / Finder / Chrome, finished pending analysis. Upstream T13 / T14 / T16 awaited Automation approval; T15 lacked LibreOffice.                                                                                                                                                    |
| Windows  | windows-ecs-new, 8.217.1.105, `C:\cua-fgbg-20261016`  | Upstream 0.35.4 and ours 0.20.11 prepared; new test certificate `83923F67…AB98`, valid through 2027-01-14, with signed/timestamped worker. SentinelA / UserTyper / Sampler compiled. Test processes still needed interactive desktop session 2; the borrowed-token launcher failed. An explicit choice remained between a one-off `schtasks /it` task and a runner started by the user in remote desktop. |
| Linux    | linux-ecs, 47.76.93.28                                | Dedicated `cua-fgbg-osworld-20261016` container using OSWorld-V2, QEMU software emulation and ports 127.0.0.1:50916 / 58916; existing containers preserved. Harness pending.                                                                                                                                                                                                                              |

AP at that time: mini ap-client upgraded from ArtLab to 0.5.1 and passed its version gate. The two group exports were reported at `/Users/tutu/cua-fgbg-20261015/ap-groups/`.

---

## 6. Corrections made during discussion

- “Codex waits conditionally for about 2 s after actions” was incorrect. An unanswered authorization dialog delayed screenshot capture until timeout; the formal batch had no such wait.
- The “official: input methods activate the target window” quotation used for `0ceac09` came from Codex's **Windows** SDK, not macOS.
- The launcher borrowing an explorer token still produced session-0 children. Fixture results from that session were invalidated.

---

## 7. Document index

| Document                                                                   | Contents                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `BRIEF.md`                                                                 | Research brief                                                            |
| `findings/code-architecture.md`                                            | Existing architecture                                                     |
| `findings/codex-latest-delta.md`                                           | Codex 26.924 → 26.1007 changes                                            |
| `findings/upstream-delta.md`                                               | Upstream 0.20 → 0.35.4 delta and synchronization simulation               |
| `findings/design-discussions.md`                                           | Historical decision ledger, including conflicting 09-17 / 09-21 decisions |
| `findings/fgbg-mechanics.md`                                               | Platform foreground/background mechanisms at code level                   |
| `findings/fgbg-evidence.md`                                                | Experiments and decision evidence                                         |
| `findings/rb-final-comparison.md`, `rb-sdk-rounds.md`                      | RecreationBench comparison and round analysis                             |
| `findings/osworld-stable20.md`                                             | OSWorld-V2 and macOS stable20 evidence                                    |
| `topic4-fgbg/codex-fgbg-2026-09-29-reconstructed.md`                       | Reconstructed 09-29 Codex platform analysis                               |
| `topic4-fgbg/macos.md`, `macos-test-plan.md`, `macos-shakeout-20261015.md` | macOS analysis, plan and smoke observations                               |
| `topic4-fgbg/windows.md`, `windows-test-plan.md`                           | Windows analysis, decisions and plan                                      |
| `topic4-fgbg/linux.md`                                                     | Linux analysis and decisions                                              |

## 8. Current execution scope (2026-10-19)

The user prioritizes the first four verification items: macOS, Windows and Linux X11 native acceptance, followed by runtime, installation and package checks. OSWorld evaluation is scheduled after release by the user’s 2026-10-20 decision; future model runs use `gpt-6-sol`. On 2026-10-20 the user requested a fresh same-mini Codex tool comparison and clarified acceptance of observed transient macOS cover. All remaining native GUI tests run on mini. The 10-16 environment table above is historical. Current evidence and candidate identities are recorded in the [acceptance ledger](cua-upgrade-acceptance-2026-10.md#acceptance-clarification-2026-10-20). The user now authorizes pushing this feature branch and submitting its PR to main. OSWorld results are not a release prerequisite; production release execution is a separate action and no benchmark result is marked passed.
