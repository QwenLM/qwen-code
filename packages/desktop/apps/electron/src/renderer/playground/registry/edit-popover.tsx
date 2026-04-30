import * as React from 'react'
import { useState, useCallback, useEffect, useRef } from 'react'
import type { ComponentEntry } from './types'
import type { Session } from '../../../shared/types'
import type { Message } from '@craft-agent/core/types'
import { ChatDisplay } from '../../components/app-shell/ChatDisplay'
import { EditPopover, type EditContext } from '../../components/ui/EditPopover'
import { FocusProvider } from '../../context/FocusContext'
import { EscapeInterruptProvider } from '../../context/EscapeInterruptContext'
import { AppShellProvider } from '../../context/AppShellContext'
import { ensureMockElectronAPI } from '../mock-utils'
import { GripHorizontal, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// Ensure mock electronAPI is available before any component renders
ensureMockElectronAPI()

// ============================================================================
// Sample Message Data
// ============================================================================

const createMessage = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  isIntermediate = false
): Message => ({
  id,
  role: role,
  content,
  isIntermediate,
  timestamp: Date.now(),
})

// Empty session - initial state before any messages
const emptyMessages: Message[] = []

// User just sent a message
const userMessageOnly: Message[] = [
  createMessage('msg-1', 'user', 'Add a "Blocked" status with orange color'),
]

// Agent is thinking/processing
const processingMessages: Message[] = [
  createMessage('msg-1', 'user', 'Add a "Blocked" status with orange color'),
  createMessage('msg-2', 'assistant', 'I\'ll add a "Blocked" status to your statuses configuration...', true),
]

// Short conversation - completed
const completedMessages: Message[] = [
  createMessage('msg-1', 'user', 'Add a "Bug" label with red color'),
  createMessage('msg-2', 'assistant', 'Added the **Bug** label with red color to your labels configuration.\n\nThe label is now available in the # menu and will appear as a red circle badge on sessions.'),
]

// Longer conversation with follow-up
const conversationMessages: Message[] = [
  createMessage('msg-1', 'user', 'Add a "Blocked" status'),
  createMessage('msg-2', 'assistant', 'I\'ve added a "Blocked" status to your configuration. What color would you like for it?'),
  createMessage('msg-3', 'user', 'Make it orange'),
  createMessage('msg-4', 'assistant', 'Updated the **Blocked** status with orange color. It will now appear in your status menu with an orange indicator.'),
]

// Error scenario
const errorMessages: Message[] = [
  createMessage('msg-1', 'user', 'Add a label called "bug"'),
  createMessage('msg-2', 'assistant', 'I attempted to add the label, but encountered an error:\n\n**Label ID "bug" already exists**\n\nWould you like me to use a different ID like "bug-report" instead?'),
]

// ============================================================================
// Helper to create Session from messages
// ============================================================================

const createSession = (messages: Message[], isProcessing = false): Session => ({
  id: 'playground-session',
  workspaceId: 'playground-workspace',
  workspaceName: 'Playground',
  messages,
  isProcessing,
  lastMessageAt: Date.now(),
})

// ============================================================================
// Compact ChatDisplay Preview Wrapper
// ============================================================================

interface CompactChatPreviewProps {
  messages: Message[]
  isProcessing?: boolean
  placeholder?: string
}

/**
 * Wrapper that renders ChatDisplay in compact mode with a popover-like container
 * to simulate how it appears in the EditPopover.
 */
function CompactChatPreview({
  messages = completedMessages,
  isProcessing = false,
  placeholder = "Describe what you'd like to change...",
}: CompactChatPreviewProps) {
  const [model, setModel] = useState('haiku')
  const session = createSession(messages, isProcessing)

  // Drag state for movable preview
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 })

  // Resize state
  const [size, setSize] = useState({ width: 400, height: 400 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

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
      const deltaX = e.clientX - dragStartRef.current.x
      const deltaY = e.clientY - dragStartRef.current.y
      setDragOffset({
        x: dragStartRef.current.offsetX + deltaX,
        y: dragStartRef.current.offsetY + deltaY,
      })
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
      width: size.width,
      height: size.height,
    }
  }, [size])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartRef.current.x
      const deltaY = e.clientY - resizeStartRef.current.y
      setSize({
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

  const handleSendMessage = (message: string) => {
    console.log('[Playground] Send message:', message)
  }

  const handleOpenFile = (path: string) => {
    console.log('[Playground] Open file:', path)
  }

  const handleOpenUrl = (url: string) => {
    console.log('[Playground] Open URL:', url)
  }

  return (
    <FocusProvider>
      <EscapeInterruptProvider>
        <div
          className="popover-styled p-0 overflow-hidden relative"
          style={{
            width: size.width,
            height: size.height,
            borderRadius: 16,
            transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
          }}
        >
          {/* Drag handle - 4px lower with asymmetric padding */}
          <div
            onMouseDown={handleDragStart}
            className={cn(
              "flex items-center justify-center pt-2.5 pb-1.5 border-b border-border/30 cursor-grab",
              isDragging && "cursor-grabbing"
            )}
          >
            <GripHorizontal className="w-4 h-4 text-muted-foreground/50" />
          </div>

          {/* Content - compact ChatDisplay */}
          <div className="flex-1 flex flex-col" style={{ height: 'calc(100% - 34px)' }}>
            <ChatDisplay
              session={session}
              onSendMessage={handleSendMessage}
              onOpenFile={handleOpenFile}
              onOpenUrl={handleOpenUrl}
              currentModel={model}
              onModelChange={setModel}
              compactMode={true}
              placeholder={placeholder}
            />
          </div>

          {/* Bottom-right resize handle - invisible hit area */}
          <div
            onMouseDown={handleResizeStart}
            className="absolute -bottom-2 -right-2 w-6 h-6 cursor-nwse-resize"
          />
        </div>
      </EscapeInterruptProvider>
    </FocusProvider>
  )
}

// ============================================================================
// EditPopover Preview Wrapper
// ============================================================================

// Mock AppShell context for playground
const mockAppShellContext = {
  sessions: [],
  workspaces: [{ id: 'playground-workspace', name: 'Playground', path: '/playground', rootPath: '/playground' }],
  activeWorkspaceId: 'playground-workspace',
  activeSessionId: null,
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  currentModel: 'haiku',
  connectionDefaultModel: null,
  sessionOptions: new Map(),
  getDraft: () => '',
  onSelectSession: () => {},
  onSelectWorkspace: () => {},
  onOpenSettings: () => {},
  onOpenKeyboardShortcuts: () => {},
  onOpenStoredUserPreferences: () => {},
  onReset: () => {},
  onSessionOptionsChange: () => {},
  onInputChange: () => {},
  onOpenFile: () => {},
  onOpenUrl: () => {},
  onModelChange: () => {},
  onRefreshWorkspaces: () => {},
  // Session callbacks required by EditPopover
  onCreateSession: async (workspaceId: string) => ({
    id: 'mock-session-' + Date.now(),
    workspaceId,
    workspaceName: 'Playground',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }),
  onSendMessage: (sessionId: string, message: string) => {
    console.log('[Playground] Send message to session:', sessionId, message)
  },
  onRenameSession: () => {},
  onFlagSession: () => {},
  onUnflagSession: () => {},
  onMarkSessionRead: () => {},
  onMarkSessionUnread: () => {},
  onSetActiveViewingSession: () => {},
  onSessionStatusChange: () => {},
  onDeleteSession: async () => true,
}

// Sample edit context for playground
const sampleEditContext: EditContext = {
  label: 'Label Configuration',
  filePath: '/playground/labels/config.json',
  context: 'Playground demo of EditPopover component.',
}

interface EditPopoverPreviewProps {
  inlineExecution?: boolean
  example?: string
  triggerLabel?: string
}

/**
 * Wrapper that renders the actual EditPopover component with a trigger button
 */
function EditPopoverPreview({
  inlineExecution = true,
  example = 'Add a "Bug" label with red color',
  triggerLabel = "Edit",
}: EditPopoverPreviewProps) {
  return (
    <AppShellProvider value={mockAppShellContext as any}>
      <FocusProvider>
        <EscapeInterruptProvider>
          <div className="flex flex-col items-center gap-4">
            <EditPopover
              trigger={
                <Button variant="outline" size="sm">
                  <Pencil className="w-4 h-4 mr-2" />
                  {triggerLabel}
                </Button>
              }
              context={sampleEditContext}
              example={example}
              inlineExecution={inlineExecution}
            />
            <p className="text-xs text-muted-foreground">Click the button to open the popover</p>
          </div>
        </EscapeInterruptProvider>
      </FocusProvider>
    </AppShellProvider>
  )
}

// ============================================================================
// Registry Entries
// ============================================================================

export const editPopoverComponents: ComponentEntry[] = [
  {
    id: 'edit-popover',
    name: 'EditPopover',
    category: 'Edit Popover',
    description: 'The actual EditPopover component with trigger button',
    component: EditPopoverPreview,
    props: [
      {
        name: 'inlineExecution',
        description: 'Use inline execution mode (compact ChatDisplay)',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'example',
        description: 'Example text shown in placeholder',
        control: { type: 'string', placeholder: 'Enter example...' },
        defaultValue: 'Add a "Bug" label with red color',
      },
      {
        name: 'triggerLabel',
        description: 'Label for the trigger button',
        control: { type: 'string', placeholder: 'Button label...' },
        defaultValue: "Edit",
      },
    ],
    variants: [
      {
        name: 'Inline Execution (Default)',
        description: 'Uses compact ChatDisplay for inline agent execution',
        props: {
          inlineExecution: true,
          example: 'Add a "Bug" label with red color',
          triggerLabel: "Edit with AI",
        },
      },
      {
        name: 'Legacy Mode',
        description: 'Opens new window instead of inline execution',
        props: {
          inlineExecution: false,
          example: 'Update the status colors',
          triggerLabel: "Quick Edit",
        },
      },
      {
        name: 'Add Source',
        description: 'Styled for adding a new source',
        props: {
          inlineExecution: true,
          example: 'Connect to my GitHub repo',
          triggerLabel: "Add Source",
        },
      },
      {
        name: 'Add Skill',
        description: 'Styled for adding a new skill',
        props: {
          inlineExecution: true,
          example: 'Review PRs following our code standards',
          triggerLabel: "Add Skill",
        },
      },
    ],
  },
  {
    id: 'compact-chat-display',
    name: 'Compact ChatDisplay',
    category: 'Edit Popover',
    description: 'Full chat experience in compact mode for inline editing in popovers',
    component: CompactChatPreview,
    props: [
      {
        name: 'isProcessing',
        description: 'Whether the agent is currently processing',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'placeholder',
        description: 'Placeholder text for the input',
        control: { type: 'string', placeholder: 'Enter placeholder...' },
        defaultValue: "Describe what you'd like to change...",
      },
    ],
    variants: [
      {
        name: 'Empty (Initial State)',
        description: 'No messages yet, ready for user input',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: "Describe what you'd like to change, e.g., \"Add a Blocked status\"",
        },
      },
      {
        name: 'User Message Sent',
        description: 'User just sent a message, waiting for response',
        props: {
          messages: userMessageOnly,
          isProcessing: true,
        },
      },
      {
        name: 'Processing (Thinking)',
        description: 'Agent is thinking with intermediate message',
        props: {
          messages: processingMessages,
          isProcessing: true,
        },
      },
      {
        name: 'Completed (Short)',
        description: 'Single turn completed successfully',
        props: {
          messages: completedMessages,
          isProcessing: false,
        },
      },
      {
        name: 'Conversation (Multi-turn)',
        description: 'Back-and-forth conversation with follow-ups',
        props: {
          messages: conversationMessages,
          isProcessing: false,
        },
      },
      {
        name: 'Error Response',
        description: 'Agent encountered an issue and is asking for clarification',
        props: {
          messages: errorMessages,
          isProcessing: false,
        },
      },
      {
        name: 'Add Source Context',
        description: 'Using "add source" placeholder style',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: 'What would you like to connect?',
        },
      },
      {
        name: 'Add Skill Context',
        description: 'Using "add skill" placeholder style',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: 'What should I learn to do?',
        },
      },
    ],
    mockData: () => ({
      messages: completedMessages,
    }),
  },
]
