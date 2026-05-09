#!/usr/bin/env bun
/**
 * Debug script to print the full Qwen Code system prompt with annotations.
 * Shows both the static system prompt and dynamic user message context components.
 *
 * Run with: bun run print:system-prompt
 */

import { getSystemPrompt, getDateTimeContext, getWorkingDirectoryContext } from './system.ts';
import { formatSessionState } from '../agent/mode-manager.ts';

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

function printHeader(title: string, bgColor: string = colors.bgBlue) {
  const padding = ' '.repeat(Math.max(0, 78 - title.length));
  console.log(`\n${bgColor}${colors.bold} ${title}${padding} ${colors.reset}`);
}

function printSection(title: string, content: string, color: string = colors.cyan) {
  console.log('\n' + '─'.repeat(80));
  console.log(`${color}${colors.bold}▶ ${title}${colors.reset}`);
  console.log('─'.repeat(80));
  console.log(content);
}

function printAnnotation(text: string) {
  console.log(`${colors.dim}${colors.yellow}// ${text}${colors.reset}`);
}

// ============================================================
// MAIN OUTPUT
// ============================================================

console.log(`
${colors.bgMagenta}${colors.bold}                                                                                ${colors.reset}
${colors.bgMagenta}${colors.bold}                    CRAFT AGENT SYSTEM PROMPT BREAKDOWN                         ${colors.reset}
${colors.bgMagenta}${colors.bold}                                                                                ${colors.reset}
`);

// ------------------------------------------------------------
// PART 1: STATIC SYSTEM PROMPT
// ------------------------------------------------------------

printHeader('PART 1: STATIC SYSTEM PROMPT (systemPrompt.append)');
printAnnotation('Built once per session, passed to SDK, enables prompt caching');
printAnnotation('');
printAnnotation('Composed of:');
printAnnotation('  1. User Preferences (if set) - formatPreferencesForPrompt()');
printAnnotation('  2. Qwen Code Environment Marker - version, platform, arch');
printAnnotation('  3. Core Instructions - capabilities, sources, guidelines');
printAnnotation('  4. Configuration Documentation Refs - permissions, skills, themes, statuses');
printAnnotation('  5. Permission Modes Documentation - inlined in system prompt');
printAnnotation('  6. Error Handling & Tool Metadata - guidelines for tool usage');
printAnnotation('  7. Debug Mode Context (if enabled) - formatDebugModeContext()');

const systemPrompt = getSystemPrompt(
  undefined, // No pinned preferences (use current from disk)
  { enabled: false }, // Debug mode disabled for cleaner output
  '/Users/example/.craft-agent/workspaces/abc123' // Example workspace path
);

printSection('FULL STATIC SYSTEM PROMPT', systemPrompt, colors.green);

console.log(`\n${colors.bold}Static System Prompt Length: ${systemPrompt.length.toLocaleString()} characters${colors.reset}`);

// Show with debug mode enabled
const systemPromptWithDebug = getSystemPrompt(
  undefined,
  { enabled: true, logFilePath: '~/Library/Logs/@craft-agent/electron/main.log' },
  '/Users/example/.craft-agent/workspaces/abc123'
);
console.log(`${colors.dim}With debug mode: ${systemPromptWithDebug.length.toLocaleString()} characters (+${(systemPromptWithDebug.length - systemPrompt.length).toLocaleString()})${colors.reset}`);

// ------------------------------------------------------------
// PART 2: DYNAMIC USER MESSAGE CONTEXT
// ------------------------------------------------------------

printHeader('PART 2: DYNAMIC USER MESSAGE CONTEXT (per message)');
printAnnotation('These components are prepended to every user message');
printAnnotation('Placed in user messages (not system prompt) to enable prompt caching');

// 1. Date/Time
printSection('1. DATE/TIME CONTEXT - getDateTimeContext()', getDateTimeContext(), colors.magenta);
printAnnotation('Added first to user message for prompt caching optimization');

// 2. Session State
const sessionState = formatSessionState('260121-example-session', {
  plansFolderPath:
    '/Users/example/.craft-agent/workspaces/abc123/sessions/260121-example-session/plans',
});
printSection('2. SESSION STATE - formatSessionState()', sessionState, colors.magenta);
printAnnotation('Contains: sessionId, permissionMode, modeTransition/modeChangedBy/modeChangedAt/modeVersion (when available), plansFolderPath');

// 3. Source State (example - can't call formatSourceState without agent instance)
const exampleSourceState = `<sources>
Active: linear, github
Inactive: slack (inactive), notion (needs auth)

New:
- linear: Project and issue tracking for software teams

<source_issue source="notion">
Authentication required. Use the source_oauth_trigger tool to authenticate.
</source_issue>
</sources>`;
printSection('3. SOURCE STATE - formatSourceState() [example]', exampleSourceState, colors.magenta);
printAnnotation('Generated by CraftAgent.formatSourceState() - requires agent instance');
printAnnotation('Tracks: active sources, inactive sources, new sources (first time seen), auth issues');

// 4. Workspace Capabilities
const exampleCapabilities = `<workspace_capabilities>
local-mcp: enabled (stdio subprocess servers supported)
</workspace_capabilities>`;
printSection(
  '4. WORKSPACE CAPABILITIES - formatWorkspaceCapabilities()',
  exampleCapabilities,
  colors.magenta
);
printAnnotation('Shows whether local MCP stdio servers are enabled for the workspace');

// 5. Working Directory Context
const workingDirContext = getWorkingDirectoryContext(
  '/Users/example/projects/my-app',
  false, // Not session root
  undefined // No bash cwd mismatch
);
printSection(
  '5. WORKING DIRECTORY - getWorkingDirectoryContext()',
  workingDirContext || '(empty - no working directory)',
  colors.magenta
);
printAnnotation('Contains: working_directory path, working_directory_context explanation');
printAnnotation('If project context file exists, includes <project_context_file> tag (agent reads via Read tool)');

// 6. Recovery Context (example)
const exampleRecoveryContext = `<recovery_context>
This session was interrupted and is being recovered. Here's a summary of the previous conversation:
[Summary of previous messages would appear here]
</recovery_context>`;
printSection(
  '6. RECOVERY CONTEXT - buildRecoveryContext() [only on resume]',
  exampleRecoveryContext,
  colors.magenta
);
printAnnotation('Only added when resuming a session after SDK resume fails');
printAnnotation('Contains summary of previous conversation for context continuity');

// ------------------------------------------------------------
// PART 3: COMPLETE USER MESSAGE STRUCTURE
// ------------------------------------------------------------

printHeader('PART 3: COMPLETE USER MESSAGE STRUCTURE');
printAnnotation('How a user message looks after all context is injected');

const completeUserMessage = `${getDateTimeContext()}

${sessionState}

<sources>
Active: linear
Inactive: slack (inactive)
</sources>

<workspace_capabilities>
local-mcp: enabled (stdio subprocess servers supported)
</workspace_capabilities>

<working_directory>/Users/example/projects/my-app</working_directory>

<working_directory_context>The user explicitly selected this as the working directory for this session.</working_directory_context>

<project_context_file>AGENTS.md</project_context_file>

What files are in the src directory?`;

printSection('COMPLETE USER MESSAGE (example)', completeUserMessage, colors.green);

// ------------------------------------------------------------
// SUMMARY
// ------------------------------------------------------------

console.log(`
${colors.bgMagenta}${colors.bold}                                                                                ${colors.reset}
${colors.bgMagenta}${colors.bold}                              SUMMARY                                           ${colors.reset}
${colors.bgMagenta}${colors.bold}                                                                                ${colors.reset}

${colors.bold}SDK Configuration:${colors.reset}
  systemPrompt.append: getSystemPrompt() ${colors.dim}// Qwen Code additions (static, cacheable)${colors.reset}

${colors.bold}Static System Prompt Components:${colors.reset}
  1. User Preferences (if set)           ${colors.dim}// formatPreferencesForPrompt()${colors.reset}
  2. Qwen Code Environment Marker      ${colors.dim}// Version, platform, arch${colors.reset}
  3. Core Instructions                   ${colors.dim}// Capabilities, sources, guidelines${colors.reset}
  4. Configuration Documentation Refs    ${colors.dim}// Permissions, skills, themes, statuses${colors.reset}
  5. Permission Modes Documentation      ${colors.dim}// Inlined in system prompt${colors.reset}
  6. Error Handling & Tool Metadata      ${colors.dim}// Guidelines for tool usage${colors.reset}
  7. Debug Mode Context (if enabled)     ${colors.dim}// formatDebugModeContext()${colors.reset}

${colors.bold}Dynamic User Message Components (per message):${colors.reset}
  1. Date/Time Context                   ${colors.dim}// getDateTimeContext()${colors.reset}
  2. Session State                       ${colors.dim}// formatSessionState()${colors.reset}
  3. Source State                        ${colors.dim}// formatSourceState()${colors.reset}
  4. Workspace Capabilities              ${colors.dim}// formatWorkspaceCapabilities()${colors.reset}
  5. Working Directory + project_context_file  ${colors.dim}// getWorkingDirectoryContext()${colors.reset}
  6. Recovery Context (on resume only)   ${colors.dim}// buildRecoveryContext()${colors.reset}
  7. File Attachments                    ${colors.dim}// Inline paths or base64${colors.reset}
  8. User Message Text                   ${colors.dim}// The actual user input${colors.reset}

${colors.bold}Key Files:${colors.reset}
  packages/shared/src/prompts/system.ts          ${colors.dim}// Main prompt assembly${colors.reset}
  packages/shared/src/agent/craft-agent.ts       ${colors.dim}// User message building${colors.reset}
  packages/shared/src/agent/mode-manager.ts      ${colors.dim}// Permission modes${colors.reset}
  packages/shared/src/config/preferences.ts      ${colors.dim}// User preferences${colors.reset}
`);
