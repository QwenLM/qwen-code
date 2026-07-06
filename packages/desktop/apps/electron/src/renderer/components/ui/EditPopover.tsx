/**
 * EditPopover
 *
 * A popover with title, subtitle, and multiline textarea for editing settings.
 * Supports two modes:
 * - Legacy: Opens a new focused window with a chat session
 * - Inline: Executes mini agent inline within the popover using compact ChatDisplay
 */

import * as React from 'react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { GripHorizontal } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion' // motion used for backdrop only
import { Popover, PopoverTrigger, PopoverContent } from './popover'
import { Button } from './button'
import { cn } from '@/lib/utils'
import { usePlatform } from '@craft-agent/ui'
import type { ContentBadge, Session, CreateSessionOptions } from '../../../shared/types'
import { useActiveWorkspace, useAppShellContext, useSession, usePendingPermission, usePendingCredential } from '@/context/AppShellContext'
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext'
import { ChatDisplay } from '../app-shell/ChatDisplay'

/** Rotating placeholder keys for compact mode input - short, action-oriented */
const COMPACT_PLACEHOLDER_KEYS = [
  'editPopover.placeholder1',
  'editPopover.placeholder2',
  'editPopover.placeholder3',
] as const

/**
 * Context passed to the new chat session so the agent knows exactly
 * what is being edited and can execute quickly.
 *
 * Simplified structure: label for display, filePath for the agent to know
 * where to edit, and optional context for additional instructions.
 */
export interface EditContext {
  /** Human-readable label for badge display and agent context (e.g., "Permissions") */
  label: string
  /** Absolute path to the file being edited */
  filePath: string
  /** Optional additional context/instructions for the agent */
  context?: string
}

/* ============================================================================
 * EDIT CONTEXT REGISTRY - SINGLE SOURCE OF TRUTH
 * ============================================================================
 * ALL edit contexts MUST be defined here. This is the canonical location.
 *
 * DO NOT create EditContext objects inline elsewhere in the codebase.
 * Instead, use getEditConfig() exported from this file.
 *
 * To add a new edit context:
 * 1. Add a new key to EditContextKey type
 * 2. Add the config to EDIT_CONFIGS
 * 3. Use via getEditConfig(key, location)
 *
 * This pattern ensures:
 * - All edit prompts and examples are reviewed in one place
 * - Consistent messaging to the agent
 * - Easy updates when context format changes
 * ============================================================================ */

/** Available edit context keys - add new ones here */
export type EditContextKey =
  | 'workspace-permissions'
  | 'default-permissions'
  | 'skill-instructions'
  | 'skill-metadata'
  | 'source-guide'
  | 'source-config'
  | 'source-permissions'
  | 'source-tool-permissions'
  | 'preferences-notes'
  | 'add-source'
  | 'add-source-api'   // Filter-specific: user is viewing APIs
  | 'add-source-mcp'   // Filter-specific: user is viewing MCPs
  | 'add-source-local' // Filter-specific: user is viewing Local Folders
  | 'add-skill'
  | 'edit-statuses'
  | 'edit-labels'
  | 'edit-auto-rules'
  | 'add-label'
  | 'edit-views'
  | 'edit-tool-icons'
  | 'automation-config'

/**
 * Full edit configuration including context for agent and example for UI.
 * Returned by getEditConfig() for use in EditPopover.
 */
export interface EditConfig {
  /** Context passed to the agent */
  context: EditContext
  /** Example text shown in the popover placeholder */
  example: string
  /** Optional custom placeholder text - overrides the default "Describe what you'd like to change" */
  overridePlaceholder?: string
  /** Translated display label for UI (resolved from displayLabelKey, falls back to context.label) */
  displayLabel?: string
  /** i18n key for the display label (translated for UI, keeps context.label in English for agent) */
  displayLabelKey?: string
  /** i18n key for the example text */
  exampleKey?: string
  /** i18n key for overridePlaceholder */
  overridePlaceholderKey?: string
  /** Model tier hint: 'fast' uses the connection's mini model, 'default' uses the primary model */
  model?: 'fast' | 'default'
  /** Optional system prompt preset for mini agent (e.g., 'mini' for focused edits) */
  systemPromptPreset?: 'default' | 'mini'
  /** When true, executes inline within the popover instead of opening a new window */
  inlineExecution?: boolean
}

/**
 * Registry of all edit configurations.
 * Each entry contains all strings needed for the edit popover and agent context.
 */
const EDIT_CONFIGS: Record<EditContextKey, (location: string) => EditConfig> = {
  'workspace-permissions': (location) => ({
    context: {
      label: 'Permission Settings',
      filePath: `${location}/permissions.json`,
      context:
        'The user is on the Settings Screen and pressed the edit button on Workspace Permission settings. ' +
        'Their intent is likely to update the setting immediately unless otherwise specified. ' +
        'The permissions.json file configures Plan mode rules. It can contain: allowedBashPatterns, ' +
        'allowedMcpPatterns, allowedApiEndpoints, blockedTools, and allowedWritePaths. ' +
        'After editing, call config_validate with target "permissions" to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: "Allow running 'make build' in Plan mode",
    displayLabelKey: 'editPopover.label.permissionSettings',
    exampleKey: 'editPopover.example.workspacePermissions',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'default-permissions': (location) => ({
    context: {
      label: 'Default Permissions',
      filePath: location, // location is the full path for default permissions
      context:
        'The user is editing app-level default permissions (~/.craft-agent/permissions/default.json). ' +
        'This file configures Plan mode rules that apply to ALL workspaces. ' +
        'It can contain: allowedBashPatterns, allowedMcpPatterns, allowedApiEndpoints, blockedTools, and allowedWritePaths. ' +
        'Each pattern can be a string or an object with pattern and comment fields. ' +
        'Be careful - these are app-wide defaults. ' +
        'After editing, call config_validate with target "permissions" to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Allow git fetch command',
    displayLabelKey: 'editPopover.label.defaultPermissions',
    exampleKey: 'editPopover.example.defaultPermissions',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  // Skill editing contexts
  'skill-instructions': (location) => ({
    context: {
      label: 'Skill Instructions',
      filePath: `${location}/SKILL.md`,
      context:
        'The user is editing skill instructions in SKILL.md. ' +
        'IMPORTANT: Preserve the YAML frontmatter (between --- markers) at the top of the file. ' +
        'Focus on editing the markdown content after the frontmatter. ' +
        'The skill instructions guide the AI on how to use this skill. ' +
        'After editing, call skill_validate with the skill slug to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Add error handling guidelines',
    displayLabelKey: 'editPopover.label.skillInstructions',
    exampleKey: 'editPopover.example.skillInstructions',
    model: 'fast',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'skill-metadata': (location) => ({
    context: {
      label: 'Skill Metadata',
      filePath: `${location}/SKILL.md`,
      context:
        'The user is editing skill metadata in the YAML frontmatter of SKILL.md. ' +
        'Frontmatter fields: name (required), description (required), globs (optional array), alwaysAllow (optional array), requiredSources (optional array of source slugs), icon (optional string — emoji or URL). ' +
        'Keep the content after the frontmatter unchanged unless specifically requested. ' +
        'After editing, call skill_validate with the skill slug to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Update the skill description',
    displayLabelKey: 'editPopover.label.skillMetadata',
    exampleKey: 'editPopover.example.skillMetadata',
    model: 'fast',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  // Source editing contexts
  'source-guide': (location) => ({
    context: {
      label: 'Source Documentation',
      filePath: `${location}/guide.md`,
      context:
        'The user is editing source documentation (guide.md). ' +
        'This file provides context to the AI about how to use this source - rate limits, API patterns, best practices. ' +
        'Keep content clear and actionable. ' +
        'Confirm clearly when done.',
    },
    example: 'Add rate limit documentation',
    displayLabelKey: 'editPopover.label.sourceDocumentation',
    exampleKey: 'editPopover.example.sourceGuide',
    model: 'fast',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'source-config': (location) => ({
    context: {
      label: 'Source Configuration',
      filePath: `${location}/config.json`,
      context:
        'The user is editing source configuration (config.json). ' +
        'Be careful with JSON syntax. Fields include: type, slug, name, tagline, iconUrl, and transport-specific settings (mcp, api, local). ' +
        'Do NOT modify the slug unless explicitly requested. ' +
        'After editing, call source_test with the source slug to verify the configuration. ' +
        'Confirm clearly when done.',
    },
    example: 'Update the display name',
    displayLabelKey: 'editPopover.label.sourceConfiguration',
    exampleKey: 'editPopover.example.sourceConfig',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'source-permissions': (location) => ({
    context: {
      label: 'Source Permissions',
      filePath: `${location}/permissions.json`,
      context:
        'The user is editing source-level permissions (permissions.json). ' +
        'These rules are auto-scoped to this source - write simple patterns without prefixes. ' +
        'For MCP: use allowedMcpPatterns (e.g., "list", "get"). For API: use allowedApiEndpoints. ' +
        'After editing, call config_validate with target "permissions" and the source slug to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Allow list operations in Plan mode',
    displayLabelKey: 'editPopover.label.sourcePermissions',
    exampleKey: 'editPopover.example.sourcePermissions',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'source-tool-permissions': (location) => ({
    context: {
      label: 'Tool Permissions',
      filePath: `${location}/permissions.json`,
      context:
        'The user is viewing the Tools list for an MCP source and wants to modify tool permissions. ' +
        'Edit the permissions.json file to control which tools are allowed in Plan mode. ' +
        'Use allowedMcpPatterns to allow specific tools (e.g., ["list_*", "get_*"] for read-only). ' +
        'Use blockedTools to explicitly block specific tools. ' +
        'Patterns are auto-scoped to this source. ' +
        'After editing, call config_validate with target "permissions" and the source slug to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Only allow read operations (list, get, search)',
    displayLabelKey: 'editPopover.label.toolPermissions',
    exampleKey: 'editPopover.example.sourceToolPermissions',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  // Preferences editing context
  'preferences-notes': (location) => ({
    context: {
      label: 'Preferences Notes',
      filePath: location, // location is the full path for preferences
      context:
        'The user is editing the notes field in their preferences (~/.craft-agent/preferences.json). ' +
        'This is a JSON file. Only modify the "notes" field unless explicitly asked otherwise. ' +
        'The notes field is free-form text that provides context about the user to the AI. ' +
        'After editing, call config_validate with target "preferences" to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Add coding style preferences',
    displayLabelKey: 'editPopover.label.preferencesNotes',
    exampleKey: 'editPopover.example.preferencesNotes',
    model: 'fast',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  // Add new source/skill contexts - use overridePlaceholder for inspiring, contextual prompts
  'add-source': (location) => ({
    context: {
      label: 'Add Source',
      filePath: `${location}/sources/`, // location is the workspace root path
      context:
        'The user wants to add a new source to their workspace. ' +
        'Sources can be MCP servers (HTTP/SSE or stdio), REST APIs, or local filesystems. ' +
        'Ask clarifying questions if needed: What service? MCP or API? Auth type? ' +
        'Create the source folder and config.json in the workspace sources directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/sources.md. ' +
        'After creating the source, call source_test with the source slug to verify the configuration.',
    },
    example: 'Connect to my Craft space',
    overridePlaceholder: 'What would you like to connect?',
    displayLabelKey: 'editPopover.label.addSource',
    exampleKey: 'editPopover.example.addSource',
    overridePlaceholderKey: 'editPopover.placeholder.addSource',
  }),

  // Filter-specific add-source contexts: user is viewing a filtered list and wants to add that type
  'add-source-api': (location) => ({
    context: {
      label: 'Add API',
      filePath: `${location}/sources/`,
      context:
        'The user is viewing API sources and wants to add a new REST API. ' +
        'Default to creating an API source (type: "api") unless they specify otherwise. ' +
        'APIs connect to REST endpoints with authentication (bearer, header, basic, or query). ' +
        'Ask about the API endpoint URL and auth type. ' +
        'Create the source folder and config.json in the workspace sources directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/sources.md. ' +
        'After creating the source, call source_test with the source slug to verify the configuration.',
    },
    example: 'Connect to the GitHub API',
    overridePlaceholder: 'What API would you like to connect?',
    displayLabelKey: 'editPopover.label.addApi',
    exampleKey: 'editPopover.example.addSourceApi',
    overridePlaceholderKey: 'editPopover.placeholder.addSourceApi',
  }),

  'add-source-mcp': (location) => ({
    context: {
      label: 'Add MCP Server',
      filePath: `${location}/sources/`,
      context:
        'The user is viewing MCP sources and wants to add a new MCP server. ' +
        'Default to creating an MCP source (type: "mcp") unless they specify otherwise. ' +
        'MCP servers can use HTTP/SSE transport (remote) or stdio transport (local subprocess). ' +
        'Ask about the service they want to connect to and whether it\'s a remote URL or local command. ' +
        'Create the source folder and config.json in the workspace sources directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/sources.md. ' +
        'After creating the source, call source_test with the source slug to verify the configuration.',
    },
    example: 'Connect to Linear',
    overridePlaceholder: 'What MCP server would you like to connect?',
    displayLabelKey: 'editPopover.label.addMcpServer',
    exampleKey: 'editPopover.example.addSourceMcp',
    overridePlaceholderKey: 'editPopover.placeholder.addSourceMcp',
  }),

  'add-source-local': (location) => ({
    context: {
      label: 'Add Local Folder',
      filePath: `${location}/sources/`,
      context:
        'The user wants to add a local folder source. ' +
        'First, look up the guide: mcp__craft-agents-docs__SearchCraftAgents({ query: "filesystem" }). ' +
        'Local folders are bookmarks - use type: "local" with a local.path field. ' +
        'They use existing Read, Write, Glob, Grep tools - no MCP server needed. ' +
        'If unclear, ask about the folder path they want to connect. ' +
        'Create the source folder and config.json in the workspace sources directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/sources.md. ' +
        'After creating the source, call source_test with the source slug to verify the configuration.',
    },
    example: 'Connect to my Obsidian vault',
    overridePlaceholder: 'What folder would you like to connect?',
    displayLabelKey: 'editPopover.label.addLocalFolder',
    exampleKey: 'editPopover.example.addSourceLocal',
    overridePlaceholderKey: 'editPopover.placeholder.addSourceLocal',
  }),

  'add-skill': (location) => ({
    context: {
      label: 'Add Skill',
      filePath: `${location}/skills/`, // location is the workspace root path
      context:
        'The user wants to add a new skill to their workspace. ' +
        'Skills are specialized instructions with a SKILL.md file containing YAML frontmatter (name, description) and markdown instructions. ' +
        'Ask clarifying questions if needed: What should the skill do? When should it trigger? ' +
        'Create the skill folder and SKILL.md in the workspace skills directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/skills.md. ' +
        'After creating the skill, call skill_validate with the skill slug to verify the SKILL.md file.',
    },
    example: 'Review PRs following our code standards',
    overridePlaceholder: 'What should I learn to do?',
    displayLabelKey: 'editPopover.label.addSkill',
    exampleKey: 'editPopover.example.addSkill',
    overridePlaceholderKey: 'editPopover.placeholder.addSkill',
  }),

  // Status configuration context
  'edit-statuses': (location) => ({
    context: {
      label: 'Status Configuration',
      filePath: `${location}/statuses/config.json`,
      context:
        'The user wants to customize session statuses (workflow states). ' +
        'Statuses are stored in statuses/config.json with fields: id, label, icon, category (open/closed), order, isFixed, isDefault. ' +
        'Fixed statuses (todo, done, cancelled) cannot be deleted but can be reordered or have their label changed. ' +
        'Icon can be an emoji, an https URL, or a local filename like "name.svg" that maps to statuses/icons/name.svg. ' +
        'Category "open" shows in inbox, "closed" shows in archive. ' +
        'After editing, call config_validate with target "statuses" to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Add a "Blocked" status',
    displayLabelKey: 'editPopover.label.statusConfiguration',
    exampleKey: 'editPopover.example.editStatuses',
    model: 'fast',               // Use fast model for quick config edits
    systemPromptPreset: 'mini',   // Use focused mini prompt
    inlineExecution: true,        // Execute inline in popover
  }),

  // Label configuration context
  'edit-labels': (location) => ({
    context: {
      label: 'Label Configuration',
      filePath: `${location}/labels/config.json`,
      context:
        'The user wants to customize session labels (tagging/categorization). ' +
        'Labels are stored in labels/config.json as a hierarchical tree. ' +
        'Each label has: id (slug, globally unique), name (display), color (optional EntityColor), children (sub-labels array). ' +
        'Colors use EntityColor format: string shorthand (e.g. "blue") or { light, dark } object for theme-aware colors. ' +
        'Labels are color-only (no icons) — rendered as colored circles in the UI. ' +
        'Children form a recursive tree structure — array position determines display order. ' +
        'Read ~/.craft-agent/docs/labels.md for full format reference. ' +
        'Confirm clearly when done.',
    },
    example: 'Add a "Bug" label with red color',
    displayLabelKey: 'editPopover.label.labelConfiguration',
    exampleKey: 'editPopover.example.editLabels',
    model: 'fast',               // Use fast model for quick config edits
    systemPromptPreset: 'mini',   // Use focused mini prompt
    inlineExecution: true,        // Execute inline in popover
  }),

  // Auto-label rules context (focused on regex patterns within labels)
  'edit-auto-rules': (location) => ({
    context: {
      label: 'Auto-Apply Rules',
      filePath: `${location}/labels/config.json`,
      context:
        'The user wants to edit auto-apply rules (regex patterns that auto-tag sessions). ' +
        'Rules live inside the autoRules array on individual labels in labels/config.json. ' +
        'Each rule has: pattern (regex with capture groups), flags (default "gi"), valueTemplate ($1/$2 substitution), description. ' +
        'Multiple rules on the same label = multiple ways to trigger. The "g" flag is always enforced. ' +
        'Avoid catastrophic backtracking patterns (e.g., (a+)+). ' +
        'Read ~/.craft-agent/docs/labels.md for full format reference. ' +
        'Confirm clearly when done.',
    },
    example: 'Add a rule to detect GitHub issue URLs',
    displayLabelKey: 'editPopover.label.autoApplyRules',
    exampleKey: 'editPopover.example.editAutoRules',
    model: 'fast',               // Use fast model for quick config edits
    systemPromptPreset: 'mini',   // Use focused mini prompt
    inlineExecution: true,        // Execute inline in popover
  }),

  // Add new label context (triggered from the # menu when no labels match)
  'add-label': (location) => ({
    context: {
      label: 'Add Label',
      filePath: `${location}/labels/config.json`,
      context:
        'The user wants to create a new label from the # inline menu. ' +
        'Labels are stored in labels/config.json as a hierarchical tree. ' +
        'Each label has: id (slug, globally unique), name (display), color (optional EntityColor), children (sub-labels array). ' +
        'Colors use EntityColor format: string shorthand (e.g. "blue") or { light, dark } object for theme-aware colors. ' +
        'Labels are color-only (no icons) — rendered as colored circles in the UI. ' +
        'Read ~/.craft-agent/docs/labels.md for full format reference. ' +
        'Confirm clearly when done.',
    },
    example: 'A red "Bug" label',
    overridePlaceholder: 'What label would you like to create?',
    displayLabelKey: 'editPopover.label.addLabel',
    exampleKey: 'editPopover.example.addLabel',
    overridePlaceholderKey: 'editPopover.placeholder.addLabel',
    model: 'fast',               // Use fast model for quick config edits
    systemPromptPreset: 'mini',   // Use focused mini prompt
    inlineExecution: true,        // Execute inline in popover
  }),

  // Views configuration context
  'edit-views': (location) => ({
    context: {
      label: 'Views Configuration',
      filePath: `${location}/views.json`,
      context:
        'The user wants to edit views (dynamic, expression-based filters). ' +
        'Views are stored in views.json at the workspace root under a "views" array. ' +
        'Each view has: id (unique slug), name (display text), description (optional), color (optional EntityColor), expression (Filtrex string). ' +
        'Expressions are evaluated against session context fields: name, preview, sessionStatus (also available as deprecated alias todoState), permissionMode, model, lastMessageRole, ' +
        'lastUsedAt, createdAt, messageCount, labelCount, isFlagged, hasUnread, isProcessing, hasPendingPlan, tokenUsage.*, labels. ' +
        'Available functions: daysSince(timestamp), contains(array, value). ' +
        'Colors use EntityColor format: string shorthand (e.g. "orange") or { light, dark } object. ' +
        'Confirm clearly when done.',
    },
    example: 'Add a "Stale" view for sessions inactive > 7 days',
    displayLabelKey: 'editPopover.label.viewsConfiguration',
    exampleKey: 'editPopover.example.editViews',
    model: 'fast',               // Use fast model for quick config edits
    systemPromptPreset: 'mini',   // Use focused mini prompt
    inlineExecution: true,        // Execute inline in popover
  }),

  // Tool icons configuration context
  'edit-tool-icons': (location) => ({
    context: {
      label: 'Tool Icons',
      filePath: location, // location is the full path to tool-icons.json
      context:
        'The user wants to edit CLI tool icon mappings. ' +
        'The file is tool-icons.json in ~/.craft-agent/tool-icons/. Icon image files live in the same directory. ' +
        'Schema: { version: 1, tools: [{ id, displayName, icon, commands }] }. ' +
        'Each tool has: id (unique slug), displayName (shown in UI), icon (filename like "git.ico"), commands (array of CLI command names). ' +
        'Supported icon formats: .png, .ico, .svg, .jpg. Icons display at 20x20px. ' +
        'Read ~/.craft-agent/docs/tool-icons.md for full format reference. ' +
        'After editing, call config_validate with target "tool-icons" to verify the changes are valid. ' +
        'Confirm clearly when done.',
    },
    example: 'Add an icon for my custom CLI tool "deploy"',
    displayLabelKey: 'editPopover.label.toolIcons',
    exampleKey: 'editPopover.example.editToolIcons',
    model: 'fast',               // Use fast model for quick config edits
    systemPromptPreset: 'mini',   // Use focused mini prompt
    inlineExecution: true,        // Execute inline in popover
  }),

  'automation-config': (location) => ({
    context: {
      label: 'Automation Configuration',
      filePath: `${location}/automations.json`,
      context:
        'The user is editing automations.json which configures automations. ' +
        'Structure: { version: 2, automations: { EventName: [{ name?, matcher?, cron?, timezone?, permissionMode?, labels?, actions: [...] }] } }. ' +
        'Each event maps to an array of matcher entries. Each matcher has an actions array ({ type: "prompt", prompt }). ' +
        'Read ~/.craft-agent/docs/automations.md for full format reference. ' +
        'After editing, confirm clearly what changed.',
    },
    example: 'Change the cron schedule to every 30 minutes',
    displayLabelKey: 'editPopover.label.automationConfiguration',
    exampleKey: 'editPopover.example.automationConfig',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),
}

/**
 * Get full edit config by key. Returns both context (for agent) and example (for UI).
 *
 * @param key - The edit context key
 * @param location - Base path (e.g., workspace root path)
 *
 * @example
 * const { context, example } = getEditConfig('workspace-permissions', workspace.rootPath)
 */
export function getEditConfig(key: EditContextKey, location: string): EditConfig {
  const factory = EDIT_CONFIGS[key]
  if (!factory) {
    throw new Error(`Unknown edit context key: ${key}. Add it to EDIT_CONFIGS in EditPopover.tsx`)
  }
  const config = factory(location)

  // Resolve i18n keys to translated strings for UI display
  // context.label remains in English for agent prompts; displayLabel is used in UI
  return {
    ...config,
    displayLabel: config.displayLabelKey ? i18n.t(config.displayLabelKey) : config.context.label,
    example: config.exampleKey ? i18n.t(config.exampleKey) : config.example,
    overridePlaceholder: config.overridePlaceholderKey ? i18n.t(config.overridePlaceholderKey) : config.overridePlaceholder,
  }
}

/**
 * Optional secondary action button displayed on the left side of the popover footer.
 * Styled as plain text with underline on hover - typically used for "Edit File" actions.
 */
export interface SecondaryAction {
  /** Button label (e.g., "Edit File") */
  label: string
  /** File path to open directly in the system editor (bypasses link interceptor) */
  filePath: string
}

export interface EditPopoverProps {
  /** Trigger element that opens the popover */
  trigger: React.ReactNode
  /** Example text shown in placeholder (e.g., "Allow 'make build' command") */
  example?: string
  /** Context passed to the new chat session */
  context: EditContext
  /** Permission mode for the new session (default: 'allow-all' / canonical: execute for fast execution) */
  permissionMode?: CreateSessionOptions['permissionMode']
  /**
   * Working directory for the new session:
   * - 'none' (default): No working directory (session folder only) - best for config edits
   * - 'user_default': Use workspace's configured default
   * - Absolute path string: Use this specific path
   */
  workingDirectory?: string | 'user_default' | 'none'
  /** Model tier hint: 'fast' uses the connection's mini model, 'default' uses the primary model */
  model?: 'fast' | 'default'
  /** System prompt preset for mini agent (e.g., 'mini' for focused edits) */
  systemPromptPreset?: 'default' | 'mini'
  /** Width of the popover (default: 320) */
  width?: number
  /** Additional className for the trigger */
  triggerClassName?: string
  /** Side of the popover relative to trigger */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** Alignment of the popover */
  align?: 'start' | 'center' | 'end'
  /** Optional secondary action button on the left (e.g., "Edit File") */
  secondaryAction?: SecondaryAction
  /** Optional custom placeholder - overrides the default "Describe what you'd like to change" */
  overridePlaceholder?: string
  /** Translated display label for badges and empty state (falls back to context.label) */
  displayLabel?: string
  /**
   * Controlled open state - when provided, the popover becomes controlled.
   * Use this when opening the popover programmatically (e.g., from context menus).
   */
  open?: boolean
  /** Callback when open state changes (for controlled mode) */
  onOpenChange?: (open: boolean) => void
  /**
   * When true, prevents the popover from closing when clicking outside.
   * Useful for context menu triggered popovers where focus management is tricky.
   */
  modal?: boolean
  /**
   * Default value to pre-fill the input with.
   * Useful when the user types something (e.g., "#Test") and clicks "Add new label" -
   * the input can be pre-filled with "Add new label Test".
   */
  defaultValue?: string
  /**
   * When true, executes the mini agent inline within the popover instead of
   * opening a new window. Best for quick config edits with mini agents.
   */
  inlineExecution?: boolean
}

/**
 * Result from buildEditPrompt containing both the full prompt and badge metadata
 * for hiding the XML context in the UI while keeping it in the actual message.
 */
interface EditPromptResult {
  /** Full prompt including XML metadata and user instructions */
  prompt: string
  /** Badge marking the hidden metadata section */
  badges: ContentBadge[]
}

/**
 * Build the prompt that will be sent to the agent.
 * Uses XML-like tags for clear structure.
 *
 * Returns both the prompt and a context badge that marks the metadata section
 * so it can be hidden in the UI while still being sent to the agent.
 *
 * @param context - The edit context with label, filePath, and optional context
 * @param userInstructions - User's instructions (can be empty string for pre-filled context only)
 *
 * @example
 * // With user instructions (for EditPopover submit)
 * const { prompt, badges } = buildEditPrompt(context, "Add a Blocked status")
 *
 * // Without user instructions (for context menu - opens window with context pre-filled)
 * const { prompt, badges } = buildEditPrompt(context, "")
 */
export function buildEditPrompt(context: EditContext, userInstructions: string, displayLabel?: string): EditPromptResult {
  // Build the metadata section (will be hidden by badge)
  // Simple structure: label (for display/context), file (where to edit), optional context
  // context.label stays in English for the agent; displayLabel is translated for UI
  const metadataSection = `<edit_request>
<label>${context.label}</label>
<file>${context.filePath}</file>
${context.context ? `<context>${context.context}</context>\n` : ''}</edit_request>

`

  // Badge display: use translated displayLabel if available, else English label
  const collapsedLabel = displayLabel || context.label

  // Full prompt = metadata + user instructions
  const prompt = metadataSection + userInstructions

  // Create badge marking the metadata section (start=0, end=metadata length)
  const badge: ContentBadge = {
    type: 'context',
    label: collapsedLabel,
    rawText: metadataSection,
    start: 0,
    end: metadataSection.length,
    collapsedLabel,
  }

  return { prompt, badges: [badge] }
}

export function EditPopover({
  trigger,
  example,
  context,
  permissionMode = 'allow-all',
  workingDirectory = 'none', // Default to session folder for config edits
  model,
  systemPromptPreset,
  width = 400, // Default 400px for compact chat embedding
  triggerClassName,
  side = 'bottom',
  align = 'end',
  secondaryAction: _secondaryAction,
  overridePlaceholder,
  displayLabel,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  modal = false,
  defaultValue: _defaultValue = '',
  inlineExecution = false,
}: EditPopoverProps) {
  const { t } = useTranslation()
  const { onOpenFile, onOpenUrl } = usePlatform()
  const workspace = useActiveWorkspace()

  // Build placeholder: for inline execution use rotating array, otherwise build descriptive string
  // overridePlaceholder allows contexts like add-source/add-skill to say "add" instead of "change"
  const placeholder = useMemo(() => {
    if (inlineExecution) {
      return COMPACT_PLACEHOLDER_KEYS.map(key => t(key))
    }

    const basePlaceholder = overridePlaceholder ?? t("editPopover.describePlaceholder")
    return example
      ? `${basePlaceholder.replace(/\.{3}$/, '')}, e.g., "${example}"`
      : basePlaceholder
  }, [inlineExecution, overridePlaceholder, example, t])

  // Support both controlled and uncontrolled modes:
  // - Uncontrolled (default): internal state manages open/close
  // - Controlled: parent manages state via open/onOpenChange props
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = useCallback((value: boolean) => {
    if (isControlled) {
      controlledOnOpenChange?.(value)
    } else {
      setInternalOpen(value)
    }
  }, [isControlled, controlledOnOpenChange])

  // Use App context for session management (same code path as main chat)
  const { onCreateSession, onSendMessage, onRespondToPermission, onRespondToCredential } = useAppShellContext()

  // Session ID for inline execution (created on first message)
  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null)

  // Get session data from Jotai atom (same as main chat - includes optimistic updates)
  // Pass empty string when no session yet - atom returns null for unknown IDs
  const inlineSession = useSession(inlineSessionId || '')

  // Pending permission/credential requests for inline session (same flow as main chat)
  const pendingPermission = usePendingPermission(inlineSessionId || '')
  const pendingCredential = usePendingCredential(inlineSessionId || '')

  // Model state for ChatDisplay (starts with prop value, can be changed by user)
  const [currentModel, setCurrentModel] = useState(model || 'haiku')

  // Create a stub session for ChatDisplay when no real session exists yet
  // This allows showing the input before the first message is sent
  const stubSession = useMemo((): Session => ({
    id: 'pending',
    workspaceId: workspace?.id || '',
    workspaceName: workspace?.name || '',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }), [workspace?.id, workspace?.name])

  // Use real session if available, otherwise stub
  const displaySession = inlineSession || stubSession

  // Track processing state for close prevention and backdrop
  const isProcessing = displaySession.isProcessing

  // Use existing escape interrupt context for double-ESC flow
  // This shows the "Press Esc again to interrupt" overlay in the input field
  const { handleEscapePress } = useEscapeInterrupt()

  // Reset inline session when popover closes
  const resetInlineSession = useCallback(() => {
    setInlineSessionId(null)
  }, [])

  // Stop/cancel generation for the inline session
  const handleStopGeneration = useCallback(() => {
    if (inlineSessionId && isProcessing) {
      window.electronAPI.cancelProcessing(inlineSessionId, false)
    }
  }, [inlineSessionId, isProcessing])

  // Handle ESC key during generation:
  // Uses EscapeInterruptContext for double-ESC flow (shows overlay, then interrupts)
  const handleEscapeKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isProcessing) {
      // Not processing - allow normal close behavior
      return
    }

    // Prevent default close behavior during processing
    e.preventDefault()

    // Use context's double-ESC handler
    // Returns true if this is the second press (should interrupt)
    const shouldInterrupt = handleEscapePress()
    if (shouldInterrupt) {
      handleStopGeneration()
    }
  }, [isProcessing, handleEscapePress, handleStopGeneration])

  // Handle click outside during generation:
  // Show the ESC overlay via context, prevent closing
  const handleInteractOutside = useCallback((e: Event) => {
    if (isProcessing) {
      // Prevent close during processing
      e.preventDefault()
      // Show the ESC overlay so user knows how to cancel
      handleEscapePress()
    }
  }, [isProcessing, handleEscapePress])

  // Drag state for movable popover
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 })
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const popoverRef = useRef<HTMLDivElement>(null)

  // Resize state for dynamic sizing
  const [containerSize, setContainerSize] = useState({ width: width || 400, height: 480 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // Reset drag position and size when popover opens
  useEffect(() => {
    if (open) {
      dragOffsetRef.current = { x: 0, y: 0 }
      setDragOffset({ x: 0, y: 0 })
      setContainerSize({ width: width || 400, height: 480 })
    }
  }, [open, width])

  // Handle drag events
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      offsetX: dragOffset.x,
      offsetY: dragOffset.y,
    }
  }, [dragOffset])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const rect = popoverRef.current?.getBoundingClientRect()
      if (!rect) return

      const MARGIN = 20
      const MARGIN_TOP = 50 // Keep below header (chevrons, menu button)
      const curr = dragOffsetRef.current
      const baseX = rect.left - curr.x
      const baseY = rect.top - curr.y

      const newX = dragStartRef.current.offsetX + e.clientX - dragStartRef.current.x
      const newY = dragStartRef.current.offsetY + e.clientY - dragStartRef.current.y

      const clampedX = Math.max(MARGIN - baseX, Math.min(window.innerWidth - MARGIN - rect.width - baseX, newX))
      const clampedY = Math.max(MARGIN_TOP - baseY, Math.min(window.innerHeight - MARGIN - rect.height - baseY, newY))

      dragOffsetRef.current = { x: clampedX, y: clampedY }
      setDragOffset({ x: clampedX, y: clampedY })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: containerSize.width,
      height: containerSize.height,
    }
  }, [containerSize])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartRef.current.x
      const deltaY = e.clientY - resizeStartRef.current.y
      setContainerSize({
        width: Math.max(300, resizeStartRef.current.width + deltaX),
        height: Math.max(250, resizeStartRef.current.height + deltaY),
      })
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // Reset state when popover opens
  useEffect(() => {
    if (open) {
      setCurrentModel(model || 'haiku')
      resetInlineSession()
    }
  }, [open, model, resetInlineSession])

  // Handle sending message from ChatDisplay (inline mode)
  // Creates hidden session on first message, then uses App context for sending
  const handleInlineSendMessage = useCallback(async (message: string) => {
    const { prompt, badges } = buildEditPrompt(context, message, displayLabel)

    // Create session on first message
    let sessionId = inlineSessionId
    if (!sessionId && workspace?.id) {
      const createOptions: CreateSessionOptions = {
        model: model || 'fast',
        systemPromptPreset: systemPromptPreset || 'mini',
        permissionMode,
        workingDirectory,
        hidden: true, // Hidden sessions use same App code path but don't appear in list
      }
      const newSession = await onCreateSession(workspace.id, createOptions)
      sessionId = newSession.id
      setInlineSessionId(sessionId)
    }

    // Send message via App context (includes optimistic user message update)
    // Pass badges to hide the <edit_request> XML metadata in the user message bubble
    if (sessionId) {
      onSendMessage(sessionId, prompt, undefined, undefined, badges)
    }
  }, [context, displayLabel, inlineSessionId, workspace?.id, model, systemPromptPreset, permissionMode, workingDirectory, onCreateSession, onSendMessage])

  // Legacy mode: navigates to chat in the same window
  const handleLegacySendMessage = useCallback((message: string) => {
    const { prompt, badges } = buildEditPrompt(context, message, displayLabel)
    const encodedInput = encodeURIComponent(prompt)
    const encodedBadges = encodeURIComponent(JSON.stringify(badges))

    const workdirParam = workingDirectory ? `&workdir=${encodeURIComponent(workingDirectory)}` : ''
    const modelParam = model ? `&model=${encodeURIComponent(model)}` : ''
    const systemPromptParam = systemPromptPreset ? `&systemPrompt=${encodeURIComponent(systemPromptPreset)}` : ''
    // Navigate in same window by omitting window=focused parameter
    const url = `craftagents://action/new-session?input=${encodedInput}&send=true&mode=${permissionMode}&badges=${encodedBadges}${workdirParam}${modelParam}${systemPromptParam}`

    window.electronAPI.openUrl(url)
    setOpen(false)
  }, [context, displayLabel, workingDirectory, model, systemPromptPreset, permissionMode, setOpen])

  return (
    <>
      {/* Full-screen backdrop - rendered BEHIND the popover during processing */}
      <AnimatePresence>
        {open && isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="fixed inset-0 bg-black/5 z-40"
          />
        )}
      </AnimatePresence>

      <Popover open={open} onOpenChange={setOpen} modal={modal}>
        <PopoverTrigger asChild className={triggerClassName}>
          {trigger}
        </PopoverTrigger>
        <PopoverContent
            side={side}
            align={align}
            sticky="always"
            className="p-0"
            style={{
              width: containerSize.width,
              height: containerSize.height,
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
            }}
            onInteractOutside={handleInteractOutside}
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            {/* Container */}
            <div
              ref={popoverRef}
              className="relative bg-foreground-2 overflow-hidden w-full h-full shadow-modal-small"
              style={{
                transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
                borderRadius: 16,
              }}
            >
              {/* Drag handle - floating overlay */}
              <div
                onMouseDown={handleDragStart}
                className={cn(
                  "absolute top-0 left-1/2 -translate-x-1/2 z-50 px-4 py-2 cursor-grab rounded pointer-events-auto titlebar-no-drag",
                  isDragging && "cursor-grabbing"
                )}
              >
                <GripHorizontal className="w-4 h-4 text-muted-foreground/30" />
              </div>

              {/* Content area - always uses compact ChatDisplay */}
              <div className="flex-1 flex flex-col bg-foreground-2" style={{ height: '100%' }}>
                <ChatDisplay
                  session={displaySession}
                  onSendMessage={inlineExecution ? handleInlineSendMessage : handleLegacySendMessage}
                  onOpenFile={onOpenFile || (() => {})}
                  onOpenUrl={onOpenUrl || (() => {})}
                  currentModel={currentModel}
                  onModelChange={setCurrentModel}
                  pendingPermission={pendingPermission}
                  onRespondToPermission={onRespondToPermission}
                  pendingCredential={pendingCredential}
                  onRespondToCredential={onRespondToCredential}
                  compactMode={true}
                  placeholder={placeholder}
                  emptyStateLabel={displayLabel || context.label}
                />
              </div>
            </div>

            {/* Bottom-right resize handle - outside overflow-hidden container */}
            <div
              onMouseDown={handleResizeStart}
              className="absolute -bottom-2 -right-2 w-6 h-6 cursor-nwse-resize pointer-events-auto z-50"
              style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
            />
          </PopoverContent>
      </Popover>
    </>
  )
}

/**
 * Standard Edit button styled for use with EditPopover.
 * Use this as the trigger prop for consistent styling across the app.
 *
 * Uses forwardRef to properly work with Radix's asChild pattern,
 * which requires the child to accept ref and spread props.
 *
 * @example
 * <EditPopover
 *   trigger={<EditButton />}
 *   context={getEditContext('workspace-permissions', { workspacePath })}
 * />
 */
export const EditButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof Button>
>(({ className, ...props }, ref) => {
  const { t } = useTranslation()
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      // Merge our base styles with any className from asChild props
      className={cn("h-8 px-3 rounded-[6px] bg-background shadow-minimal text-foreground/70 hover:text-foreground", className)}
      {...props}
    >
      {t("common.edit")}
    </Button>
  )
})

EditButton.displayName = 'EditButton'
