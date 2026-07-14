# Qwen Code Desktop: Near-Term Product and UI Directions

Status: Draft for discussion and review

Date: 2026-07-14
Related issue: [#6896](https://github.com/QwenLM/qwen-code/issues/6896)

## Background

Qwen Code Desktop already provides multiple workspaces, multiple sessions, file previews, a dockable browser, background tasks, skills, automations, and settings. However, it still feels closer to a desktop container for CLI capabilities than a product with a clearly differentiated desktop value proposition.

Desktop should do more than place a CLI conversation inside a window. It should use persistent visual surfaces, parallel information display, and interactive tools to provide a complete workspace experience that is difficult to achieve in a CLI.

Based on the current Electron development environment, the existing code structure, and the ChatGPT/Codex Desktop reference interface, this proposal focuses on three near-term directions:

1. Complete the core capabilities that demonstrate the value of Desktop, with an initial focus on the right sidebar;
2. Clarify the sharing boundaries of the Desktop UI and the direction of ACP-based communication;
3. Improve the overall information architecture and project-environment visibility while keeping near-term UI changes limited in scope.

## Direction 1: Complete Desktop-Specific Capabilities

### Goal

Completing Desktop-specific capabilities is the primary goal of this proposal. Users should be able to continuously inspect information, operate tools, and track work within the same session workspace without frequently switching to other applications.

Desktop differentiation includes many possible capabilities, but the near-term focus should be the right sidebar. It is the most direct surface for persistent information and tools, and therefore the clearest starting point for creating an experience that differs from the CLI. Other Desktop capabilities are outside the scope of this proposal.

The right sidebar is more than a centralized set of feature entry points. Over time, it should become a shared context surface where the user and the Agent work together. The Agent should be able to act on and update panels for files, the browser, terminal sessions, tasks, and reviews, while also observing the context the user is currently viewing or selecting. The user should be able to inspect results, make decisions, and provide feedback within the same interface.

For example, the Agent could present changes, diffs, and review findings in the sidebar, allowing the user to confirm them, comment on them, or request revisions against the same shared context. This two-way contextual collaboration is not simply a matter of grouping features together; it is a long-term problem that the Desktop experience needs to solve. This proposal establishes the direction, while detailed interactions and state-management mechanisms can be designed separately.

### Near-Term Focus

Using the right-hand work surface in ChatGPT/Codex Desktop as a reference, Qwen Code Desktop should first complete and unify the main right-sidebar entry points:

- Review: inspect code changes, diffs, and related checks;
- Terminal: inspect command execution, background shells, and runtime status;
- Browser: view and verify web content alongside the session;
- Files: inspect session artifacts, attachments, and workspace files;
- Side tasks: continuously track background tasks and their status.

The current codebase already contains foundational support for session files, file previews, browser docking, background tasks, terminal output, and diff rendering, but their entry points are fragmented. The near-term goal of Direction 1 is not to reimplement these capabilities, but to progressively organize them into a unified and stable right sidebar.

The first step can prioritize the more mature file and browser capabilities, with other areas completed as their product definitions become clearer through actual use.

[Issue #4885](https://github.com/QwenLM/qwen-code/issues/4885) proposed moving Desktop file content from a full-screen view into a sidebar or split-pane preview. Although the issue is closed, its goals of preserving conversation context and reducing view switching are aligned with this direction and provide useful background for the right-side file panel.

## Direction 2: Clarify the Desktop UI and Communication Architecture

### Goal

Establish an application-level UI for the Desktop product that can serve both Electron and a future Desktop WebUI, while preserving a distinct product role for the repository's Web Shell.

### UI Boundaries

`@craft-agent/ui` already provides platform-independent components for chat rendering, Markdown, file previews, diffs, and terminal output. It should continue to serve as a shared presentation layer.

[Issue #5883](https://github.com/QwenLM/qwen-code/issues/5883) proposes sharing a chat panel across Web Shell, the VS Code webview, and Desktop. Chat flows, message rendering, and composer components have clear cross-surface reuse value. This proposal supports continued evaluation and reuse in that direction, while leaving the exact component ownership and data-adaptation model to be confirmed against the current implementations.

Sharing Chat components does not mean merging the entire Desktop UI with Web Shell. Desktop application-level UI such as workspace navigation, session layout, left and right sidebars, and tool panels may still require a separate component layer. That layer should be shared by Electron and a future Desktop WebUI, with platform adapters providing filesystem, browser, window, and notification capabilities.

`packages/web-shell` serves as an embeddable daemon-backed session terminal. Its deployment model, host relationship, and product role differ from those of a Desktop WebUI, so its overall UI should not be merged with the Desktop application UI.

The boundary can be summarized as follows:

```text
Electron ─────────┐
                  ├─ Desktop application-level UI ── @craft-agent/ui
Desktop WebUI ────┘

Web Shell ── daemon SDK / HTTP / SSE
```

Whether this should become a dedicated application-level UI package or a clearly defined subpath of `@craft-agent/ui` can be decided during the first concrete extraction. The priority is to keep platform dependencies directional and prevent a future Desktop WebUI from depending directly on Electron renderer internals or global APIs.

### ACP Communication

Desktop sessions should continue to connect to the Qwen Code CLI through ACP, without introducing daemon as the default intermediary.

The current path can be summarized as follows:

```text
Electron / Desktop WebUI
  -> Desktop RPC and SessionManager
  -> QwenAgent
  -> Qwen Code CLI over ACP
```

For a single Desktop client, direct ACP communication avoids an additional process, protocol translation, and duplicated session state while remaining consistent with the current implementation. Daemon should continue to serve Web Shell, multi-client, and standalone service-deployment scenarios, keeping the two paths clearly separated.

## Direction 3: Improve Information Architecture and Project Context

### Goal

Make a small set of information-architecture improvements so users can clearly distinguish global chats, workspaces, and tasks or sessions within a workspace; understand where existing capabilities such as file preview and the built-in browser belong; and quickly inspect the current project's Git context and change status.

### Settings Placement

Following the ChatGPT/Codex Desktop layout, move Settings from the primary navigation at the top to a fixed position at the bottom of the left sidebar.

This step should only change the location of the Settings entry point. It should not reorganize settings categories or change existing settings content and storage.

### Chats and Workspaces

Chats and Workspaces should be top-level peers in both structure and visual hierarchy:

- Chats: sessions that are not bound to a specific project workspace;
- Workspaces: an explicit list of available workspaces, with the relevant tasks or sessions shown under each workspace.

The proposed structure is:

```text
New chat
Search
Skills
Skill marketplace
Automations

Chats
Workspaces
  workspace-a
    Task / Session 1
    Task / Session 2
  workspace-b
    Task / Session 3

Settings
```

The current interface already displays workspaces and their sessions, but Chats can still be interpreted as another workspace. Near-term changes should focus on clearer top-level grouping, indentation, and selection states rather than expanding into a complete rewrite of the left sidebar.

The final product terminology for Task and Session can remain open for discussion. The first step does not require a broad change to the internal `session` data model.

### File Preview and Built-In Browser

File preview and the dockable built-in browser already have foundational implementations, but their entry points and presentation are fragmented. The information architecture should unify their placement, entry points, and expansion behavior within the right sidebar, while clarifying how they relate to the current session and workspace context.

Direction 1 concerns completing the right-sidebar capabilities themselves. Direction 3 concerns organizing and exposing those capabilities consistently. This phase does not require rewriting the underlying file-preview or browser implementations.

### Project Git Context

Using the environment-information area in the upper-right of the reference interface as a model, add a centralized and discoverable Git context entry point for the current project. It should summarize current changes, workspace location, branch, and common actions such as committing, pushing, and creating a pull request.

Like the left-navigation adjustments, this is a small information-architecture improvement. The goal is to make it immediately clear which project and branch the user is working in, what has changed, and what actions are available next, without attempting to build a complete Git client or complex repository-management system in this phase.

[Issue #4769](https://github.com/QwenLM/qwen-code/issues/4769) previously tracked displaying the Git branch directly in Desktop. [Issue #6699](https://github.com/QwenLM/qwen-code/issues/6699) discusses a unified presentation of workspace, execution context, and Git branch entry points in Web Shell. Although they target different surfaces, both reinforce the need for persistent and clear project context and provide useful references for this information-architecture work.

## Near-Term Scope

The near-term focus is to complete the core structure without broadly reorganizing existing UI and settings details:

- Establish unified entry points for differentiated Desktop capabilities;
- Clarify the shared UI boundary between Electron and a future Desktop WebUI;
- Preserve direct ACP communication for Desktop;
- Make the smallest necessary changes to Settings placement, left-sidebar hierarchy, file and browser entry points, and project Git context;
- Refine details that are not yet clear through continued real-world use.

## Open Questions

1. Are these three directions appropriate as the main near-term focus areas for Desktop?
2. Should the right-hand work surface host Review, Terminal, Browser, Files, and Side Tasks while also becoming a long-term shared context and collaboration surface for the user and the Agent?
3. How should cross-surface reuse of Chat components align with Issue #5883, and does Desktop still need a separate application-level UI layer shared by Electron and a future Desktop WebUI?
4. Should Desktop continue to connect directly to the Qwen Code CLI through ACP by default, without going through daemon?
5. Should Settings move to the bottom, Chats and Workspaces become top-level peers, file preview and built-in browser entry points be unified, and project Git context be centralized in the upper-right area?
