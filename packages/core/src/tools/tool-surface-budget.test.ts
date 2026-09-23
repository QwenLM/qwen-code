/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import type { AnyDeclarativeTool } from './tools.js';
import { ToolNames } from './tool-names.js';
import { ArtifactTool } from './artifact/artifact-tool.js';
import type { ArtifactPublisher } from './artifact/publisher.js';
import { AskUserQuestionTool } from './askUserQuestion.js';
import { CreateSubSessionTool } from './create-sub-session.js';
import { CronCreateTool } from './cron-create.js';
import { CronDeleteTool } from './cron-delete.js';
import { CronListTool } from './cron-list.js';
import { DisplayImageTool } from './display-image.js';
import { EditTool } from './edit.js';
import { EnterPlanModeTool } from './enterPlanMode.js';
import { EnterWorktreeTool } from './enter-worktree.js';
import { ExitPlanModeTool } from './exitPlanMode.js';
import { ExitWorktreeTool } from './exit-worktree.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { ImageGenTool } from './image-gen.js';
import { ListAgentsTool } from './list-agents.js';
import { LoopWakeupTool } from './loop-wakeup.js';
import { LSTool } from './ls.js';
import { LspTool } from './lsp.js';
import { MonitorTool } from './monitor.js';
import { NotebookEditTool } from './notebook-edit.js';
import { ReadFileTool } from './read-file.js';
import { ReadMcpResourceTool } from './read-mcp-resource.js';
import { RecordArtifactTool } from './record-artifact.js';
import { RecordSourceTool } from './record-source.js';
import { ReportFindingsTool } from './report-findings.js';
import { RequestShutdownTool } from './request-shutdown.js';
import { RipGrepTool } from './ripGrep.js';
import { SendMessageTool } from './send-message.js';
import { SkillTool } from './skill.js';
import { TaskCreateTool } from './task-create.js';
import { TaskListTool } from './task-list.js';
import { TaskStopTool } from './task-stop.js';
import { TaskUpdateTool } from './task-update.js';
import { TeamCreateTool } from './team-create.js';
import { TeamDeleteTool } from './team-delete.js';
import { TeamPlanApprovalTool } from './team-plan-approval.js';
import { TodoWriteTool } from './todoWrite.js';
import { ToolCallTool } from './tool-call.js';
import { ToolSearchTool } from './tool-search.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { WriteFileTool } from './write-file.js';
import { ZoomImageTool } from './zoom-image.js';
import {
  GetGoalTool,
  ProposeGoalTool,
  UpdateGoalTool,
} from '../goals/goal-tools.js';
import { OmniRecallMediaMemoryTool } from '../omni/recall-media-memory-tool.js';

/**
 * Per-turn size budgets for the rest of the built-in tool surface (#12054).
 *
 * A resident tool's description and parameter schema are sent on every
 * request, so each carries a budget — the discipline `workflow.test.ts`,
 * `agent-description-budget.test.ts` and `shell.test.ts` already apply to the
 * three largest tools. Those keep their own budgets and are not repeated
 * here; this file covers every other built-in tool, and the completeness
 * check at the bottom fails when a tool is added without being placed here.
 *
 * The figure is `JSON.stringify(tool.schema).length` — the declaration as it
 * is serialized into a request — for a tool built against the minimal config
 * below. Budgets are measurement plus about 2%, rounded up to 50: a clause
 * fits, a pasted paragraph does not. Raising one is a normal part of a
 * change that adds guidance; moving it without noticing is what this pins.
 * A description that depends on configuration is budgeted in the shape this
 * config produces: `read_file` here is its text-only form, and a multimodal
 * model gets a longer one.
 *
 * The deferred half pins which tools stay out of the first request. A tool
 * flipping from deferred to resident is the largest per-turn cost change a
 * one-line diff can make, and it should be a visible decision in review.
 */

/**
 * The fewest config answers that let every tool below build its declaration.
 * Anything not listed returns `undefined`, which each constructor treats as
 * "feature unconfigured" — the shape a default install presents.
 */
function minimalConfig(): Config {
  const answers: Record<string, unknown> = {
    getTargetDir: '/project',
    getProjectRoot: '/project',
    getCwd: '/project',
    getWorkingDir: '/project',
    getDebugMode: false,
    getModel: 'qwen3-coder-plus',
    getContentGeneratorConfig: { model: 'qwen3-coder-plus' },
    getApprovalMode: 'default',
    getUseRipgrep: true,
    isTrustedFolder: true,
    getWorkspaceContext: {
      getDirectories: () => ['/project'],
      isPathWithinWorkspace: () => true,
    },
    getSkillManager: {
      addChangeListener: () => () => {},
      listSkills: async () => [],
      isSkillActive: () => false,
    },
    getAgentsSettings: {},
  };
  return new Proxy(
    {},
    {
      get: (_target, property: string) => {
        if (property === 'then') return undefined;
        return () => answers[property];
      },
    },
  ) as Config;
}

function declarationSize(tool: AnyDeclarativeTool): number {
  return JSON.stringify(tool.schema).length;
}

type Build = (config: Config) => AnyDeclarativeTool;

/**
 * Tools whose schema is sent on every request whenever they are registered:
 * not deferred, or deferred but `alwaysLoad` (`exit_plan_mode` must stay
 * declared so plan mode can call it directly, #5210).
 */
const RESIDENT: ReadonlyArray<[name: string, build: Build, budget: number]> = [
  ['team_create', (c) => new TeamCreateTool(c), 7_800],
  ['ask_user_question', (c) => new AskUserQuestionTool(c), 3_100],
  ['read_file', (c) => new ReadFileTool(c), 2_650],
  ['exit_plan_mode', (c) => new ExitPlanModeTool(c), 2_450],
  ['skill', (c) => new SkillTool(c), 2_400],
  ['edit', (c) => new EditTool(c), 2_400],
  ['update_goal', (c) => new UpdateGoalTool(c), 2_050],
  ['todo_write', (c) => new TodoWriteTool(c), 1_950],
  ['write_file', (c) => new WriteFileTool(c), 1_850],
  [
    'artifact',
    (c) => new ArtifactTool(c, {} as unknown as ArtifactPublisher),
    1_800,
  ],
  ['tool_search', (c) => new ToolSearchTool(c), 1_600],
  ['enter_plan_mode', (c) => new EnterPlanModeTool(c), 1_400],
  ['propose_goal', (c) => new ProposeGoalTool(c), 1_350],
  ['task_update', (c) => new TaskUpdateTool(c), 1_250],
  ['notebook_edit', (c) => new NotebookEditTool(c), 1_200],
  ['list_agents', (c) => new ListAgentsTool(c), 1_200],
  ['grep_search (ripgrep)', (c) => new RipGrepTool(c), 1_200],
  ['list_directory', (c) => new LSTool(c), 1_100],
  ['grep_search (fallback)', (c) => new GrepTool(c), 1_050],
  ['glob', (c) => new GlobTool(c), 800],
  ['task_create', (c) => new TaskCreateTool(c), 650],
  ['tool_call', () => new ToolCallTool(), 650],
  ['team_plan_approval', (c) => new TeamPlanApprovalTool(c), 600],
  ['image_gen', (c) => new ImageGenTool(c), 600],
  ['display_image', (c) => new DisplayImageTool(c), 550],
  ['get_goal', (c) => new GetGoalTool(c), 550],
  ['task_list', (c) => new TaskListTool(c), 500],
  ['team_delete', (c) => new TeamDeleteTool(c), 300],
];

/** Tools that stay out of the first request until `tool_search` loads them. */
const DEFERRED: ReadonlyArray<[name: string, build: Build]> = [
  ['create_sub_session', (c) => new CreateSubSessionTool(c)],
  ['cron_create', (c) => new CronCreateTool(c)],
  ['cron_delete', (c) => new CronDeleteTool(c)],
  ['cron_list', (c) => new CronListTool(c)],
  ['enter_worktree', (c) => new EnterWorktreeTool(c)],
  ['exit_worktree', (c) => new ExitWorktreeTool(c)],
  ['loop_wakeup', (c) => new LoopWakeupTool(c)],
  ['lsp', (c) => new LspTool(c)],
  ['monitor', (c) => new MonitorTool(c)],
  ['omni_recall_media_memory', (c) => new OmniRecallMediaMemoryTool(c)],
  ['read_mcp_resource', (c) => new ReadMcpResourceTool(c)],
  ['record_artifact', (c) => new RecordArtifactTool(c)],
  ['record_source', (c) => new RecordSourceTool(c)],
  ['report_findings', () => new ReportFindingsTool()],
  ['request_shutdown', (c) => new RequestShutdownTool(c)],
  ['send_message', (c) => new SendMessageTool(c)],
  ['task_stop', (c) => new TaskStopTool(c)],
  ['web_fetch', (c) => new WebFetchTool(c)],
  ['web_search', (c) => new WebSearchTool(c)],
  ['zoom_image', (c) => new ZoomImageTool(c)],
];

/** Built-in tool names that are measured elsewhere, or not measurable here. */
const NOT_BUDGETED_HERE: Readonly<Record<string, string>> = {
  [ToolNames.AGENT]: 'agent-description-budget.test.ts',
  [ToolNames.SHELL]: 'shell.test.ts, per shell shape',
  [ToolNames.WORKFLOW]: 'workflow.test.ts',
  [ToolNames.EXEC]:
    'code mode declares exec with every bound tool folded into its description (tool-registry.ts), not this class schema',
  [ToolNames.STRUCTURED_OUTPUT]: 'its schema is the user-supplied JSON Schema',
  [ToolNames.MEMORY]: 'legacy name, no longer registered as a tool',
};

/** Media-policy tools are generated from settings, so their size is not fixed. */
function isMediaPolicyTool(name: string): boolean {
  return (
    name.startsWith('omni_') && name !== ToolNames.OMNI_RECALL_MEDIA_MEMORY
  );
}

describe('built-in tool surface budget (#12054)', () => {
  describe.each(RESIDENT)('%s', (_name, build, budget) => {
    it('is sent with every request', () => {
      const tool = build(minimalConfig());
      expect(tool.shouldDefer && !tool.alwaysLoad).toBe(false);
    });

    it(`declaration stays within ${budget} characters`, () => {
      expect(declarationSize(build(minimalConfig()))).toBeLessThanOrEqual(
        budget,
      );
    });
  });

  it.each(DEFERRED)('%s stays deferred', (_name, build) => {
    const tool = build(minimalConfig());
    expect(tool.shouldDefer).toBe(true);
    expect(tool.alwaysLoad).toBe(false);
  });

  it('places every built-in tool name', () => {
    const placed = new Set<string>([
      ...[...RESIDENT, ...DEFERRED].map(
        ([, build]) => build(minimalConfig()).name,
      ),
      ...Object.keys(NOT_BUDGETED_HERE),
    ]);
    const unplaced = Object.values(ToolNames).filter(
      (name) => !placed.has(name) && !isMediaPolicyTool(name),
    );

    expect(unplaced).toEqual([]);
  });
});

/**
 * The other half of a budget: clauses a trim to meet one must not remove.
 * #12054 removed restatements from these descriptions; what remains is the
 * contract the model calls against, and a smaller declaration would pass
 * every ceiling above.
 */
describe('trimmed descriptions keep their load-bearing clauses (#12054)', () => {
  it.each([
    [
      'edit',
      (c: Config) => new EditTool(c),
      [
        'tool to examine the file',
        'MUST be the exact literal text to replace',
        'Include at least 3 lines of context BEFORE and AFTER',
        'NEVER escape `old_string` or `new_string`',
        'The user has the ability to modify the `new_string` content',
      ],
    ],
    [
      'glob',
      (c: Config) => new GlobTool(c),
      ['Supports glob patterns', 'sorted by modification time'],
    ],
    [
      'grep_search (ripgrep)',
      (c: Config) => new RipGrepTool(c),
      [
        'NEVER invoke `grep` or `rg` as a Bash command',
        'special regex characters need escaping',
      ],
    ],
    [
      'grep_search (fallback)',
      (c: Config) => new GrepTool(c),
      [
        'NEVER invoke `grep` or `rg` as a Bash command',
        'Case-insensitive by default',
      ],
    ],
    [
      'read_file',
      (c: Config) => new ReadFileTool(c),
      [
        'MUST be an absolute path',
        "use the 'pages' parameter",
        'Jupyter notebooks return structured cell content with outputs',
        'this transcription is lossy and marked as untrusted',
      ],
    ],
  ] as const)('%s', (_name, build, clauses) => {
    const description = build(minimalConfig()).schema.description ?? '';
    for (const clause of clauses) {
      expect(description).toContain(clause);
    }
  });
});
