/**
 * Automations Playground Registry
 *
 * Registry entries for all automation UI components with comprehensive mock data
 * and playground variants for testing every visual state.
 */

import { useState, type ReactNode } from 'react'
import type { ComponentEntry } from './types'
import { AutomationsListPanel } from '@/components/automations/AutomationsListPanel'
import { AutomationInfoPage } from '@/components/automations/AutomationInfoPage'
import { AutomationCard } from '@/components/automations/AutomationCard'
import { AutomationAvatar } from '@/components/automations/AutomationAvatar'
import { CronBuilder } from '@/components/automations/CronBuilder'
import { AutomationTestPanel } from '@/components/automations/AutomationTestPanel'
import { AutomationEventTimeline } from '@/components/automations/AutomationEventTimeline'
import { getEventDisplayName, type AutomationListItem, type ExecutionEntry, type TestResult, type AutomationTrigger } from '@/components/automations/types'

// ============================================================================
// Wrappers
// ============================================================================

function PaddedWrapper({ children }: { children: ReactNode }) {
  return <div className="p-6">{children}</div>
}

/** Stateful wrapper for AutomationsListPanel */
function AutomationsListPanelPlayground({
  automations,
  selectedAutomationId: initialSelectedId,
}: {
  automations: AutomationListItem[]
  selectedAutomationId?: string | null
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const [automationList, setAutomationList] = useState(automations)

  return (
    <AutomationsListPanel
      automations={automationList}
      selectedAutomationId={selectedId}
      onAutomationClick={(id) => setSelectedId(id)}
      onDeleteAutomation={(id) => {
        setAutomationList(prev => prev.filter(h => h.id !== id))
        if (selectedId === id) setSelectedId(null)
      }}
      onToggleAutomation={(id) => {
        setAutomationList(prev => prev.map(h =>
          h.id === id ? { ...h, enabled: !h.enabled } : h
        ))
      }}
      onTestAutomation={(id) => console.log('[Playground] Test automation:', id)}
      onDuplicateAutomation={(id) => console.log('[Playground] Duplicate automation:', id)}
    />
  )
}

/** Stateful wrapper for AutomationInfoPage with test simulation */
function AutomationInfoPagePlayground({
  automation,
  executions,
}: {
  automation: AutomationListItem
  executions?: ExecutionEntry[]
}) {
  const [currentAutomation, setCurrentAutomation] = useState(automation)
  const [testResult, setTestResult] = useState<TestResult>({ state: 'idle' })

  const handleTest = () => {
    setTestResult({ state: 'running' })
    setTimeout(() => {
      setTestResult({
        state: 'success',
        duration: 42,
      })
    }, 1500)
  }

  return (
    <AutomationInfoPage
      automation={currentAutomation}
      executions={executions}
      testResult={testResult}
      onToggleEnabled={() => setCurrentAutomation(prev => ({ ...prev, enabled: !prev.enabled }))}
      onTest={handleTest}
      onDuplicate={() => console.log('[Playground] Duplicate')}
      onDelete={() => console.log('[Playground] Delete')}
    />
  )
}

/** Stateful wrapper for CronBuilder */
function CronBuilderPlayground({
  initialValue,
  timezone,
}: {
  initialValue?: string
  timezone?: string
}) {
  const [value, setValue] = useState(initialValue ?? '0 9 * * 1-5')

  return (
    <CronBuilder
      value={value}
      onChange={setValue}
      timezone={timezone}
    />
  )
}

/** Wrapper showing all AutomationAvatar variants in a grid */
function AutomationAvatarGallery() {
  const events: AutomationTrigger[] = [
    'SchedulerTick', 'LabelAdd', 'LabelRemove', 'LabelConfigChange',
    'PermissionModeChange', 'FlagChange', 'TodoStateChange',
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd',
    'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact',
    'PermissionRequest', 'Setup',
  ]

  return (
    <div className="space-y-6">
      {/* Size variants */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Sizes</h4>
        <div className="flex items-end gap-4">
          {(['xs', 'sm', 'md', 'lg'] as const).map(size => (
            <div key={size} className="flex flex-col items-center gap-1">
              <AutomationAvatar event="SchedulerTick" size={size} />
              <span className="text-[10px] text-muted-foreground">{size}</span>
            </div>
          ))}
        </div>
      </div>

      {/* All event types */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">All Events</h4>
        <div className="grid grid-cols-4 gap-3">
          {events.map(event => (
            <div key={event} className="flex items-center gap-2">
              <AutomationAvatar event={event} size="md" />
              <span className="text-xs text-foreground/70 truncate">{getEventDisplayName(event)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Stateful wrapper for AutomationCard */
function AutomationCardPlayground({
  automation,
  defaultExpanded,
}: {
  automation: AutomationListItem
  defaultExpanded?: boolean
}) {
  const [currentAutomation, setCurrentAutomation] = useState(automation)

  return (
    <AutomationCard
      automation={currentAutomation}
      defaultExpanded={defaultExpanded}
      onToggleEnabled={(enabled) => setCurrentAutomation(prev => ({ ...prev, enabled }))}
      onTest={() => console.log('[Playground] Test automation:', currentAutomation.id)}
    />
  )
}

// ============================================================================
// Mock Data
// ============================================================================

const now = Date.now()

const mockAutomations: AutomationListItem[] = [
  {
    id: 'automation-1',
    event: 'SchedulerTick',
    matcherIndex: 0,
    name: 'Daily Weather Report',
    summary: 'Weekdays at 9:00 AM',
    enabled: true,
    cron: '0 9 * * 1-5',
    timezone: 'Europe/Budapest',
    actions: [{ type: 'prompt', prompt: 'Run the @weather skill and give me today\'s forecast for Budapest' }],
    labels: ['Scheduled', 'weather'],
    permissionMode: 'safe',
    lastExecutedAt: now - 120_000, // 2 minutes ago
  },
  {
    id: 'automation-2',
    event: 'LabelAdd',
    matcherIndex: 0,
    name: 'Urgent Label Notification',
    summary: 'When "urgent" label is added',
    enabled: true,
    matcher: '^urgent$',
    actions: [{ type: 'prompt', prompt: 'Send a macOS notification: "Urgent task flagged!"' }],
    permissionMode: 'allow-all',
    lastExecutedAt: now - 300_000, // 5 minutes ago
  },
  {
    id: 'automation-3',
    event: 'PreToolUse',
    matcherIndex: 0,
    name: 'Git Pre-commit Check',
    summary: 'Before any Bash tool use',
    enabled: false,
    matcher: 'Bash',
    actions: [{ type: 'prompt', prompt: 'Run git diff --cached --check and report any issues' }],
    permissionMode: 'safe',
  },
  {
    id: 'automation-4',
    event: 'LabelAdd',
    matcherIndex: 1,
    name: 'Label Change Logger',
    summary: 'Logs all label additions',
    enabled: true,
    actions: [{ type: 'prompt', prompt: 'Log the label change: "$CRAFT_LABEL was added" to ~/label-log.txt' }],
    permissionMode: 'allow-all',
    lastExecutedAt: now - 3600_000, // 1 hour ago
  },
  {
    id: 'automation-5',
    event: 'SchedulerTick',
    matcherIndex: 1,
    name: 'Hourly Health Check',
    summary: 'Every hour',
    enabled: true,
    cron: '0 * * * *',
    actions: [
      { type: 'prompt', prompt: 'Check the health of https://api.example.com/health and report status' },
      { type: 'prompt', prompt: 'Analyze the health check result and alert if there are issues' },
    ],
    labels: ['Monitoring'],
    lastExecutedAt: now - 900_000, // 15 minutes ago
  },
  {
    id: 'automation-6',
    event: 'PostToolUse',
    matcherIndex: 0,
    name: 'Build Artifact Logger',
    summary: 'After Bash tool completes',
    enabled: true,
    matcher: 'Bash',
    actions: [{ type: 'prompt', prompt: 'Log that tool $TOOL_NAME completed to ~/build-log.txt' }],
    lastExecutedAt: now - 172800_000, // 2 days ago
  },
  {
    id: 'automation-7',
    event: 'SessionStart',
    matcherIndex: 0,
    name: 'Welcome Prompt',
    summary: 'Greet on new session',
    enabled: true,
    actions: [{ type: 'prompt', prompt: 'Welcome! Check if there are any pending @linear issues assigned to me.' }],
    labels: ['Onboarding'],
    lastExecutedAt: now - 7200_000, // 2 hours ago
  },
  {
    id: 'automation-8',
    event: 'PostToolUseFailure',
    matcherIndex: 0,
    name: 'Error Alert',
    summary: 'Notify on tool failures',
    enabled: true,
    actions: [{ type: 'prompt', prompt: 'Send an error notification: tool $TOOL_NAME failed' }],
    permissionMode: 'allow-all',
    lastExecutedAt: now - 86400_000, // 1 day ago
  },
  {
    id: 'automation-9',
    event: 'SessionStatusChange',
    matcherIndex: 0,
    name: 'Done after 9 AM (priority)',
    summary: 'When status → done, if after 9 AM and has priority label',
    enabled: true,
    matcher: '^done$',
    conditions: [
      { condition: 'time', after: '09:00', timezone: 'Europe/Budapest' },
      {
        condition: 'or',
        conditions: [
          { condition: 'state', field: 'labels', contains: 'priority' },
          { condition: 'state', field: 'labels', contains: 'invoices' },
        ],
      },
    ],
    actions: [{ type: 'prompt', prompt: 'Session $CRAFT_SESSION_NAME was marked as done. Summarise what was accomplished.' }],
    lastExecutedAt: now - 600_000,
  },
  {
    id: 'automation-10',
    event: 'SchedulerTick',
    matcherIndex: 2,
    name: 'Morning AI News (Weekdays)',
    summary: 'Daily at 9:00 AM, weekdays only',
    enabled: true,
    cron: '0 9 * * *',
    timezone: 'Europe/Budapest',
    conditions: [
      { condition: 'time', weekday: ['mon', 'tue', 'wed', 'thu', 'fri'], timezone: 'Europe/Budapest' },
    ],
    labels: ['Scheduled', 'ai-news'],
    actions: [{ type: 'prompt', prompt: 'Run the @ai-news skill and summarize today\'s AI developments' }],
    lastExecutedAt: now - 86400_000,
  },
]

const mockExecutions: ExecutionEntry[] = [
  { id: 'ex-1', automationId: 'automation-1', event: 'SchedulerTick', status: 'success', duration: 42, timestamp: now - 120_000, actionSummary: 'prompt → @weather forecast' },
  { id: 'ex-2', automationId: 'automation-4', event: 'LabelAdd', status: 'success', duration: 8, timestamp: now - 300_000, actionSummary: 'echo "[...] Added: urgent"' },
  { id: 'ex-3', automationId: 'automation-5', event: 'SchedulerTick', status: 'error', duration: 1200, timestamp: now - 900_000, error: 'Connection refused' },
  { id: 'ex-4', automationId: 'automation-3', event: 'PreToolUse', status: 'blocked', duration: 0, timestamp: now - 3600_000, actionSummary: 'git diff --cached --check' },
  { id: 'ex-5', automationId: 'automation-1', event: 'SchedulerTick', status: 'success', duration: 38, timestamp: now - 86400_000, actionSummary: 'prompt → @weather forecast' },
  { id: 'ex-6', automationId: 'automation-6', event: 'PostToolUse', status: 'success', duration: 5, timestamp: now - 172800_000, actionSummary: 'echo "[...] Tool completed: Bash"' },
  // Webhook entries with expandable details
  {
    id: 'ex-7', automationId: 'automation-1', event: 'SessionStatusChange', status: 'success', duration: 45, timestamp: now - 60_000,
    actionSummary: 'Webhook POST http://localhost:8888/status-change',
    webhookDetails: { method: 'POST', url: 'http://localhost:8888/status-change', statusCode: 200, durationMs: 45, responseBody: '{"ok":true,"received":"status-change"}' },
  },
  {
    id: 'ex-8', automationId: 'automation-1', event: 'SessionStatusChange', status: 'error', duration: 3200, timestamp: now - 600_000,
    actionSummary: 'Webhook POST https://api.example.com/notify (2 attempts)',
    webhookDetails: { method: 'POST', url: 'https://api.example.com/notify', statusCode: 502, durationMs: 3200, attempts: 2, error: 'Bad Gateway' },
  },
  {
    id: 'ex-9', automationId: 'automation-1', event: 'LabelAdd', status: 'success', duration: 120, timestamp: now - 1800_000,
    actionSummary: 'Webhook PUT https://hooks.slack.com/services/T.../B.../xxx',
    webhookDetails: { method: 'PUT', url: 'https://hooks.slack.com/services/T.../B.../xxx', statusCode: 200, durationMs: 120, responseBody: 'ok' },
  },
]

const mockWebhookExecutions: ExecutionEntry[] = mockExecutions.filter(e => !!e.webhookDetails)

const testResultSuccess: TestResult = {
  state: 'success',
  duration: 42,
}

const testResultError: TestResult = {
  state: 'error',
  stderr: 'Failed to create session: Connection refused',
  duration: 1200,
}

const testResultRunning: TestResult = {
  state: 'running',
}

// ============================================================================
// Registry Entries
// ============================================================================

export const automationComponents: ComponentEntry[] = [
  // ==========================================================================
  // AutomationsListPanel
  // ==========================================================================
  {
    id: 'automations-list-panel',
    name: 'AutomationsListPanel',
    category: 'Automations',
    description: 'Navigator panel with automation list, filters, and contextual actions',
    component: AutomationsListPanelPlayground,
    layout: 'full',
    props: [
      {
        name: 'selectedAutomationId',
        description: 'Currently selected automation ID',
        control: { type: 'string', placeholder: 'e.g., automation-1' },
        defaultValue: null,
      },
    ],
    variants: [
      {
        name: 'Default (All)',
        description: '8 automations with mixed states',
        props: { automations: mockAutomations, selectedAutomationId: 'automation-1' },
      },
      {
        name: 'Empty State',
        description: 'No automations configured',
        props: { automations: [], selectedAutomationId: null },
      },
      {
        name: 'Few Items (3)',
        description: 'Small list without scrolling',
        props: { automations: mockAutomations.slice(0, 3), selectedAutomationId: null },
      },
      {
        name: 'With Selection',
        description: 'Second automation selected',
        props: { automations: mockAutomations, selectedAutomationId: 'automation-2' },
      },
      {
        name: 'Mixed Enabled/Disabled',
        description: 'Shows disabled automations dimmed',
        props: {
          automations: mockAutomations.map((h, i) => ({ ...h, enabled: i % 2 === 0 })),
          selectedAutomationId: null,
        },
      },
    ],
    mockData: () => ({
      automations: mockAutomations,
    }),
  },

  // ==========================================================================
  // AutomationInfoPage
  // ==========================================================================
  {
    id: 'automation-info-page',
    name: 'AutomationInfoPage',
    category: 'Automations',
    description: 'Detail view using Info_Page with When/Then/Settings sections',
    component: AutomationInfoPagePlayground,
    layout: 'full',
    props: [],
    variants: [
      {
        name: 'Scheduled',
        description: 'Recurring schedule with timezone and upcoming runs',
        props: { automation: mockAutomations[0], executions: mockExecutions.filter(e => e.automationId === 'automation-1') },
      },
      {
        name: 'Label Event',
        description: 'Triggered when a label is added, with filter and prompt',
        props: { automation: mockAutomations[1], executions: mockExecutions.filter(e => e.automationId === 'automation-2') },
      },
      {
        name: 'Before Tool Runs (Disabled)',
        description: 'Pre-tool automation with filter, showing disabled state warning',
        props: { automation: mockAutomations[2], executions: mockExecutions.filter(e => e.automationId === 'automation-3') },
      },
      {
        name: 'Multiple Prompts',
        description: 'Automation with multiple prompt actions',
        props: { automation: mockAutomations[4], executions: mockExecutions.filter(e => e.automationId === 'automation-5') },
      },
      {
        name: 'Session Start',
        description: 'Prompt automation with @mentions and labels',
        props: { automation: mockAutomations[6], executions: [] },
      },
      {
        name: 'Error Handler',
        description: 'Runs when a tool fails',
        props: { automation: mockAutomations[7], executions: [] },
      },
      {
        name: 'With Conditions (Status + State)',
        description: 'SessionStatusChange with time and state conditions (If section visible)',
        props: { automation: mockAutomations[8], executions: [] },
      },
      {
        name: 'With Conditions (Weekday)',
        description: 'SchedulerTick with weekday time condition (If section visible)',
        props: { automation: mockAutomations[9], executions: [] },
      },
      {
        name: 'With Full History',
        description: 'All 6 execution entries visible',
        props: { automation: mockAutomations[0], executions: mockExecutions },
      },
    ],
    mockData: () => ({
      automation: mockAutomations[0],
      executions: mockExecutions,
    }),
  },

  // ==========================================================================
  // AutomationCard
  // ==========================================================================
  {
    id: 'automation-card',
    name: 'AutomationCard',
    category: 'Automations',
    description: 'Expandable inline row with trigger/action preview',
    component: AutomationCardPlayground,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'defaultExpanded',
        description: 'Start expanded',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Collapsed',
        description: 'Default collapsed state',
        props: { automation: mockAutomations[0], defaultExpanded: false },
      },
      {
        name: 'Expanded',
        description: 'Expanded with trigger and action details',
        props: { automation: mockAutomations[0], defaultExpanded: true },
      },
      {
        name: 'Disabled',
        description: 'Disabled automation (dimmed)',
        props: { automation: mockAutomations[2], defaultExpanded: true },
      },
      {
        name: 'Event-triggered',
        description: 'Automation triggered by an event',
        props: { automation: mockAutomations[1], defaultExpanded: true },
      },
      {
        name: 'Multiple Prompts',
        description: 'Automation with multiple prompt actions',
        props: { automation: mockAutomations[4], defaultExpanded: true },
      },
    ],
    mockData: () => ({
      automation: mockAutomations[0],
    }),
  },

  // ==========================================================================
  // CronBuilder
  // ==========================================================================
  {
    id: 'cron-builder',
    name: 'CronBuilder',
    category: 'Automations',
    description: 'Visual schedule builder with common presets and custom timing',
    component: CronBuilderPlayground,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'timezone',
        description: 'IANA timezone',
        control: { type: 'string', placeholder: 'e.g., Europe/Budapest' },
        defaultValue: 'Europe/Budapest',
      },
    ],
    variants: [
      {
        name: 'Weekdays at 9am',
        description: 'Common work schedule',
        props: { initialValue: '0 9 * * 1-5', timezone: 'Europe/Budapest' },
      },
      {
        name: 'Every 15 Minutes',
        description: 'High-frequency schedule',
        props: { initialValue: '*/15 * * * *', timezone: 'UTC' },
      },
      {
        name: 'Daily at Midnight',
        description: 'Nightly batch job',
        props: { initialValue: '0 0 * * *', timezone: 'America/New_York' },
      },
      {
        name: 'Monthly on 1st',
        description: 'Monthly report schedule',
        props: { initialValue: '30 14 1 * *', timezone: 'Europe/London' },
      },
      {
        name: 'Every Minute',
        description: 'Maximum frequency',
        props: { initialValue: '* * * * *' },
      },
    ],
    mockData: () => ({
      initialValue: '0 9 * * 1-5',
      timezone: 'Europe/Budapest',
    }),
  },

  // ==========================================================================
  // AutomationAvatar Gallery
  // ==========================================================================
  {
    id: 'automation-avatar',
    name: 'AutomationAvatar',
    category: 'Automations',
    description: 'Event-categorized icons with size and color variants',
    component: AutomationAvatarGallery,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [],
    variants: [],
    mockData: () => ({}),
  },

  // ==========================================================================
  // AutomationTestPanel
  // ==========================================================================
  {
    id: 'automation-test-panel',
    name: 'AutomationTestPanel',
    category: 'Automations',
    description: 'Test execution result states (success, error, running)',
    component: AutomationTestPanel,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [],
    variants: [
      {
        name: 'Running',
        description: 'Test in progress with spinner',
        props: { result: testResultRunning },
      },
      {
        name: 'Success',
        description: 'Successful test with duration',
        props: { result: testResultSuccess },
      },
      {
        name: 'Error',
        description: 'Failed test with stderr',
        props: { result: testResultError },
      },
    ],
    mockData: () => ({
      result: testResultSuccess,
    }),
  },

  // ==========================================================================
  // AutomationEventTimeline
  // ==========================================================================
  {
    id: 'automation-event-timeline',
    name: 'AutomationEventTimeline',
    category: 'Automations',
    description: 'Execution history with status, time, event, and duration',
    component: AutomationEventTimeline,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [],
    variants: [
      {
        name: 'Mixed Results',
        description: 'Success, error, and blocked entries (prompt + webhook)',
        props: { entries: mockExecutions },
      },
      {
        name: 'Webhook Only',
        description: 'Webhook entries with expandable details (click to expand)',
        props: { entries: mockWebhookExecutions },
      },
      {
        name: 'Webhook Error with Retry',
        description: 'Failed webhook with retry button and expandable details',
        props: {
          entries: mockWebhookExecutions.filter(e => e.status === 'error'),
          onReplay: (automationId: string, event: string) => console.log('[Playground] Replay:', automationId, event),
        },
      },
      {
        name: 'All Success',
        description: 'All executions successful',
        props: {
          entries: mockExecutions
            .filter(e => e.status === 'success')
            .map((e, i) => ({ ...e, id: `success-${i}` })),
        },
      },
      {
        name: 'Empty',
        description: 'No executions yet',
        props: { entries: [] },
      },
    ],
    mockData: () => ({
      entries: mockExecutions,
    }),
  },
]
