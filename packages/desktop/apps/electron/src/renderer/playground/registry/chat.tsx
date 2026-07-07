import * as React from 'react'
import type { ComponentEntry } from './types'
import { AttachmentPreview } from '@/components/app-shell/AttachmentPreview'
import { SetupAuthBanner } from '@/components/app-shell/SetupAuthBanner'
import { TurnCard, type ActivityItem } from '@craft-agent/ui'
import type { BackgroundTask } from '@/components/app-shell/ActiveTasksBar'
import { ActiveOptionBadges } from '@/components/app-shell/ActiveOptionBadges'
import { ChatInputZone, InputContainer } from '@/components/app-shell/input'
import { setRecentWorkingDirs } from '@/components/app-shell/input/working-directory-history'
import type { StructuredResponse } from '@/components/app-shell/input/structured/types'
import { EmptyStateHint, getHintCount, getHintTemplate } from '@/components/chat/EmptyStateHint'
import { Button } from '@/components/ui/button'
import { motion } from 'motion/react'
import { ArrowUp, Paperclip, ChevronDown, Circle, Sparkles } from 'lucide-react'
import type { LabelConfig } from '@craft-agent/shared/labels'
import type { SessionStatus } from '@/config/session-status-config'
import type { FileAttachment, PermissionRequest, PermissionMode } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { AppShellProvider } from '@/context/AppShellContext'
import { ModalProvider } from '@/context/ModalContext'
import {
  ensureMockElectronAPI,
  mockInputCallbacks,
  mockAttachmentCallbacks,
  mockSources,
  sampleImageAttachment,
  samplePdfAttachment,
} from '../mock-utils'
import { mockAdminApprovalRequest } from '../adapters/input-adapters'
import { getRecentDirsForScenario, type RecentDirScenario } from '../recent-working-dirs'

const sampleCodeAttachment: FileAttachment = {
  type: 'text',
  path: '/Users/test/app.tsx',
  name: 'App.tsx',
  mimeType: 'text/typescript',
  size: 8500,
}

const samplePermissionRequest: PermissionRequest = {
  requestId: 'perm-1',
  sessionId: 'session-1',
  toolName: 'bash',
  description: 'Run shell command',
  command: 'npm install --save-dev typescript @types/react',
}

const longPermissionRequest: PermissionRequest = {
  requestId: 'perm-2',
  sessionId: 'session-1',
  toolName: 'bash',
  description: 'Run shell command',
  command: 'find /Users/test/project -type f -name "*.ts" | xargs grep -l "deprecated" | head -20',
}

const veryLongPermissionRequest: PermissionRequest = {
  requestId: 'perm-3',
  sessionId: 'session-1',
  toolName: 'bash',
  description: 'Run complex deployment script',
  command: `#!/bin/bash
set -e

echo "Starting deployment..."
cd /Users/project/app

# Build the application
npm run build
npm run test

# Docker operations
docker build -t myapp:latest .
docker tag myapp:latest registry.example.com/myapp:latest
docker push registry.example.com/myapp:latest

# Deploy to kubernetes
kubectl apply -f k8s/deployment.yaml
kubectl rollout status deployment/myapp`,
}

const askUserQuestionRequest: PermissionRequest = {
  requestId: 'ask-1',
  sessionId: 'session-1',
  toolName: 'ask_user_question',
  type: 'ask_user_question',
  description: 'Please answer the following question(s):',
  questions: [
    {
      header: 'Approach',
      question: 'Which UI treatment should the agent use for tool approvals?',
      options: [
        {
          label: 'Dedicated UI',
          description: 'Render this tool with a purpose-built control surface.',
        },
        {
          label: 'Generic Menu',
          description: 'Keep using the shared permission dropdown-style UI.',
        },
      ],
    },
    {
      header: 'Details',
      question: 'Which supporting details should be visible?',
      multiSelect: true,
      options: [
        {
          label: 'Descriptions',
          description: 'Show short helper copy under each choice.',
        },
        {
          label: 'Progress',
          description: 'Show which questions have already been answered.',
        },
        {
          label: 'Custom Text',
          description: 'Allow a typed answer alongside preset choices.',
        },
      ],
    },
  ],
}

// Sample background tasks
const sampleBackgroundTasks: BackgroundTask[] = [
  {
    id: 'task-abc123',
    type: 'agent',
    toolUseId: 'tool-1',
    startTime: Date.now() - 45000, // 45 seconds ago
    elapsedSeconds: 45,
    intent: 'Explore codebase structure',
  },
  {
    id: 'shell-xyz456',
    type: 'shell',
    toolUseId: 'tool-2',
    startTime: Date.now() - 154000, // 2m 34s ago
    elapsedSeconds: 154,
  },
]

const singleBackgroundTask: BackgroundTask[] = [
  {
    id: 'task-123456',
    type: 'agent',
    toolUseId: 'tool-single',
    startTime: Date.now() - 23000,
    elapsedSeconds: 23,
    intent: 'Search for TypeScript files',
  },
]

const longRunningTasks: BackgroundTask[] = [
  {
    id: 'task-long-1',
    type: 'agent',
    toolUseId: 'tool-long-1',
    startTime: Date.now() - 3723000, // 1h 2m 3s
    elapsedSeconds: 3723,
    intent: 'Refactor authentication system',
  },
  {
    id: 'shell-long-2',
    type: 'shell',
    toolUseId: 'tool-long-2',
    startTime: Date.now() - 245000, // 4m 5s
    elapsedSeconds: 245,
  },
  {
    id: 'task-long-3',
    type: 'agent',
    toolUseId: 'tool-long-3',
    startTime: Date.now() - 12000, // 12s
    elapsedSeconds: 12,
    intent: 'Run tests',
  },
]

const inputContainerSampleLabels: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } },
  { id: 'priority', name: 'Priority', color: { light: '#F59E0B', dark: '#FBBF24' }, valueType: 'number' },
  { id: 'due-date', name: 'Due Date', color: { light: '#3B82F6', dark: '#60A5FA' }, valueType: 'date' },
  { id: 'sprint', name: 'Sprint', color: { light: '#8B5CF6', dark: '#A78BFA' }, valueType: 'string' },
]

const inputContainerSampleStatuses: SessionStatus[] = [
  {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--muted-foreground)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'in-progress',
    label: 'In Progress',
    resolvedColor: 'var(--info)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'done',
    label: 'Done',
    resolvedColor: 'var(--success)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'closed',
  },
]

const playgroundAppShellContext = {
  workspaces: [{ id: 'playground-workspace', name: 'Playground', path: '/playground', rootPath: '/playground' }],
  activeWorkspaceId: 'playground-workspace',
  activeWorkspaceSlug: 'playground-workspace',
  llmConnections: [],
  workspaceDefaultLlmConnection: undefined,
  refreshLlmConnections: async () => {},
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  getDraft: () => '',
  globalPermissionMode: 'ask',
  sessionOptions: new Map(),
  onCreateSession: async () => ({
    id: 'playground-session',
    workspaceId: 'playground-workspace',
    workspaceName: 'Playground',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }),
  onSendMessage: () => {},
  onRenameSession: () => {},
  onFlagSession: () => {},
  onUnflagSession: () => {},
  onArchiveSession: () => {},
  onUnarchiveSession: () => {},
  onMarkSessionRead: () => {},
  onMarkSessionUnread: () => {},
  onSetActiveViewingSession: () => {},
  onSessionStatusChange: () => {},
  onDeleteSession: async () => true,
  onOpenFile: () => {},
  onOpenUrl: () => {},
  onSelectWorkspace: () => {},
  onRefreshWorkspaces: () => {},
  onOpenSettings: () => {},
  onOpenKeyboardShortcuts: () => {},
  onOpenStoredUserPreferences: () => {},
  onReset: () => {},
  onSessionOptionsChange: () => {},
  onInputChange: () => {},
}

// ============================================================================
// Sample Nested Tool Activities (Task subagent with child tools)
// ============================================================================

/** Flat list of tools (no nesting) */
const flatActivities: ActivityItem[] = [
  {
    id: 'tool-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-1',
    toolInput: { file_path: 'src/components/App.tsx' },
    content: 'File contents...',
    timestamp: Date.now() - 3000,
    depth: 0,
  },
  {
    id: 'tool-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolUseId: 'grep-1',
    toolInput: { pattern: 'useState', path: 'src/' },
    content: '15 matches found',
    timestamp: Date.now() - 2000,
    depth: 0,
  },
  {
    id: 'tool-3',
    type: 'tool',
    status: 'completed',
    toolName: 'Edit',
    toolUseId: 'edit-1',
    toolInput: { file_path: 'src/components/App.tsx' },
    content: 'File updated',
    timestamp: Date.now() - 1000,
    depth: 0,
  },
]

/** Task with nested child tools (completed) */
const nestedActivitiesCompleted: ActivityItem[] = [
  {
    id: 'task-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-parent-1',
    toolInput: { description: 'Explore codebase structure', subagent_type: 'Explore' },
    content: 'Exploration complete',
    timestamp: Date.now() - 5000,
    depth: 0,
  },
  {
    id: 'read-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-child-1',
    toolInput: { file_path: 'package.json' },
    content: '{ "name": "my-app", ... }',
    timestamp: Date.now() - 4500,
    parentId: 'task-parent-1',
    depth: 1,
  },
  {
    id: 'glob-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Glob',
    toolUseId: 'glob-child-1',
    toolInput: { pattern: 'src/**/*.tsx' },
    content: '24 files matched',
    timestamp: Date.now() - 4000,
    parentId: 'task-parent-1',
    depth: 1,
  },
  {
    id: 'grep-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolUseId: 'grep-child-1',
    toolInput: { pattern: 'export function' },
    content: '156 matches',
    timestamp: Date.now() - 3500,
    parentId: 'task-parent-1',
    depth: 1,
  },
  {
    id: 'read-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-child-2',
    toolInput: { file_path: 'src/index.tsx' },
    content: 'Entry point file...',
    timestamp: Date.now() - 3000,
    parentId: 'task-parent-1',
    depth: 1,
  },
]

/** Qwen CLI agent tool naming (lowercase agent) with nested child tools */
const qwenAgentActivities: ActivityItem[] = [
  {
    id: 'agent-1',
    type: 'tool',
    status: 'completed',
    toolName: 'agent',
    toolUseId: 'agent-parent-1',
    toolInput: {
      description: 'Investigate renderer behavior',
      prompt: 'Find why the custom tool UI is not shown in desktop.',
      subagent_type: 'explorer',
    },
    content: 'Investigation complete',
    timestamp: Date.now() - 5000,
    depth: 0,
  },
  {
    id: 'agent-grep-1',
    type: 'tool',
    status: 'completed',
    toolName: 'grep_search',
    toolUseId: 'agent-grep-child-1',
    toolInput: { pattern: 'isParentTaskTool', path: 'packages/desktop' },
    content: '7 matches found',
    timestamp: Date.now() - 4200,
    parentId: 'agent-parent-1',
    depth: 1,
  },
  {
    id: 'agent-read-1',
    type: 'tool',
    status: 'completed',
    toolName: 'read_file',
    toolUseId: 'agent-read-child-1',
    toolInput: { file_path: 'packages/desktop/packages/shared/src/utils/toolNames.ts' },
    content: 'File contents...',
    timestamp: Date.now() - 3400,
    parentId: 'agent-parent-1',
    depth: 1,
  },
]

/** Task with nested child tools (in progress) */
const nestedActivitiesInProgress: ActivityItem[] = [
  {
    id: 'task-2',
    type: 'tool',
    status: 'running',
    toolName: 'Task',
    toolUseId: 'task-parent-2',
    toolInput: { description: 'Implement new feature', subagent_type: 'general-purpose' },
    timestamp: Date.now() - 3000,
    depth: 0,
  },
  {
    id: 'read-3',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-child-3',
    toolInput: { file_path: 'src/components/Button.tsx' },
    content: 'Component file...',
    timestamp: Date.now() - 2500,
    parentId: 'task-parent-2',
    depth: 1,
  },
  {
    id: 'edit-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Edit',
    toolUseId: 'edit-child-1',
    toolInput: { file_path: 'src/components/Button.tsx' },
    content: 'Added onClick handler',
    timestamp: Date.now() - 2000,
    parentId: 'task-parent-2',
    depth: 1,
  },
  {
    id: 'write-1',
    type: 'tool',
    status: 'running',
    toolName: 'Write',
    toolUseId: 'write-child-1',
    toolInput: { file_path: 'src/components/NewFeature.tsx' },
    timestamp: Date.now() - 500,
    parentId: 'task-parent-2',
    depth: 1,
  },
]

/** Multiple nested Task tools */
const multipleNestedTasks: ActivityItem[] = [
  {
    id: 'task-a',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-a-id',
    toolInput: { description: 'Analyze code quality', subagent_type: 'Explore' },
    content: 'Analysis complete',
    timestamp: Date.now() - 10000,
    depth: 0,
  },
  {
    id: 'grep-a1',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolUseId: 'grep-a1-id',
    toolInput: { pattern: 'TODO|FIXME' },
    content: '23 issues found',
    timestamp: Date.now() - 9500,
    parentId: 'task-a-id',
    depth: 1,
  },
  {
    id: 'read-a1',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-a1-id',
    toolInput: { file_path: 'src/legacy/OldComponent.tsx' },
    content: 'Legacy code...',
    timestamp: Date.now() - 9000,
    parentId: 'task-a-id',
    depth: 1,
  },
  {
    id: 'task-b',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-b-id',
    toolInput: { description: 'Fix identified issues', subagent_type: 'general-purpose' },
    content: 'Issues fixed',
    timestamp: Date.now() - 5000,
    depth: 0,
  },
  {
    id: 'edit-b1',
    type: 'tool',
    status: 'completed',
    toolName: 'Edit',
    toolUseId: 'edit-b1-id',
    toolInput: { file_path: 'src/legacy/OldComponent.tsx' },
    content: 'Removed deprecated code',
    timestamp: Date.now() - 4500,
    parentId: 'task-b-id',
    depth: 1,
  },
  {
    id: 'bash-b1',
    type: 'tool',
    status: 'completed',
    toolName: 'Bash',
    toolUseId: 'bash-b1-id',
    toolInput: { command: 'npm run lint:fix', description: 'Auto-fix linting issues' },
    content: 'Fixed 12 issues',
    timestamp: Date.now() - 4000,
    parentId: 'task-b-id',
    depth: 1,
  },
  {
    id: 'write-b1',
    type: 'tool',
    status: 'completed',
    toolName: 'Write',
    toolUseId: 'write-b1-id',
    toolInput: { file_path: 'src/components/ModernComponent.tsx' },
    content: 'Created new component',
    timestamp: Date.now() - 3500,
    parentId: 'task-b-id',
    depth: 1,
  },
]

/** Deep nesting example (2+ levels) */
const deepNestedActivities: ActivityItem[] = [
  {
    id: 'task-outer',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-outer-id',
    toolInput: { description: 'Refactor authentication', subagent_type: 'Plan' },
    content: 'Refactoring complete',
    timestamp: Date.now() - 8000,
    depth: 0,
  },
  {
    id: 'task-inner',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-inner-id',
    toolInput: { description: 'Implement OAuth flow', subagent_type: 'general-purpose' },
    content: 'OAuth implemented',
    timestamp: Date.now() - 7500,
    parentId: 'task-outer-id',
    depth: 1,
  },
  {
    id: 'read-deep',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-deep-id',
    toolInput: { file_path: 'src/auth/oauth.ts' },
    content: 'OAuth config...',
    timestamp: Date.now() - 7000,
    parentId: 'task-inner-id',
    depth: 2,
  },
  {
    id: 'edit-deep',
    type: 'tool',
    status: 'completed',
    toolName: 'Edit',
    toolUseId: 'edit-deep-id',
    toolInput: { file_path: 'src/auth/oauth.ts' },
    content: 'Added PKCE support',
    timestamp: Date.now() - 6500,
    parentId: 'task-inner-id',
    depth: 2,
  },
  {
    id: 'write-auth',
    type: 'tool',
    status: 'completed',
    toolName: 'Write',
    toolUseId: 'write-auth-id',
    toolInput: { file_path: 'src/auth/callback.ts' },
    content: 'Created callback handler',
    timestamp: Date.now() - 6000,
    parentId: 'task-inner-id',
    depth: 2,
  },
  {
    id: 'bash-test',
    type: 'tool',
    status: 'completed',
    toolName: 'Bash',
    toolUseId: 'bash-test-id',
    toolInput: { command: 'npm test', description: 'Run auth tests' },
    content: 'All tests passed',
    timestamp: Date.now() - 5000,
    parentId: 'task-outer-id',
    depth: 1,
  },
]

type InputContainerMode = 'freeform' | 'permission' | 'admin_approval' | 'ask_user_question'

interface InputContainerPlaygroundProps {
  disabled?: boolean
  isProcessing?: boolean
  placeholder?: string
  currentModel?: string
  permissionMode?: PermissionMode
  workingDirectory?: string
  inputMode?: InputContainerMode
  compactMode?: boolean
  showOptionBadges?: boolean
  showTasks?: boolean
  showLabels?: boolean
  showStatuses?: boolean
  labelCount?: number
  showSources?: boolean
  sourceCount?: number
  showWorkingDirectory?: boolean
  seedRecentDirs?: boolean
  recentDirScenario?: RecentDirScenario
  showAttachments?: boolean
  attachmentCount?: number
  showFollowUps?: boolean
  followUpCount?: number
}

function InputContainerPlayground({
  disabled = false,
  isProcessing = false,
  placeholder = 'Message Qwen Code...',
  currentModel = 'qwen3-coder-plus',
  permissionMode = 'ask',
  workingDirectory = '/Users/demo/projects/craft-agent',
  inputMode = 'freeform',
  compactMode = false,
  showOptionBadges = true,
  showTasks = true,
  showLabels = true,
  showStatuses = true,
  labelCount = 3,
  showSources = true,
  sourceCount = 2,
  showWorkingDirectory = true,
  seedRecentDirs = true,
  recentDirScenario = 'few',
  showAttachments = false,
  attachmentCount = 2,
  showFollowUps = false,
  followUpCount = 2,
}: InputContainerPlaygroundProps) {
  const playgroundSessionId = 'playground-session'
  const [model, setModel] = React.useState(currentModel)
  const [mode, setMode] = React.useState<PermissionMode>(permissionMode)
  const [inputValue, setInputValue] = React.useState('')
  const [currentSessionStatus, setCurrentSessionStatus] = React.useState('in-progress')
  const [cwd, setCwd] = React.useState(workingDirectory)

  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  React.useEffect(() => {
    if (!seedRecentDirs) return
    setRecentWorkingDirs(getRecentDirsForScenario(recentDirScenario))
  }, [seedRecentDirs, recentDirScenario])

  React.useEffect(() => {
    setModel(currentModel)
  }, [currentModel])

  React.useEffect(() => {
    setMode(permissionMode)
  }, [permissionMode])

  React.useEffect(() => {
    setCwd(workingDirectory)
  }, [workingDirectory])

  const labels = React.useMemo(() => inputContainerSampleLabels.slice(0, Math.max(1, Math.min(labelCount, inputContainerSampleLabels.length))), [labelCount])

  const [sessionLabels, setSessionLabels] = React.useState<string[]>(['bug', 'priority::2', 'sprint::Q1-S3'])

  React.useEffect(() => {
    const next = labels.map((label) => {
      if (label.id === 'priority') return 'priority::2'
      if (label.id === 'due-date') return 'due-date::2026-03-15'
      if (label.id === 'sprint') return 'sprint::Q1-S3'
      return label.id
    })
    setSessionLabels(next)
  }, [labels])

  const sources = React.useMemo(() => mockSources.slice(0, Math.max(1, Math.min(sourceCount, mockSources.length))), [sourceCount])
  const defaultEnabled = React.useMemo(() => sources.slice(0, Math.min(2, sources.length)).map(source => source.config.slug), [sources])
  const [enabledSourceSlugs, setEnabledSourceSlugs] = React.useState<string[]>(defaultEnabled)

  React.useEffect(() => {
    setEnabledSourceSlugs(defaultEnabled)
  }, [defaultEnabled])

  const followUpItems = React.useMemo(() => {
    const samples = [
      {
        id: 'fu-a',
        messageId: 'assistant-msg-1',
        annotationId: 'annotation-1',
        index: 1,
        noteLabel: 'Prevent stale token from discarding draft input.',
        selectedText: 'Include OAuth refresh edge cases',
        color: 'info',
      },
      {
        id: 'fu-b',
        messageId: 'assistant-msg-1',
        annotationId: 'annotation-2',
        index: 2,
        noteLabel: 'Check compact mode and quick mode switching.',
        selectedText: 'Validate animation with permission mode transitions',
        color: 'info',
      },
      {
        id: 'fu-c',
        messageId: 'assistant-msg-2',
        annotationId: 'annotation-3',
        index: 3,
        noteLabel: 'Review spacing and overflow for label/source badge density.',
        selectedText: 'Review label + source badge density on narrow widths',
        color: 'info',
      },
      {
        id: 'fu-d',
        messageId: 'assistant-msg-3',
        annotationId: 'annotation-4',
        index: 4,
        noteLabel: 'Add chip click affordance for jumping back to annotation',
        selectedText: 'Add chip click affordance for jumping back to annotation',
        color: 'info',
      },
    ]
    if (!showFollowUps) return []
    return samples.slice(0, Math.max(1, Math.min(followUpCount, samples.length)))
  }, [showFollowUps, followUpCount])

  const attachmentFiles = React.useMemo(() => {
    if (!showAttachments) return [] as File[]

    const imageBytes = sampleImageAttachment.base64
      ? Uint8Array.from(atob(sampleImageAttachment.base64), char => char.charCodeAt(0))
      : new Uint8Array([137, 80, 78, 71])

    const samples: File[] = [
      new File([imageBytes], sampleImageAttachment.name, { type: sampleImageAttachment.mimeType }),
      new File(['%PDF-1.4\n% Playground sample\n'], samplePdfAttachment.name, { type: samplePdfAttachment.mimeType }),
      new File(['export function App() {\n  return <div>Hello Playground</div>\n}\n'], sampleCodeAttachment.name, { type: sampleCodeAttachment.mimeType }),
    ]

    return samples.slice(0, Math.max(1, Math.min(attachmentCount, samples.length)))
  }, [showAttachments, attachmentCount])

  const attachmentSeedKey = React.useMemo(() => {
    if (!showAttachments) return 'none'
    return attachmentFiles.map(file => `${file.name}:${file.size}`).join('|')
  }, [showAttachments, attachmentFiles])

  React.useEffect(() => {
    if (!showAttachments || attachmentFiles.length === 0) return

    const timer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('craft:paste-files', {
        detail: {
          files: attachmentFiles,
          sessionId: playgroundSessionId,
        },
      }))
    }, 0)

    return () => clearTimeout(timer)
  }, [showAttachments, attachmentSeedKey, attachmentFiles, playgroundSessionId])

  const structuredInput = React.useMemo(() => {
    if (inputMode === 'permission') {
      return {
        type: 'permission' as const,
        data: samplePermissionRequest,
      }
    }

    if (inputMode === 'admin_approval') {
      return {
        type: 'admin_approval' as const,
        data: mockAdminApprovalRequest({
          appName: 'Docker Desktop',
          reason: 'Homebrew needs admin access to complete post-install steps.',
          impact: 'May install files in /Applications and system-managed directories.',
          command: 'brew install --cask docker',
        }),
      }
    }

    if (inputMode === 'ask_user_question') {
      return {
        type: 'ask_user_question' as const,
        data: askUserQuestionRequest,
      }
    }

    return undefined
  }, [inputMode])

  return (
    <ModalProvider>
    <AppShellProvider value={playgroundAppShellContext as any}>
      <div className="w-full h-full flex flex-col bg-background">
        <div className="flex-1" />

        <ChatInputZone
          key={`input:${inputMode}:${compactMode ? 'compact' : 'full'}:${showAttachments ? attachmentSeedKey : 'none'}:${showFollowUps ? followUpCount : 0}:${seedRecentDirs ? recentDirScenario : 'unseeded'}`}
          compactMode={compactMode}
          showOptionBadges={showOptionBadges}
          permissionMode={mode}
          onPermissionModeChange={setMode}
          tasks={showTasks ? sampleBackgroundTasks : []}
          sessionId={playgroundSessionId}
          onKillTask={(taskId) => console.log('[Playground] Kill task:', taskId)}
          onInsertMessage={setInputValue}
          sessionLabels={showLabels ? sessionLabels : []}
          labels={showLabels ? labels : []}
          onLabelsChange={setSessionLabels}
          sessionStatuses={showStatuses ? inputContainerSampleStatuses : []}
          currentSessionStatus={showStatuses ? currentSessionStatus : undefined}
          onSessionStatusChange={setCurrentSessionStatus}
          inputProps={{
            placeholder,
            disabled,
            isProcessing,
            structuredInput,
            onStructuredResponse: (response) => {
              console.log('[Playground] Structured response:', response)
            },
            currentModel: model,
            sources: showSources ? sources : [],
            enabledSourceSlugs: showSources ? enabledSourceSlugs : [],
            onSourcesChange: showSources ? setEnabledSourceSlugs : undefined,
            workingDirectory: showWorkingDirectory ? cwd : undefined,
            onWorkingDirectoryChange: showWorkingDirectory ? setCwd : undefined,
            followUpItems,
            onSubmit: mockInputCallbacks.onSubmit,
            onModelChange: setModel,
            onInputChange: setInputValue,
            inputValue,
            onHeightChange: mockInputCallbacks.onHeightChange,
            onFocusChange: mockInputCallbacks.onFocusChange,
            onStop: mockInputCallbacks.onStop,
          }}
        />
      </div>
    </AppShellProvider>
    </ModalProvider>
  )
}

/**
 * Contextual wrapper for ActiveTasksBar showing it with messages and input
 */
interface ActiveTasksBarContextProps {
  tasks?: BackgroundTask[]
}

function ActiveTasksBarContext({ tasks = sampleBackgroundTasks }: ActiveTasksBarContextProps) {
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('ask')

  // Inject mock electronAPI for file attachments
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  return (
    <div className="w-full max-w-[960px] h-full flex flex-col">
      {/* Sample messages for context - matches ChatDisplay padding */}
      <div className="flex-1 overflow-auto px-5 py-8 space-y-2.5">
        {/* User message */}
        <div className="pt-3 flex justify-end">
          <div className="max-w-[80%] rounded-2xl bg-foreground text-background px-4 py-2">
            <p className="text-sm">Can you explore the codebase structure and analyze the API endpoints?</p>
          </div>
        </div>

        {/* Assistant message */}
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2">
            <p className="text-sm">I'll explore the codebase and analyze the API endpoints. Let me start by running a background task to search for API route definitions...</p>
          </div>
        </div>
      </div>

      {/* Input area - matches ChatDisplay padding */}
      <div className="mx-auto w-full px-4 pb-4 mt-1" style={{ maxWidth: 'var(--content-max-width, 960px)' }}>
        {/* Active option badges and tasks */}
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          tasks={tasks}
          sessionId="playground-session"
          onKillTask={(taskId) => console.log('[Playground] Kill task:', taskId)}
        />

        {/* Real InputContainer */}
        <InputContainer
          placeholder="Message Qwen Code..."
          disabled={false}
          isProcessing={false}
          currentModel="qwen3-coder-plus"
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          sources={mockSources}
          enabledSourceSlugs={['github-api', 'local-files']}
          workingDirectory="/Users/demo/projects/craft-agent"
          sessionId="playground-session"
          onSubmit={mockInputCallbacks.onSubmit}
          onModelChange={mockInputCallbacks.onModelChange}
          onInputChange={mockInputCallbacks.onInputChange}
          onHeightChange={mockInputCallbacks.onHeightChange}
          onFocusChange={mockInputCallbacks.onFocusChange}
          onSourcesChange={mockInputCallbacks.onSourcesChange}
          onWorkingDirectoryChange={mockInputCallbacks.onWorkingDirectoryChange}
          onStop={mockInputCallbacks.onStop}
        />
      </div>
    </div>
  )
}

/**
 * Interactive test component for Permission UI ↔ Input View animation transitions
 * Allows toggling between states to inspect the animate in/out behavior
 */
interface PermissionInputToggleProps {
  autoToggle?: boolean
  autoToggleInterval?: number
  useLongCommand?: boolean
}

function PermissionInputToggle({ autoToggle = false, autoToggleInterval = 3000, useLongCommand = false }: PermissionInputToggleProps) {
  const [showPermission, setShowPermission] = React.useState(false)
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('ask')

  const permissionRequest = useLongCommand ? veryLongPermissionRequest : samplePermissionRequest

  // Auto-toggle for continuous animation testing
  React.useEffect(() => {
    if (!autoToggle) return
    const interval = setInterval(() => {
      setShowPermission(prev => !prev)
    }, autoToggleInterval)
    return () => clearInterval(interval)
  }, [autoToggle, autoToggleInterval])

  // Inject mock electronAPI for file attachments
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  const handlePermissionResponse = (response: StructuredResponse) => {
    console.log('[Playground] Structured response:', response)
    setShowPermission(false)
  }

  // Build structuredInput state for real InputContainer
  const structuredInput = showPermission ? {
    type: 'permission' as const,
    data: permissionRequest,
  } : undefined

  return (
    <div className="w-full max-w-[960px] h-full flex flex-col px-4 pb-4">
      {/* Spacer to push content to bottom */}
      <div className="flex-1" />

      {/* Control buttons */}
      <div className="flex items-center gap-2 mb-20">
        <Button
          variant={showPermission ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowPermission(true)}
          className="gap-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Show Permission
        </Button>
        <Button
          variant={!showPermission ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowPermission(false)}
          className="gap-1.5"
        >
          Show Input
        </Button>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          Current: <span className="font-medium">{showPermission ? 'Permission Banner' : 'Input View'}</span>
        </span>
      </div>

      {/* Active option badges */}
      <ActiveOptionBadges
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
      />

      {/* Real InputContainer - handles animation automatically */}
      <InputContainer
        placeholder="Message Qwen Code..."
        disabled={false}
        isProcessing={false}
        currentModel="qwen3-coder-plus"
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        sources={mockSources}
        enabledSourceSlugs={['github-api', 'local-files']}
        workingDirectory="/Users/demo/projects/craft-agent"
        sessionId="playground-session"
        structuredInput={structuredInput}
        onStructuredResponse={handlePermissionResponse}
        onSubmit={mockInputCallbacks.onSubmit}
        onModelChange={mockInputCallbacks.onModelChange}
        onInputChange={mockInputCallbacks.onInputChange}
        onHeightChange={mockInputCallbacks.onHeightChange}
        onFocusChange={mockInputCallbacks.onFocusChange}
        onSourcesChange={mockInputCallbacks.onSourcesChange}
        onWorkingDirectoryChange={mockInputCallbacks.onWorkingDirectoryChange}
        onStop={mockInputCallbacks.onStop}
      />
    </div>
  )
}

// Generate variants for all hints dynamically
const emptyStateHintVariants = Array.from({ length: getHintCount() }, (_, i) => ({
  name: `Hint ${i + 1}`,
  description: getHintTemplate(i).slice(0, 50) + '...',
  props: { hintIndex: i },
}))

export const chatComponents: ComponentEntry[] = [
  {
    id: 'empty-state-hint',
    name: 'EmptyStateHint',
    category: 'Chat',
    description: 'Rotating workflow suggestions for empty chat state with inline entity badges (sources, files, folders, skills)',
    component: EmptyStateHint,
    props: [
      {
        name: 'hintIndex',
        description: 'Specific hint to display (0-14). Leave empty for random.',
        control: { type: 'number', min: 0, max: 14, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: emptyStateHintVariants,
    mockData: () => ({}),
  },
  {
    id: 'attachment-preview',
    name: 'AttachmentPreview',
    category: 'Chat',
    description: 'attachment attachment preview strip showing attached files as bubbles above textarea',
    component: AttachmentPreview,
    props: [
      {
        name: 'disabled',
        description: 'Disable remove buttons',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'loadingCount',
        description: 'Number of loading placeholders to show',
        control: { type: 'number', min: 0, max: 5, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: [
      { name: 'Empty', props: { attachments: [], loadingCount: 0 } },
      { name: 'With Images', props: { attachments: [sampleImageAttachment, sampleImageAttachment] } },
      { name: 'With Documents', props: { attachments: [samplePdfAttachment, sampleCodeAttachment] } },
      { name: 'Mixed', props: { attachments: [sampleImageAttachment, samplePdfAttachment, sampleCodeAttachment] } },
      { name: 'Loading', props: { attachments: [], loadingCount: 3 } },
      { name: 'Disabled', props: { attachments: [sampleImageAttachment, samplePdfAttachment], disabled: true } },
    ],
    mockData: () => ({
      attachments: [sampleImageAttachment, samplePdfAttachment],
      onRemove: mockAttachmentCallbacks.onRemove,
    }),
  },
  {
    id: 'setup-auth-banner',
    name: 'SetupAuthBanner',
    category: 'Chat',
    description: 'Shows when an agent needs activation or authentication',
    component: SetupAuthBanner,
    props: [
      {
        name: 'state',
        description: 'Banner state',
        control: {
          type: 'select',
          options: [
            { label: 'Hidden', value: 'hidden' },
            { label: 'MCP Auth', value: 'mcp_auth' },
            { label: 'API Auth', value: 'api_auth' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'mcp_auth',
      },
      {
        name: 'reason',
        description: 'Custom reason message',
        control: { type: 'string', placeholder: 'Optional custom reason' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'MCP Auth', props: { state: 'mcp_auth' } },
      { name: 'API Auth', props: { state: 'api_auth' } },
      { name: 'Custom Reason', props: { state: 'api_auth', reason: 'Your OAuth token has expired. Please re-authenticate to continue.' } },
      { name: 'Error', props: { state: 'error' } },
      { name: 'Hidden', props: { state: 'hidden' } },
    ],
    mockData: () => ({
      onAction: () => console.log('[Playground] Setup/Auth action clicked'),
    }),
  },
  {
    id: 'active-option-badges',
    name: 'ActiveOptionBadges',
    category: 'Chat',
    description: 'Shows active options (permission mode) and background tasks as badge pills above chat input',
    component: ActiveOptionBadges,
    props: [
      {
        name: 'permissionMode',
        description: 'Current permission mode',
        control: {
          type: 'select',
          options: [
            { label: 'Safe Mode', value: 'safe' },
            { label: 'Ask Permission', value: 'ask' },
            { label: 'Allow All', value: 'allow-all' },
          ],
        },
        defaultValue: 'ask',
      },
      {
        name: 'variant',
        description: 'Interaction variant',
        control: {
          type: 'select',
          options: [
            { label: 'Dropdown', value: 'dropdown' },
            { label: 'Cycle', value: 'cycle' },
          ],
        },
        defaultValue: 'dropdown',
      },
    ],
    variants: [
      { name: 'Permission Mode (Ask)', props: { permissionMode: 'ask', tasks: [], sessionId: 'session-1' } },
      { name: 'Permission Mode (Safe)', props: { permissionMode: 'safe', tasks: [], sessionId: 'session-1' } },
      { name: 'Permission Mode (Allow All)', props: { permissionMode: 'allow-all', tasks: [], sessionId: 'session-1' } },
      { name: 'Single Task', props: { permissionMode: 'ask', tasks: singleBackgroundTask, sessionId: 'session-1' } },
      { name: 'Multiple Tasks', props: { permissionMode: 'ask', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Long Running Tasks', props: { permissionMode: 'ask', tasks: longRunningTasks, sessionId: 'session-1' } },
      { name: 'All Active (Everything)', props: { permissionMode: 'ask', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Tasks in Safe Mode', props: { permissionMode: 'safe', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Cycle Variant', props: { permissionMode: 'ask', tasks: sampleBackgroundTasks, variant: 'cycle', sessionId: 'session-1' } },
    ],
    mockData: () => ({
      tasks: sampleBackgroundTasks,
      sessionId: 'session-playground',
      onPermissionModeChange: (mode: string) => console.log('[Playground] Permission mode changed:', mode),
      onKillTask: (taskId: string) => console.log('[Playground] Kill task:', taskId),
    }),
  },
  {
    id: 'permission-input-toggle',
    name: 'Permission ↔ Input Toggle',
    category: 'Chat',
    description: 'Interactive test for animating between Permission Banner and Input View. Click buttons to toggle states and inspect animations.',
    component: PermissionInputToggle,
    props: [
      {
        name: 'useLongCommand',
        description: 'Use a very long multi-line command',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'autoToggle',
        description: 'Automatically toggle between states',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'autoToggleInterval',
        description: 'Auto-toggle interval in milliseconds',
        control: { type: 'number', min: 1000, max: 10000, step: 500 },
        defaultValue: 3000,
      },
    ],
    variants: [
      { name: 'Short Command', props: { useLongCommand: false } },
      { name: 'Long Command (10+ lines)', props: { useLongCommand: true } },
      { name: 'Auto Toggle', props: { autoToggle: true, autoToggleInterval: 2000 } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'turn-card-flat',
    name: 'TurnCard (Flat Tools)',
    category: 'Turn Cards',
    description: 'TurnCard with flat tool hierarchy - no nesting, all tools at root level',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: flatActivities,
      response: { text: 'I found the pattern across the codebase and made the necessary edits.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'turn-card-nested-complete',
    name: 'TurnCard (Nested - Complete)',
    category: 'Turn Cards',
    description: 'TurnCard showing Task subagent with completed child tools - vertical line tree view',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: nestedActivitiesCompleted,
      response: { text: 'Exploration complete. I found 24 React components with 156 exported functions. The codebase follows a modular pattern.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'turn-card-sub-agent-qwen',
    name: 'TurnCard (Sub-Agent - Qwen)',
    category: 'Turn Cards',
    description: 'TurnCard showing the Qwen CLI lowercase agent tool grouped as a sub-agent',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: qwenAgentActivities,
      response: { text: 'The sub-agent found the lowercase agent tool name and checked the renderer path.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'turn-card-nested-progress',
    name: 'TurnCard (Nested - In Progress)',
    category: 'Turn Cards',
    description: 'TurnCard showing Task subagent with child tools still running',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: nestedActivitiesInProgress,
      isStreaming: true,
      isComplete: false,
    }),
  },
  {
    id: 'turn-card-multi-task',
    name: 'TurnCard (Multiple Tasks)',
    category: 'Turn Cards',
    description: 'TurnCard showing multiple sequential Task subagents, each with their own child tools',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: multipleNestedTasks,
      response: { text: 'Analysis and fixes complete. I found 23 TODO/FIXME issues, removed deprecated code, and created a modern replacement component.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'turn-card-deep-nested',
    name: 'TurnCard (Deep Nesting)',
    category: 'Turn Cards',
    description: 'TurnCard showing 2+ levels of nesting - Task containing another Task with tools',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: deepNestedActivities,
      response: { text: 'Authentication refactoring complete. I implemented OAuth with PKCE, created a callback handler, and all tests pass.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'active-tasks-bar-context',
    name: 'Active Tasks & Badges',
    category: 'Chat',
    description: 'Integrated display of option badges (permission mode) and background tasks in a horizontally scrollable row. Shows full chat context with messages above and input below.',
    component: ActiveTasksBarContext,
    layout: 'full',
    props: [],
    variants: [
      { name: 'With Multiple Tasks', props: { tasks: sampleBackgroundTasks } },
      { name: 'With Single Task', props: { tasks: singleBackgroundTask } },
      { name: 'With Long Running Tasks', props: { tasks: longRunningTasks } },
      { name: 'Empty (Hidden)', props: { tasks: [] } },
    ],
    mockData: () => ({
      tasks: sampleBackgroundTasks,
    }),
  },
  {
    id: 'input-container',
    name: 'InputContainer',
    category: 'Chat Inputs',
    description: 'App-like input zone with max-width layout, active option badges, labels, statuses, tasks, and full InputContainer behavior',
    component: InputContainerPlayground,
    layout: 'full',
    previewOverflow: 'visible',
    props: [
      {
        name: 'inputMode',
        description: 'Input mode rendered by InputContainer',
        control: {
          type: 'select',
          options: [
            { label: 'Freeform', value: 'freeform' },
            { label: 'Permission', value: 'permission' },
            { label: 'Admin Approval', value: 'admin_approval' },
            { label: 'Ask User Question', value: 'ask_user_question' },
          ],
        },
        defaultValue: 'freeform',
      },
      {
        name: 'disabled',
        description: 'Disable all inputs',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isProcessing',
        description: 'Show processing state (disables send, shows stop)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'compactMode',
        description: 'Compact mode used by embedded editors/popovers',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'placeholder',
        description: 'Textarea placeholder text',
        control: { type: 'string', placeholder: 'Message...' },
        defaultValue: 'Message Qwen Code...',
      },
      {
        name: 'currentModel',
        description: 'Current selected model',
        control: {
          type: 'select',
          options: [
            { label: 'Qwen Plus', value: 'qwen3-coder-plus' },
            { label: 'Qwen Plus', value: 'qwen3-coder-plus' },
            { label: 'Qwen Flash', value: 'qwen3-coder-flash' },
          ],
        },
        defaultValue: 'qwen3-coder-plus',
      },
      {
        name: 'permissionMode',
        description: 'Permission mode badge',
        control: {
          type: 'select',
          options: [
            { label: 'Safe (read-only)', value: 'safe' },
            { label: 'Ask (prompt)', value: 'ask' },
            { label: 'Allow All', value: 'allow-all' },
          ],
        },
        defaultValue: 'ask',
      },
      {
        name: 'showOptionBadges',
        description: 'Show the ActiveOptionBadges row above input',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showTasks',
        description: 'Include background tasks in badges row',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showLabels',
        description: 'Include label badges and value editing',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'labelCount',
        description: 'Number of label configs to show',
        control: { type: 'number', min: 1, max: 4, step: 1 },
        defaultValue: 3,
      },
      {
        name: 'showStatuses',
        description: 'Include session status badge and menu',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showSources',
        description: 'Enable sources selector badge and source mentions',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'sourceCount',
        description: 'How many sources are available in selector',
        control: { type: 'number', min: 1, max: 4, step: 1 },
        defaultValue: 2,
      },
      {
        name: 'showWorkingDirectory',
        description: 'Show working directory context badge',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'workingDirectory',
        description: 'Current working directory',
        control: { type: 'string', placeholder: '/path/to/project' },
        defaultValue: '/Users/demo/projects/craft-agent',
      },
      {
        name: 'seedRecentDirs',
        description: 'Seed recent working directory history in playground local storage',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'recentDirScenario',
        description: 'Fixture set used for recent working directory history',
        control: {
          type: 'select',
          options: [
            { label: 'Few (3 items)', value: 'few' },
            { label: 'Many (9 items + filter)', value: 'many' },
            { label: 'None (empty)', value: 'none' },
          ],
        },
        defaultValue: 'few',
      },
      {
        name: 'showAttachments',
        description: 'Show preloaded attachment chips above editor',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'attachmentCount',
        description: 'Number of preloaded attachments to preview',
        control: { type: 'number', min: 1, max: 3, step: 1 },
        defaultValue: 2,
      },
      {
        name: 'showFollowUps',
        description: 'Show follow-up annotation chips above editor',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'followUpCount',
        description: 'Number of follow-up chips to preview',
        control: { type: 'number', min: 1, max: 4, step: 1 },
        defaultValue: 2,
      },
    ],
    mockData: () => ({}),
    variants: [
      {
        name: 'Default (Comprehensive)',
        description: 'App-like full setup with badges, labels, statuses, sources, and working directory',
        props: {},
      },
      {
        name: 'Working Dir History (Few)',
        description: 'Recent working directory list with a few entries (remove button testing)',
        props: {
          showWorkingDirectory: true,
          seedRecentDirs: true,
          recentDirScenario: 'few',
        },
      },
      {
        name: 'Working Dir History (Many + Filter)',
        description: 'Recent working directory list with many entries to trigger filter input path',
        props: {
          showWorkingDirectory: true,
          seedRecentDirs: true,
          recentDirScenario: 'many',
        },
      },
      {
        name: 'Working Dir History (Empty)',
        description: 'No recent directory history (empty state)',
        props: {
          showWorkingDirectory: true,
          seedRecentDirs: true,
          recentDirScenario: 'none',
        },
      },
      {
        name: 'Minimal',
        description: 'Input only — no badges, no sources, no cwd badge',
        props: {
          showOptionBadges: false,
          showSources: false,
          showWorkingDirectory: false,
        },
      },
      {
        name: 'Processing + Tasks',
        description: 'Streaming/processing state with background task badges',
        props: {
          isProcessing: true,
          showTasks: true,
          showOptionBadges: true,
        },
      },
      {
        name: 'Safe + Compact',
        description: 'Plan mode style in compact embedding',
        props: {
          permissionMode: 'safe',
          compactMode: true,
          showTasks: false,
        },
      },
      {
        name: 'Permission Mode UI',
        description: 'Structured permission request replaces freeform input',
        props: {
          inputMode: 'permission',
          showFollowUps: false,
        },
      },
      {
        name: 'Admin Approval UI',
        description: 'Structured admin approval request state',
        props: {
          inputMode: 'admin_approval',
          showFollowUps: false,
        },
      },
      {
        name: 'Label-heavy Review',
        description: 'Many labels + status for metadata density checks',
        props: {
          showLabels: true,
          labelCount: 4,
          showStatuses: true,
          showTasks: false,
        },
      },
      {
        name: 'Source-heavy Review',
        description: 'Multiple source avatars and source selector stress test',
        props: {
          showSources: true,
          sourceCount: 4,
          showWorkingDirectory: false,
        },
      },
      {
        name: 'Follow-up Review',
        description: 'Follow-up annotation chips visible in input',
        props: {
          showFollowUps: true,
          followUpCount: 3,
        },
      },
      {
        name: 'Attachments + Follow-ups',
        description: 'Preloaded attachments with follow-up annotation chips visible together',
        props: {
          showAttachments: true,
          attachmentCount: 2,
          showFollowUps: true,
          followUpCount: 3,
        },
      },
      {
        name: 'Disabled',
        description: 'Fully disabled state',
        props: {
          disabled: true,
        },
      },
    ],
  },
]
