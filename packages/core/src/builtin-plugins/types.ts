/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskRegistry } from '../tasks/task-registry.js';
import type { SkillDefinition } from '@qwen-code/resource';
import type { LocalAgentDefinition } from '../agents/types.js';
import type { OutputStyleConfig } from '../prompts/outputStyles/types.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import type { HostToolChecker } from '../tools/tool-checkers/rule-precedence.js';
import type { CommandHookEnv } from '../hooks/types.js';

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

/** A plugin instance created by the product and initialized when context is ready. */
export interface BuiltinPlugin {
  readonly apiVersion: 1;
  readonly id: string;
  initialize(context: BuiltinPluginContext): Promise<void>;
  getSkillDefinitions?(
    context?: BuiltinPluginSessionContext,
  ): readonly BuiltinPluginSkillDefinition[];
  getHooks?(
    context?: BuiltinPluginSessionContext,
  ): readonly BuiltinHookDefinition[];
  /**
   * Agent definitions registered as trusted built-ins for this product.
   * Return fresh objects on every call: the host tags `metadata.source` on the
   * returned instances and applies settings overrides on top of them.
   */
  getAgentDefinitions?(): readonly LocalAgentDefinition[];
  /** Output styles contributed by this product; visible ones act as built-ins. */
  getOutputStyleDefinitions?(): readonly OutputStyleConfig[];
  getTools?(): readonly AnyDeclarativeTool[];
  /** Read before initialize(), while the host constructs PermissionManager. */
  getToolCheckers?(): ReadonlyMap<string, HostToolChecker>;
  dispose(): Promise<void>;
}

/** Plugin class instantiated by the product; the host supplies context during initialization. */
export interface BuiltinPluginConstructor {
  new (): BuiltinPlugin;
}

export interface BuiltinPluginRuntime {
  /** Prepare shared runtime/auth/network state for one command workspace. */
  prepare(workspacePath: string): Promise<void>;
  /** Read one effective setting section for a workspace on demand. */
  getSetting(workspacePath: string, section: string): Promise<unknown>;
}

/** 宿主向随产品打包的可信 npm 插件提供的能力，不暴露 Core 的 Config 实例。 */
export interface BuiltinPluginContext {
  /** 应用退出只取消尚未完成的准备；不等于某个会话取消。 */
  readonly signal?: AbortSignal;
  /** Generic runtime capabilities used by terminal commands. */
  readonly runtime?: BuiltinPluginRuntime;

  /** 当前启动模式：本地交互式 TUI 为 interactive，非交互入口为 headless。 */
  readonly mode: 'interactive' | 'headless';

  /** 本地交互式 TUI 会话为 true；远程恢复会话与非交互入口不设置。 */
  readonly localSession?: boolean;

  /**
   * Read one launch-scoped setting supplied by the current invocation, such as
   * SDK `--settings` overrides. This does not include user, project, or local
   * settings and does not re-read files after startup.
   */
  getLaunchSetting(section: string): unknown;

  /**
   * 判断配置来源是否被当前 --setting-sources 允许。
   * 插件自行读取配置文件时必须遵守该过滤结果。
   */
  isSettingSourceAllowed(source: 'user' | 'project' | 'local'): boolean;

  /**
   * 插件贡献发生变化后，通知宿主重新读取并加载 Hook/Skill，同时刷新现有展示。
   * 通常用于后台策略更新；宿主配置变更本身已有重载流程，无需重复通知。
   */
  notifyChanged(): Promise<void>;

  /**
   * 宿主基础初始化就绪、首轮资源加载已启动后完成，不代表所有后台加载都已结束。
   * 插件可据此启动后台轮询；不要在 initialize() 中等待它，否则会阻塞宿主就绪。
   */
  whenReady(): Promise<void>;
}

/**
 * Session-scoped view passed to contribution readers. The process-level
 * context above is created once; this view exposes the session that is
 * currently loading skills/hooks.
 */
export interface BuiltinPluginSessionContext {
  /** 当前会话合并后的完整 settings 快照。 */
  getSettings(): unknown;
}

// ---------------------------------------------------------------------------
// Plugin contributions
// ---------------------------------------------------------------------------

export type BuiltinPluginSkillDefinition = SkillDefinition & {
  /**
   * 为 true 时遵守 --disable-builtin-skills / --enable-builtin-skills；
   * 省略 = 保持现状（产品能力类 skill 始终加载，例如 imagegen/security）。
   */
  respectBuiltinSkillSwitch?: boolean;
};

/** Shared fields for builtin hook contributions. */
interface BuiltinHookBaseDefinition {
  event: string;
  matcher?: string;
  timeout?: number;
  sequential?: boolean;
  statusMessage?: string;
}

/** Command-hook contribution. The host validates the event when applying it. */
export interface BuiltinCommandHookDefinition
  extends BuiltinHookBaseDefinition {
  type?: 'command';
  /** Narrow execution to a tool name and optional primary-argument glob. */
  if?: string;
  command: string;
  /** Execute without a shell when args is provided. */
  args?: string[];
  shell?: 'bash' | 'powershell';
  action?: never;
  async?: boolean;
  once?: boolean;
  asyncRewake?: boolean;
  rewakeMessage?: string;
  rewakeSummary?: string;
  pluginRoot?: string;
  pluginId?: string;
  /** Static values or a function resolving the complete hook env on every execution. */
  env?: CommandHookEnv;
}

export interface BuiltinRuntimeFileWrite {
  file_path: string;
  workspace_path: string;
  original_content: string;
  proposed_content: string;
  written_content: string;
  business_id?: string;
  request_set_id?: string;
  /** Optional application-provided context for the completed write. */
  orphan?: boolean;
  task_id?: string;
  config_snapshot_id?: string;
  product?: string;
  scenario?: string;
}

/** Tool facts present for PreToolUse and PostToolUse runtime events. */
export interface BuiltinRuntimeToolUseFacts {
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  mcp_context?: unknown;
  original_request_name?: string;
}

export type BuiltinRuntimeQueryEndReason =
  | 'end_turn'
  | 'abort'
  | 'max_turns'
  | 'error'
  | 'repeated_tool_call_denied';

/** Facts present when a top-level query reaches QueryEnd. */
export interface BuiltinRuntimeQueryEndFacts {
  request_set_id?: string;
  business_id?: string;
  reason?: BuiltinRuntimeQueryEndReason;
}

export type BuiltinRuntimeSessionEndReason =
  | 'clear'
  | 'resume'
  | 'logout'
  | 'prompt_input_exit'
  | 'bypass_permissions_disabled'
  | 'other';

/** Facts present when a session reaches SessionEnd. */
export interface BuiltinRuntimeSessionEndFacts {
  reason?: BuiltinRuntimeSessionEndReason;
}

/** Base input passed to an in-process runtime hook. */
export interface BuiltinRuntimeHookInput extends BuiltinRuntimeToolUseFacts {
  /** Only present on the internal ImagePrepare event. */
  images?: import('../hooks/imagePrepare.js').ImagePrepareInput['images'];
  imageModel?: import('../hooks/imagePrepare.js').ImagePrepareInput['imageModel'];
  failureMode?: 'keep' | 'throw';
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  /** Present on SessionStart. */
  source?: 'startup' | 'resume' | 'clear' | 'new' | 'compact';
  model?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  request_set_id?: string;
  /** Current session workspace directories (target dir + added dirs). */
  workspace_dirs?: readonly string[];
  business_id?: string;
  reason?: BuiltinRuntimeQueryEndReason | BuiltinRuntimeSessionEndReason;
  /** Runtime-only completed-write facts; omitted from serialized hook types. */
  file_write?: BuiltinRuntimeFileWrite;
}

/** General runtime hook output fields understood by the host HookSystem. */
export interface BuiltinRuntimeHookOutput {
  async?: true;
  asyncTimeout?: number;
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  stdoutContent?: string;
  decision?: 'allow' | 'deny' | 'ask' | 'defer';
  reason?: string;
  modelInjection?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

/** Stable owner identity, with live session values. Never exposes Config to hooks. */
export interface BuiltinSessionContext {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly workingDir: string;
  readonly transcriptPath: string;
  readonly taskRegistry: TaskRegistry | undefined;
  readonly disposed: boolean;
  /**
   * Called synchronously when this session runtime's Config is disposed, not
   * when its conversation ID changes (/clear or /resume). Plugins release
   * their own resources. Returns an unsubscribe function; late subscribers
   * are called immediately. Callbacks must perform synchronous teardown.
   */
  onDispose(callback: () => void): () => void;
  getArtifactProjectRoots(): Promise<string[]>;
}

/**
 * Runtime execution context passed to a Runtime hook action alongside the
 * abort signal. Represents the actual runtime of the invocation (not the
 * plugin's initialize-time context) so a plugin can read the currently active
 * session's settings and entry-point flags. Hosts must supply this from the
 * live runtime; they must not construct it from a snapshot taken at plugin
 * initialize. Plugins that receive `undefined` (older dispatchers, tests
 * without a mock) must not fall back to enabling policy-sensitive behavior.
 */
export interface BuiltinRuntimeExecutionContext {
  getSessionContext?(): BuiltinSessionContext;
  /** True for non-interactive SDK entry points and other headless embedders. */
  isSdkMode: boolean;
  /**
   * Read a named setting section from the configuration snapshot loaded at
   * process start. Returns `undefined` when the section is absent or when
   * the host has no settings source wired. The host never returns its Config
   * instance, does not re-read files, and does not know which plugin owns
   * which section. Hot reloads are not observed by this channel; plugins
   * whose behavior depends on settings changes should require a restart.
   */
  getSetting(section: string): unknown;
}

export interface BuiltinRuntimeHookOptions {
  signal: AbortSignal;
  /** Live runtime context for this invocation; see docs on the type. */
  execution?: BuiltinRuntimeExecutionContext;
}

/** In-process equivalent of the host HookAction contract. */
export type BuiltinRuntimeHookAction = (
  input: BuiltinRuntimeHookInput,
  options?: BuiltinRuntimeHookOptions,
) => Promise<BuiltinRuntimeHookOutput | void | null>;

/** In-process runtime-hook contribution. */
export interface BuiltinRuntimeHookDefinition
  extends BuiltinHookBaseDefinition {
  type: 'runtime';
  name: string;
  action: BuiltinRuntimeHookAction;
  /** Product-internal capability that remains active when user hooks are disabled. */
  internal?: boolean;
  /** Allows an already-completed file write to be attributed after cancellation. */
  runAfterCancellation?: 'completed-file-write';
  command?: never;
  async?: never;
  pluginRoot?: never;
  pluginId?: never;
  env?: never;
}

export type BuiltinHookDefinition =
  | BuiltinCommandHookDefinition
  | BuiltinRuntimeHookDefinition;

/**
 * Tools a plugin contributes to the host registry.
 *
 * A tool is an ordinary host tool instance (`DeclarativeTool`), exactly like
 * the CLI's own tools and its slash/terminal command contributions: the plugin
 * constructs it and the host registers it as-is. Contributing a name the host
 * already uses replaces that tool outright; plugins may also add new names.
 */
