/**
 * Tests for the centralized PreToolUse pipeline.
 *
 * Tests `runPreToolUseChecks()` (6-step pipeline) and `shouldPromptInAskMode()`
 * which are shared by agent backends.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Module mocks (must be before imports of the module under test)
// ============================================================

let mockShouldAllowToolInMode = mock(
  (_toolName: string, _input: Record<string, unknown>, _mode: string, _opts?: any) =>
    ({ allowed: true, reason: '' })
);

let mockIsApiEndpointAllowed = mock(
  (_method: string, _path: string | undefined, _ctx: any) => false
);

let mockIsReadOnlyBashCommandWithConfig = mock(
  (_command: string, _config: any) => false
);

let mockEffectivePermissionMode: 'allow-all' | 'safe' | 'ask' | 'auto-edit' = 'safe';

// Paths resolve from THIS file's location (core/__tests__/)
mock.module('../../mode-manager.ts', () => ({
  shouldAllowToolInMode: (a: any, b: any, c: any, d?: any) => mockShouldAllowToolInMode(a, b, c, d),
  isApiEndpointAllowed: (a: any, b: any, c?: any) => mockIsApiEndpointAllowed(a, b, c),
  isReadOnlyBashCommandWithConfig: (a: any, b: any) => mockIsReadOnlyBashCommandWithConfig(a, b),
  getPermissionModeDiagnostics: () => ({
    permissionMode: mockEffectivePermissionMode,
    modeVersion: 7,
    lastChangedAt: '2026-02-28T18:00:00.000Z',
    lastChangedBy: 'user',
  }),
}));

// Mock permissionsConfigCache for read-only bash pattern checks
let mockReadOnlyBashPatterns: Array<{ regex: RegExp }> = [];

mock.module('../../permissions-config.ts', () => ({
  permissionsConfigCache: {
    getMergedConfig: () => ({
      readOnlyBashPatterns: mockReadOnlyBashPatterns,
    }),
  },
}));

// Mock expandPath to avoid real home directory resolution
mock.module('../../../utils/paths.ts', () => ({
  expandPath: (p: string) => p.replace(/^~/, '/Users/test'),
}));

// Mock filesystem for config validation and skill qualification
mock.module('node:fs', () => ({
  existsSync: (_path: string) => false,
  readFileSync: (_path: string) => '',
}));

// Mock config validators (used by validateConfigWrite + CLI redirect)
let mockDetectConfigFileType = mock((_path: string, _workspaceRootPath?: string) => null as any);
let mockDetectAppConfigFileType = mock((_path: string) => null as any);
let mockValidateConfigFileContent = mock((_type: any, _content: string) => null as any);

mock.module('../../../config/validators.ts', () => ({
  detectConfigFileType: (a: any, b: any) => mockDetectConfigFileType(a, b),
  detectAppConfigFileType: (a: any) => mockDetectAppConfigFileType(a),
  validateConfigFileContent: (a: any, b: any) => mockValidateConfigFileContent(a, b),
  formatValidationResult: () => '',
}));

// Mock skill constants
mock.module('../../../skills/types.ts', () => ({
  AGENTS_PLUGIN_NAME: '.agents',
}));

mock.module('../../../skills/storage.ts', () => ({
  GLOBAL_AGENT_SKILLS_DIR: '/Users/test/.agents/skills',
  PROJECT_AGENT_SKILLS_DIR: '.agents/skills',
}));

let mockCraftAgentsCliFlag = false;
mock.module('../../../feature-flags.ts', () => ({
  FEATURE_FLAGS: {
    get craftAgentsCli() {
      return mockCraftAgentsCliFlag;
    },
    get developerFeedback() {
      return false;
    },
    fastMode: false,
  },
}));

// ============================================================
// Import module under test (after mocks)
// ============================================================

import {
  runPreToolUseChecks,
  shouldPromptInAskMode,
  type PreToolUseInput,
  type PermissionManagerLike,
  type PrerequisiteManagerLike,
} from '../pre-tool-use.ts';

// ============================================================
// Test helpers
// ============================================================

function createMockPermissionManager(overrides?: Partial<PermissionManagerLike>): PermissionManagerLike {
  return {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
    ...overrides,
  };
}

function createMockPrerequisiteManager(overrides?: Partial<PrerequisiteManagerLike>): PrerequisiteManagerLike {
  return {
    checkPrerequisites: () => ({ allowed: true }),
    trackBashSkillRead: () => false,
    ...overrides,
  };
}

function createInput(overrides?: Partial<PreToolUseInput>): PreToolUseInput {
  return {
    toolName: 'Read',
    input: { file_path: '/test/file.ts' },
    sessionId: 'test-session',
    permissionMode: 'allow-all',
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-ws',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: true,
    permissionManager: createMockPermissionManager(),
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('runPreToolUseChecks', () => {
  beforeEach(() => {
    mockEffectivePermissionMode = 'safe';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockIsApiEndpointAllowed.mockReset();
    mockIsApiEndpointAllowed.mockImplementation(() => false);
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
    mockValidateConfigFileContent.mockReset();
    mockValidateConfigFileContent.mockImplementation(() => null);
    mockReadOnlyBashPatterns = [];
    mockCraftAgentsCliFlag = false;
  });

  // ============================================================
  // Step 1: Permission mode check
  // ============================================================

  describe('step 1: permission mode check', () => {
    it('blocks when shouldAllowToolInMode returns not allowed', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Bash is not allowed in Plan mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('Bash is not allowed in Plan mode');
        expect(result.reason).toContain('Effective mode: Plan mode');
        expect(result.reason).toContain('Last mode change: user at 2026-02-28T18:00:00.000Z (modeVersion=7)');
      }
    });

    it('passes through when shouldAllowToolInMode allows', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/test/file.ts' },
      }));

      expect(result.type).toBe('allow');
    });

    it('passes correct args to shouldAllowToolInMode', () => {
      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'safe',
        plansFolderPath: '/test/plans',
        dataFolderPath: '/test/data',
        workspaceRootPath: '/test/workspace',
        activeSourceSlugs: ['linear'],
      }));

      expect(mockShouldAllowToolInMode).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        'safe',
        {
          plansFolderPath: '/test/plans',
          dataFolderPath: '/test/data',
          permissionsContext: {
            workspaceRootPath: '/test/workspace',
            activeSourceSlugs: ['linear'],
          },
        }
      );
    });

    it('uses effective mode from mode-manager diagnostics when incoming mode is stale', () => {
      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'allow-all', // stale incoming value
      }));

      // Mocked diagnostics returns permissionMode='safe', which must be authoritative.
      expect(mockShouldAllowToolInMode).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        'safe',
        expect.any(Object)
      );
    });
  });

  // ============================================================
  // Step 2: Source blocking
  // ============================================================

  describe('step 2: source blocking', () => {
    it('returns source_activation_needed for inactive MCP source (exists)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('source_activation_needed');
      if (result.type === 'source_activation_needed') {
        expect(result.sourceSlug).toBe('linear');
        expect(result.sourceExists).toBe(true);
      }
    });

    it('returns source_activation_needed for inactive MCP source (not exists)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__notion__search',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: [],
      }));

      expect(result.type).toBe('source_activation_needed');
      if (result.type === 'source_activation_needed') {
        expect(result.sourceSlug).toBe('notion');
        expect(result.sourceExists).toBe(false);
      }
    });

    it('allows active MCP source tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('allow');
    });

    it('skips source check for built-in MCP servers (session)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input: {},
        activeSourceSlugs: [],
      }));

      // Should reach step 4 (call_llm intercept), not blocked at step 2
      expect(result.type).toBe('call_llm_intercept');
    });

    it('skips source check for built-in MCP servers (craft-agents-docs)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__craft-agents-docs__search',
        input: {},
        activeSourceSlugs: [],
      }));

      // Should pass through (not source_activation_needed)
      expect(result.type).toBe('allow');
    });

    it('skips source check for non-MCP tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 3: Prerequisite check
  // ============================================================

  describe('step 3: prerequisite check', () => {
    it('blocks when prerequisites are not met', () => {
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({
          allowed: false,
          blockReason: 'Please read the guide.md for linear before using its tools.',
        }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('guide.md');
      }
    });

    it('passes when prerequisites are met', () => {
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({ allowed: true }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('allow');
    });

    it('skips when no prerequisiteManager provided', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        // No prerequisiteManager
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 4: call_llm interception
  // ============================================================

  describe('step 4: call_llm interception', () => {
    it('intercepts mcp__session__call_llm', () => {
      const input = { model: 'haiku', prompt: 'summarize' };
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input,
      }));

      expect(result.type).toBe('call_llm_intercept');
      if (result.type === 'call_llm_intercept') {
        expect(result.input).toEqual(input);
      }
    });

    it('does not intercept other session tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__SubmitPlan',
        input: {},
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 5: Input transforms
  // ============================================================

  describe('step 5: input transforms', () => {
    beforeEach(() => {
      mockCraftAgentsCliFlag = true;
    });

    it('expands tilde paths and returns modify', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/Documents/file.ts' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.file_path).toBe('/Users/test/Documents/file.ts');
      }
    });

    it('does not modify non-tilde paths', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/absolute/path/file.ts' },
      }));

      expect(result.type).toBe('allow');
    });

    it('strips _intent and _displayName metadata', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: { title: 'Bug fix', _intent: 'create issue', _displayName: 'Create Issue' },
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.title).toBe('Bug fix');
        expect(result.input._intent).toBeUndefined();
        expect(result.input._displayName).toBeUndefined();
      }
    });

    it('combines path expansion and metadata stripping', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/test.ts', _intent: 'reading a file' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.file_path).toBe('/Users/test/test.ts');
        expect(result.input._intent).toBeUndefined();
      }
    });

    it('blocks direct label folder reads and suggests craft-agent label help when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/test/workspace/labels/config.json' },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent label');
        expect(result.reason).toContain('craft-agent label --help');
        expect(result.reason).toContain('labels/');
      }
    });

    it('blocks direct label config writes and suggests craft-agent label help when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent label');
        expect(result.reason).toContain('craft-agent label --help');
      }
    });

    it('does not apply config-file CLI redirect when feature is disabled', () => {
      mockCraftAgentsCliFlag = false;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('allow');
    });

    it('does not block label config writes when feature is disabled', () => {
      mockCraftAgentsCliFlag = false;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('allow');
    });

    it('does not block bash commands touching automations files when feature is disabled', () => {
      mockCraftAgentsCliFlag = false;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('blocks direct automations config edits and suggests craft-agent automation commands when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'automations', displayFile: 'automations.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/automations.json',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent automation');
        expect(result.reason).toContain('automations.json');
      }
    });

    it('blocks direct source config edits and suggests craft-agent source commands when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({
        type: 'source',
        slug: 'linear',
        displayFile: 'sources/linear/config.json',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/sources/linear/config.json',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent source');
        expect(result.reason).toContain('sources/linear/config.json');
      }
    });

    it('blocks direct skill file edits and suggests craft-agent skill commands when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({
        type: 'skill',
        slug: 'commit-helper',
        displayFile: 'skills/commit-helper/SKILL.md',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/skills/commit-helper/SKILL.md',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent skill');
        expect(result.reason).toContain('skills/commit-helper/SKILL.md');
      }
    });

    it('blocks bash commands touching labels paths and points to craft-agent label --help when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py labels/config.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent label --help');
        expect(result.reason).toContain('craft-agent label');
      }
    });

    it('allows bash craft-agent label commands through labels guard', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'craft-agent label list' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('blocks bash commands touching automations files and points to craft-agent automation --help when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent automation --help');
        expect(result.reason).toContain('craft-agent automation');
      }
    });

    it('allows bash craft-agent automation commands through config-domain bash guard', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'craft-agent automation list' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not apply config-domain bash guard when feature is disabled', () => {
      mockCraftAgentsCliFlag = false;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not block unrelated non-workspace labels paths in bash commands', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 script.py /tmp/labels/config.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 6: Ask-mode prompt decision
  // ============================================================

  describe('step 6: ask-mode prompt decision', () => {
    beforeEach(() => {
      mockEffectivePermissionMode = 'ask';
    });

    it('prompts for bash commands in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm install express' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
        expect(result.command).toBe('npm install express');
      }
    });

    it('prompts for file write tools in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/file.ts', content: 'hello' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
        expect(result.description).toContain('/test/file.ts');
      }
    });

    it('prompts for Edit in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: { file_path: '/test/file.ts', old_string: 'a', new_string: 'b' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
      }
    });

    it('auto-allows file writes in edit automatically mode', () => {
      mockEffectivePermissionMode = 'auto-edit';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: { file_path: '/test/file.ts', old_string: 'a', new_string: 'b' },
        permissionMode: 'auto-edit',
      }));

      expect(result.type).toBe('allow');
    });

    it('still prompts for bash commands in edit automatically mode', () => {
      mockEffectivePermissionMode = 'auto-edit';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm install express' },
        permissionMode: 'auto-edit',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
      }
    });

    it('does not prompt in allow-all mode', () => {
      mockEffectivePermissionMode = 'allow-all';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not prompt in safe mode (blocked at step 1 instead)', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Blocked in safe mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
    });

    it('includes modifiedInput in prompt when transforms changed the input', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '~/test.ts', content: 'hello', _intent: 'write file' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.modifiedInput).toBeDefined();
        expect(result.modifiedInput!.file_path).toBe('/Users/test/test.ts');
        expect(result.modifiedInput!._intent).toBeUndefined();
      }
    });

    it('omits modifiedInput in prompt when no transforms applied', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm test' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.modifiedInput).toBeUndefined();
      }
    });
  });

  // ============================================================
  // Pipeline ordering
  // ============================================================

  describe('pipeline ordering', () => {
    it('permission check runs before source blocking', () => {
      // If tool is blocked by mode, source blocking should not run
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Not allowed',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('Not allowed');
        expect(result.reason).toContain('Effective mode: Plan mode');
      }
    });

    it('source blocking runs before prerequisite check', () => {
      // Inactive source → source_activation_needed (not prerequisite block)
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({
          allowed: false,
          blockReason: 'Read guide.md first',
        }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('source_activation_needed');
    });

    it('prerequisite check runs before call_llm interception', () => {
      // This scenario is contrived (call_llm is from session server which is exempt
      // from prerequisites), but validates pipeline order for other session tools
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: (toolName: string) => {
          if (toolName === 'mcp__custom__some_tool') {
            return { allowed: false, blockReason: 'blocked' };
          }
          return { allowed: true };
        },
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__custom__some_tool',
        input: {},
        activeSourceSlugs: ['custom'],
        allSourceSlugs: ['custom'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('block');
    });

    it('call_llm interception runs before transforms', () => {
      // call_llm should be intercepted even if input has metadata
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input: { model: 'haiku', _intent: 'summarize' },
      }));

      expect(result.type).toBe('call_llm_intercept');
      if (result.type === 'call_llm_intercept') {
        // Input should be passed through unmodified (no stripping)
        expect(result.input._intent).toBe('summarize');
      }
    });
  });

  // ============================================================
  // Debug callback
  // ============================================================

  describe('debug callback', () => {
    it('calls onDebug when tool is blocked by mode', () => {
      const debugMessages: string[] = [];
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Not allowed in safe mode',
      }));

      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
        onDebug: (msg) => debugMessages.push(msg),
      }));

      expect(debugMessages.length).toBeGreaterThan(0);
      expect(debugMessages[0]).toContain('safe');
      expect(debugMessages[0]).toContain('Bash');
    });

    it('calls onDebug for source activation', () => {
      const debugMessages: string[] = [];

      runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        onDebug: (msg) => debugMessages.push(msg),
      }));

      expect(debugMessages.some(m => m.includes('linear'))).toBe(true);
    });
  });
});

// ============================================================
// shouldPromptInAskMode
// ============================================================

describe('shouldPromptInAskMode', () => {
  let pm: PermissionManagerLike;

  beforeEach(() => {
    pm = createMockPermissionManager();
    mockShouldAllowToolInMode.mockReset();
    mockIsApiEndpointAllowed.mockReset();
    mockIsApiEndpointAllowed.mockImplementation(() => false);
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
    mockValidateConfigFileContent.mockReset();
    mockValidateConfigFileContent.mockImplementation(() => null);
    mockReadOnlyBashPatterns = [];
    mockCraftAgentsCliFlag = false;
  });

  // --- File writes ---

  describe('file write tools', () => {
    it('prompts for Write tool', () => {
      const result = shouldPromptInAskMode('Write', { file_path: '/test/file.ts', content: 'x' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
      expect(result!.description).toContain('/test/file.ts');
    });

    it('prompts for Edit tool', () => {
      const result = shouldPromptInAskMode('Edit', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    it('prompts for MultiEdit tool', () => {
      const result = shouldPromptInAskMode('MultiEdit', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    it('prompts for NotebookEdit with notebook_path', () => {
      const result = shouldPromptInAskMode('NotebookEdit', { notebook_path: '/test/nb.ipynb' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
      expect(result!.description).toContain('/test/nb.ipynb');
    });

    it('auto-allows whitelisted file write tools', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'Write',
      });

      const result = shouldPromptInAskMode('Write', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });
  });

  // --- Bash ---

  describe('bash commands', () => {
    it('prompts for bash commands', () => {
      const result = shouldPromptInAskMode('Bash', { command: 'npm install express' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(result!.command).toBe('npm install express');
    });

    it('auto-allows read-only bash commands (AST-validated)', () => {
      mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => true);

      const result = shouldPromptInAskMode('Bash', { command: 'ls -la' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('does NOT auto-allow bash commands with redirects (e.g. cat > file)', () => {
      // isReadOnlyBashCommandWithConfig uses AST validation which catches redirects
      mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);

      const result = shouldPromptInAskMode('Bash', { command: 'cat /etc/hosts > /tmp/test' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(result!.command).toBe('cat /etc/hosts > /tmp/test');
    });

    it('auto-allows whitelisted non-dangerous commands', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'npm',
        isDangerousCommand: () => false,
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'npm test' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('still prompts for whitelisted dangerous commands', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'rm',
        isDangerousCommand: (cmd) => cmd === 'rm',
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'rm -rf /important' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
    });

    it('auto-allows curl to whitelisted domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'api.example.com',
        isDomainWhitelisted: (domain) => domain === 'api.example.com',
      });

      const result = shouldPromptInAskMode('Bash', { command: 'curl https://api.example.com/data' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('prompts for curl to non-whitelisted domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'evil.com',
        isDomainWhitelisted: () => false,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'curl https://evil.com/data' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
    });
  });

  // --- MCP mutations ---

  describe('MCP mutations', () => {
    it('prompts for MCP mutations (blocked in safe mode)', () => {
      mockShouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: Record<string, unknown>, mode: string) =>
          mode === 'safe' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
      );

      const result = shouldPromptInAskMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('mcp_mutation');
      expect(result!.description).toContain('linear');
    });

    it('auto-allows MCP read-only tools (not blocked in safe mode)', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));

      const result = shouldPromptInAskMode('mcp__linear__listIssues', {}, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows whitelisted MCP mutations', () => {
      mockShouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: Record<string, unknown>, mode: string) =>
          mode === 'safe' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
      );

      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'mcp__linear__createIssue',
      });

      const result = shouldPromptInAskMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).toBeNull();
    });
  });

  // --- API mutations ---

  describe('API mutations', () => {
    it('prompts for non-GET API calls', () => {
      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('api_mutation');
      expect(result!.description).toContain('POST');
    });

    it('auto-allows GET API calls', () => {
      const result = shouldPromptInAskMode('api_github', { method: 'GET', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows API mutations whitelisted in permissions.json', () => {
      mockIsApiEndpointAllowed.mockImplementation(() => true);

      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows API mutations whitelisted in session', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'POST /repos',
      });

      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('defaults to GET for missing method', () => {
      const result = shouldPromptInAskMode('api_github', { path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      // GET → no prompt
      expect(result).toBeNull();
    });
  });

  // --- Non-prompting tools ---

  describe('non-prompting tools', () => {
    it('returns null for Read tool', () => {
      const result = shouldPromptInAskMode('Read', { file_path: '/test/file.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Glob tool', () => {
      const result = shouldPromptInAskMode('Glob', { pattern: '**/*.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Grep tool', () => {
      const result = shouldPromptInAskMode('Grep', { pattern: 'TODO' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Task tool', () => {
      const result = shouldPromptInAskMode('Task', {}, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });
  });
});
