import type { ComponentEntry } from './types'
import { useState, useEffect, type ReactNode } from 'react'
import {
  TurnCard,
  DocumentFormattedMarkdownOverlay,
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  JSONPreviewOverlay,
  GenericOverlay,
  DataTableOverlay,
  type ActivityItem,
  type ResponseContent,
  type TodoItem,
  type FileChange,
} from '@craft-agent/ui'

/** Wrapper with padding for playground preview */
function PaddedWrapper({ children }: { children: ReactNode }) {
  return <div className="p-8">{children}</div>
}

// ============================================================================
// Streaming Simulation Components
// ============================================================================

const streamingTextSample = `I've analyzed the authentication system and here's what I found:

## Authentication Architecture

The authentication system is built around three main components:

### 1. AuthHandler (\`src/auth/index.ts\`)
- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management

\`\`\`typescript
export class AuthHandler {
  async authenticate(credentials: Credentials): Promise<Session> {
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }
}
\`\`\`

### 2. TokenManager
- Stores tokens securely using encryption
- Handles automatic token refresh before expiry

### 3. SessionStore
- Maintains active user sessions
- Handles session timeout and cleanup

Would you like me to implement any improvements?`

/**
 * Realistic streaming simulation with:
 * - Fast character streaming (simulates real LLM token rate)
 * - Component batching accumulates into word-sized chunks
 * - Pauses at punctuation for natural rhythm
 */
function useStreamingSimulation(
  fullText: string,
  speed: 'slow' | 'normal' | 'fast' = 'normal',
) {
  const [streamedText, setStreamedText] = useState('')
  const [isComplete, setIsComplete] = useState(false)

  useEffect(() => {
    setStreamedText('')
    setIsComplete(false)
    let index = 0
    let timeoutId: ReturnType<typeof setTimeout>

    // Speed configs: chars per tick, base interval
    // Fast intervals let component batching accumulate words
    const speedConfig = {
      slow: { charsPerTick: 1, baseInterval: 20, punctuationDelay: 300 },
      normal: { charsPerTick: 2, baseInterval: 10, punctuationDelay: 150 },
      fast: { charsPerTick: 4, baseInterval: 5, punctuationDelay: 50 },
    }
    const config = speedConfig[speed]

    function tick() {
      if (index >= fullText.length) {
        setIsComplete(true)
        return
      }

      const currentChar = fullText[index]
      const isPunctuation = /[.!?,;:\n]/.test(currentChar)

      // Send chars
      index = Math.min(index + config.charsPerTick, fullText.length)
      setStreamedText(fullText.slice(0, index))

      // Pause at punctuation for natural rhythm
      const nextInterval = isPunctuation
        ? config.punctuationDelay
        : config.baseInterval

      timeoutId = setTimeout(tick, nextInterval)
    }

    // Start with small delay
    timeoutId = setTimeout(tick, 100)

    return () => clearTimeout(timeoutId)
  }, [fullText, speed])

  return { streamedText, isComplete }
}

/** TurnCard wrapper that simulates streaming response */
function StreamingSimulationTurnCard({
  activities,
  intent,
  simulationSpeed = 'normal',
}: {
  activities: ActivityItem[]
  intent?: string
  simulationSpeed?: 'slow' | 'normal' | 'fast'
}) {
  const { streamedText, isComplete } = useStreamingSimulation(
    streamingTextSample,
    simulationSpeed,
  )

  const response: ResponseContent = {
    text: streamedText,
    isStreaming: !isComplete,
  }

  return (
    <TurnCard
      sessionId="playground-session"
      turnId="playground-turn"
      activities={activities}
      response={response}
      intent={intent}
      isStreaming={!isComplete}
      isComplete={isComplete}
      onOpenFile={(path) => console.log('[Playground] Open file:', path)}
      onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
    />
  )
}

// ============================================================================
// Sample Data
// ============================================================================

const now = Date.now()

// Completed tool activities
const completedGrepActivity: ActivityItem = {
  id: 'tool-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Grep',
  toolInput: { pattern: 'AuthHandler', path: 'src/' },
  intent: 'Searching for authentication handlers',
  timestamp: now - 5000,
}

const completedReadActivity1: ActivityItem = {
  id: 'tool-2',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/auth/index.ts' },
  timestamp: now - 4000,
}

const completedReadActivity2: ActivityItem = {
  id: 'tool-3',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/auth/oauth.ts' },
  timestamp: now - 3000,
}

const completedBashActivity: ActivityItem = {
  id: 'tool-4',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: { command: 'npm test', description: 'Running tests' },
  intent: 'Running the test suite',
  timestamp: now - 2000,
}

// Running tool activities
const runningGrepActivity: ActivityItem = {
  id: 'tool-running-1',
  type: 'tool',
  status: 'running',
  toolName: 'Grep',
  toolInput: { pattern: 'handleError', path: 'src/' },
  intent: 'Finding error handling patterns',
  timestamp: now - 1000,
}

const runningReadActivity: ActivityItem = {
  id: 'tool-running-2',
  type: 'tool',
  status: 'running',
  toolName: 'Read',
  toolInput: { file_path: '/src/lib/errors.ts' },
  timestamp: now - 500,
}

// Error activity
const errorActivity: ActivityItem = {
  id: 'tool-error-1',
  type: 'tool',
  status: 'error',
  toolName: 'Bash',
  toolInput: { command: 'npm run deploy' },
  error: 'Permission denied',
  timestamp: now - 1000,
}

// Pending activities
const pendingActivity: ActivityItem = {
  id: 'tool-pending-1',
  type: 'tool',
  status: 'pending',
  toolName: 'Write',
  toolInput: { file_path: '/src/auth/new-handler.ts' },
  timestamp: now,
}

// Intermediate messages (LLM commentary between tool calls)
const intermediateMessage1: ActivityItem = {
  id: 'intermediate-1',
  type: 'intermediate',
  status: 'completed',
  content: "Let me search for the authentication handlers in your codebase...",
  timestamp: now - 6000,
}

const intermediateMessage2: ActivityItem = {
  id: 'intermediate-2',
  type: 'intermediate',
  status: 'completed',
  content: "Found some matches. Now let me read the main auth file to understand the implementation.",
  timestamp: now - 3500,
}

const intermediateMessage3: ActivityItem = {
  id: 'intermediate-3',
  type: 'intermediate',
  status: 'completed',
  content: "I see this uses OAuth 2.0. Let me also check how tokens are managed.",
  timestamp: now - 2500,
}

const intermediateMessageRunning: ActivityItem = {
  id: 'intermediate-running',
  type: 'intermediate',
  status: 'completed',
  content: "Let me run the tests to make sure everything works correctly...",
  timestamp: now - 1500,
}

const intermediateMessageStreaming: ActivityItem = {
  id: 'intermediate-streaming',
  type: 'intermediate',
  status: 'running',  // Still streaming - will show "Thinking..."
  content: "",  // Content not shown while streaming
  timestamp: now,
}

// Sample responses
const shortResponse: ResponseContent = {
  text: "I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation.",
  isStreaming: false,
}

const longResponse: ResponseContent = {
  text: `I've analyzed the authentication system and here's what I found:

## Authentication Architecture

The authentication system is built around three main components:

### 1. AuthHandler (\`src/auth/index.ts\`)
- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management

\`\`\`typescript
export class AuthHandler {
  async authenticate(credentials: Credentials): Promise<Session> {
    // OAuth flow implementation
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }
}
\`\`\`

### 2. TokenManager (\`src/auth/tokens.ts\`)
- Stores tokens securely using encryption
- Handles automatic token refresh before expiry
- Provides token revocation

### 3. SessionStore (\`src/auth/sessions.ts\`)
- Maintains active user sessions
- Handles session timeout and cleanup
- Provides session restoration on app restart

## Recommendations

1. **Add refresh token rotation** - Currently tokens are reused until expiry
2. **Implement PKCE** - For better security in public clients
3. **Add audit logging** - Track authentication events for security monitoring

Would you like me to implement any of these improvements?`,
  isStreaming: false,
}

const streamingResponse: ResponseContent = {
  text: "I'm analyzing the codebase and looking for",
  isStreaming: true,
  streamStartTime: now - 500,
}

const emptyStreamingResponse: ResponseContent = {
  text: '',
  isStreaming: true,
  streamStartTime: now,
}

// ============================================================================
// Helper: Generate many activities for stress testing
// ============================================================================

/** Tool names and file paths for realistic variety */
const toolVariety = [
  { tool: 'Read', getInput: (i: number) => ({ file_path: `/src/components/feature-${i}.tsx` }) },
  { tool: 'Grep', getInput: (i: number) => ({ pattern: `pattern${i}`, path: 'src/' }) },
  { tool: 'Glob', getInput: (i: number) => ({ pattern: `**/*${i}*.ts` }) },
  { tool: 'Bash', getInput: (i: number) => ({ command: `npm test -- file${i}` }) },
  { tool: 'Write', getInput: (i: number) => ({ file_path: `/src/utils/helper-${i}.ts` }) },
  { tool: 'Edit', getInput: (i: number) => ({ file_path: `/src/lib/module-${i}.ts` }) },
]

const commentaryVariety = [
  "Let me check this file for relevant code...",
  "I found some interesting patterns here.",
  "This looks like what we need.",
  "Searching for related implementations...",
  "Found a match, examining the details.",
  "This module handles the core logic.",
  "Let me verify this works correctly.",
  "Checking for any edge cases...",
]

/**
 * Generate a realistic sequence of activities with mixed tools and commentary.
 * Alternates between tool calls and intermediate messages for realism.
 */
function generateManyActivities(count: number): ActivityItem[] {
  const activities: ActivityItem[] = []
  let timestamp = now - (count * 100)

  for (let i = 0; i < count; i++) {
    // Every 3rd item is an intermediate message
    if (i % 3 === 0 && i > 0) {
      activities.push({
        id: `intermediate-${i}`,
        type: 'intermediate',
        status: 'completed',
        content: commentaryVariety[i % commentaryVariety.length],
        timestamp: timestamp,
      })
    } else {
      const toolInfo = toolVariety[i % toolVariety.length]
      activities.push({
        id: `tool-${i}`,
        type: 'tool',
        status: 'completed',
        toolName: toolInfo.tool,
        toolInput: toolInfo.getInput(i),
        timestamp: timestamp,
      })
    }
    timestamp += 100
  }

  return activities
}

/** Pre-generated 75 activities for playground */
const manyActivities75 = generateManyActivities(75)

// ============================================================================
// Sample Todos (for TodoWrite visualization)
// ============================================================================

/** Empty state - no todos */
const todosEmpty: TodoItem[] = []

/** All pending - just started planning */
const todosAllPending: TodoItem[] = [
  { content: 'Analyze authentication system', status: 'pending', activeForm: 'Analyzing authentication system' },
  { content: 'Implement token refresh logic', status: 'pending', activeForm: 'Implementing token refresh' },
  { content: 'Add unit tests for auth flow', status: 'pending', activeForm: 'Adding unit tests' },
  { content: 'Update API documentation', status: 'pending', activeForm: 'Updating documentation' },
]

/** In progress - currently working */
const todosInProgress: TodoItem[] = [
  { content: 'Analyze authentication system', status: 'completed', activeForm: 'Analyzing authentication system' },
  { content: 'Implement token refresh logic', status: 'in_progress', activeForm: 'Implementing token refresh' },
  { content: 'Add unit tests for auth flow', status: 'pending', activeForm: 'Adding unit tests' },
  { content: 'Update API documentation', status: 'pending', activeForm: 'Updating documentation' },
]

/** Mixed progress */
const todosMixed: TodoItem[] = [
  { content: 'Fix critical security bug', status: 'completed', activeForm: 'Fixing security bug' },
  { content: 'Implement OAuth 2.0 flow', status: 'in_progress', activeForm: 'Implementing OAuth flow' },
  { content: 'Add session timeout handling', status: 'pending', activeForm: 'Adding timeout handling' },
  { content: 'Improve error messages', status: 'pending', activeForm: 'Improving error messages' },
  { content: 'Add telemetry events', status: 'pending', activeForm: 'Adding telemetry' },
]

/** Almost done - 1 remaining */
const todosAlmostDone: TodoItem[] = [
  { content: 'Research authentication patterns', status: 'completed', activeForm: 'Researching patterns' },
  { content: 'Implement token validation', status: 'completed', activeForm: 'Implementing validation' },
  { content: 'Add refresh token rotation', status: 'completed', activeForm: 'Adding token rotation' },
  { content: 'Run test suite and verify', status: 'in_progress', activeForm: 'Running tests' },
]

/** All completed - task done */
const todosAllCompleted: TodoItem[] = [
  { content: 'Analyze current implementation', status: 'completed', activeForm: 'Analyzing implementation' },
  { content: 'Implement improvements', status: 'completed', activeForm: 'Implementing improvements' },
  { content: 'Add comprehensive tests', status: 'completed', activeForm: 'Adding tests' },
  { content: 'Update documentation', status: 'completed', activeForm: 'Updating docs' },
]

/** Long task list (stress test) */
const todosLong: TodoItem[] = [
  { content: 'Set up project structure', status: 'completed', activeForm: 'Setting up project' },
  { content: 'Configure build system', status: 'completed', activeForm: 'Configuring build' },
  { content: 'Install dependencies', status: 'completed', activeForm: 'Installing deps' },
  { content: 'Create database schema', status: 'completed', activeForm: 'Creating schema' },
  { content: 'Implement user model', status: 'completed', activeForm: 'Implementing model' },
  { content: 'Add authentication middleware', status: 'in_progress', activeForm: 'Adding auth middleware' },
  { content: 'Create API endpoints', status: 'pending', activeForm: 'Creating endpoints' },
  { content: 'Add input validation', status: 'pending', activeForm: 'Adding validation' },
  { content: 'Implement error handling', status: 'pending', activeForm: 'Implementing errors' },
  { content: 'Add rate limiting', status: 'pending', activeForm: 'Adding rate limits' },
  { content: 'Set up logging', status: 'pending', activeForm: 'Setting up logging' },
  { content: 'Write unit tests', status: 'pending', activeForm: 'Writing tests' },
]

// ============================================================================
// Component Entry
// ============================================================================

export const turnCardComponents: ComponentEntry[] = [
  {
    id: 'turn-card',
    name: 'TurnCard',
    category: 'Turn Cards',
    description: 'Email-like batched display for one assistant turn with activities and response',
    component: TurnCard,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'isStreaming',
        description: 'Whether content is still being received',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isComplete',
        description: 'Whether this turn is fully complete',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'defaultExpanded',
        description: 'Start with activities expanded',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'intent',
        description: 'Primary intent/goal for preview text',
        control: { type: 'string', placeholder: 'e.g., Searching for auth handlers...' },
        defaultValue: '',
      },
    ],
    variants: [
      // Initial / Empty state
      {
        name: 'Initial (Starting)',
        description: 'No activities yet, just starting',
        props: {
          activities: [],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Single tool running
      {
        name: 'Single Tool Running',
        description: 'One tool currently executing',
        props: {
          activities: [runningGrepActivity],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          intent: 'Finding error handling patterns',
        },
      },
      // Multiple tools running
      {
        name: 'Multiple Tools Running',
        description: 'Several tools executing in parallel',
        props: {
          activities: [
            { ...completedGrepActivity, status: 'completed' },
            runningReadActivity,
            pendingActivity,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // All tools completed (collapsed)
      {
        name: 'Tools Completed (Collapsed)',
        description: 'Multiple tools finished, collapsed by default',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: undefined,
          isStreaming: false,
          isComplete: false,
        },
      },
      // Tools completed, now streaming response
      {
        name: 'Streaming Response',
        description: 'Tools done, response is streaming',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          response: streamingResponse,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Waiting for response (empty streaming)
      {
        name: 'Waiting for Response',
        description: 'Tools done, waiting for response to start',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          response: emptyStreamingResponse,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Complete turn with short response
      {
        name: 'Complete (Short)',
        description: 'Finished turn with brief response',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Complete turn with long response
      {
        name: 'Complete (Long)',
        description: 'Finished turn with detailed response',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
            completedBashActivity,
          ],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          intent: 'Analyzing authentication system',
        },
      },
      // Error state
      {
        name: 'Error State',
        description: 'A tool failed during execution',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            errorActivity,
          ],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
        },
      },
      // Response only (no tools)
      {
        name: 'Response Only',
        description: 'Direct response without tool usage',
        props: {
          activities: [],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Many tools
      {
        name: 'Many Tools (5+)',
        description: 'Large number of completed tools',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
            completedBashActivity,
            { ...completedReadActivity1, id: 'tool-5', toolInput: { file_path: '/src/config.ts' } },
            { ...completedReadActivity1, id: 'tool-6', toolInput: { file_path: '/src/utils.ts' } },
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Extreme: 75 steps (real-world stress test)
      {
        name: 'Extreme: 75 Steps',
        description: 'Stress test with 75 activities - tests scrolling, animation limits, and performance',
        props: {
          activities: manyActivities75,
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          intent: 'Comprehensive codebase analysis',
        },
      },
      // Expanded by default
      {
        name: 'Expanded (Default)',
        description: 'Activities shown expanded initially',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: Tools with intermediate messages (completed)
      {
        name: 'Mixed: Tools + Commentary',
        description: 'Tools interleaved with LLM intermediate messages',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessage3,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: In progress with commentary
      {
        name: 'Mixed: In Progress',
        description: 'Tool running after intermediate message',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessageRunning,
            runningReadActivity,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Mixed: Many steps
      {
        name: 'Mixed: Long Chain',
        description: 'Extended conversation with multiple tool/message pairs',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessage3,
            completedReadActivity2,
            intermediateMessageRunning,
            completedBashActivity,
          ],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: Commentary only (no tools yet)
      {
        name: 'Mixed: Thinking Start',
        description: 'LLM thinking before first tool call',
        props: {
          activities: [
            intermediateMessage1,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Mixed: Currently thinking (streaming intermediate)
      {
        name: 'Mixed: Currently Thinking',
        description: 'LLM is streaming an intermediate message',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessageStreaming,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
        },
      },
      // ========== TodoWrite Variants ==========
      // Todo: Just started (all pending)
      {
        name: 'Todo: Just Started',
        description: 'TodoWrite with all items pending - just created the plan',
        props: {
          activities: [completedGrepActivity],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
          todos: todosAllPending,
        },
      },
      // Todo: In progress
      {
        name: 'Todo: In Progress',
        description: 'TodoWrite with one item in progress',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
          todos: todosInProgress,
        },
      },
      // Todo: Mixed progress
      {
        name: 'Todo: Mixed Progress',
        description: 'TodoWrite with mixed completed/in_progress/pending items',
        props: {
          activities: [completedGrepActivity, completedReadActivity1, completedBashActivity],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosMixed,
        },
      },
      // Todo: Almost done
      {
        name: 'Todo: Almost Done',
        description: 'TodoWrite with most items completed, one in progress',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
          todos: todosAlmostDone,
        },
      },
      // Todo: All completed
      {
        name: 'Todo: All Completed',
        description: 'TodoWrite with all items done - task complete',
        props: {
          activities: [completedGrepActivity, completedReadActivity1, completedBashActivity],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosAllCompleted,
        },
      },
      // Todo: Long list (stress test)
      {
        name: 'Todo: Long List (12 items)',
        description: 'TodoWrite stress test with many items',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosLong,
        },
      },
      // Todo: Only (no activities/response)
      {
        name: 'Todo: Standalone',
        description: 'TodoWrite without activities or response - planning phase only',
        props: {
          activities: [],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
          todos: todosMixed,
        },
      },
    ],
    mockData: () => ({
      activities: [
        completedGrepActivity,
        completedReadActivity1,
        completedReadActivity2,
      ],
      response: shortResponse,
      onOpenFile: (path: string) => console.log('[Playground] Open file:', path),
      onOpenUrl: (url: string) => console.log('[Playground] Open URL:', url),
    }),
  },
  // Streaming Simulation - Live demo of streaming response
  {
    id: 'turn-card-streaming-sim',
    name: 'TurnCard (Streaming Sim)',
    category: 'Turn Cards',
    description: 'Live simulation of document-style streaming preview with batched fade-in updates',
    component: StreamingSimulationTurnCard,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'simulationSpeed',
        description: 'How fast to simulate streaming',
        control: {
          type: 'select',
          options: [
            { label: 'Slow', value: 'slow' },
            { label: 'Normal', value: 'normal' },
            { label: 'Fast', value: 'fast' },
          ],
        },
        defaultValue: 'normal',
      },
      {
        name: 'intent',
        description: 'Intent text shown in header',
        control: { type: 'string', placeholder: 'e.g., Analyzing auth system...' },
        defaultValue: 'Analyzing the authentication system',
      },
    ],
    variants: [
      {
        name: 'Response Only (Slow)',
        description: 'Document preview with gradient and toggle - slow to observe cross-fade',
        props: {
          activities: [],
          simulationSpeed: 'slow',
        },
      },
      {
        name: 'After Tools (Normal)',
        description: 'Shows last few lines in large card with batched updates',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          simulationSpeed: 'normal',
          intent: 'Analyzing authentication handlers',
        },
      },
      {
        name: 'Long Content (Slow)',
        description: 'Best for observing gradient at top and cross-fade effect',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          simulationSpeed: 'slow',
        },
      },
      {
        name: 'After Mixed (Fast)',
        description: 'Fast streaming after tools + commentary',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
          ],
          simulationSpeed: 'fast',
          intent: 'Searching for patterns',
        },
      },
    ],
    mockData: () => ({
      activities: [
        completedGrepActivity,
        completedReadActivity1,
      ],
    }),
  },
]

// ============================================================================
// Fullscreen Overlay Components
// ============================================================================

/** Sample markdown content for fullscreen testing */
const sampleMarkdownContent = `# Authentication System Analysis

I've completed my analysis of the authentication system. Here's what I found:

## Overview

The authentication system is built around three main components that work together to provide secure user authentication.

### 1. AuthHandler (\`src/auth/index.ts\`)

This is the main entry point for all authentication operations:

- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management
- Supports multiple identity providers (Google, GitHub, Microsoft)

\`\`\`typescript
export class AuthHandler {
  private oauth: OAuthClient;
  private tokenManager: TokenManager;
  private sessionStore: SessionStore;

  async authenticate(credentials: Credentials): Promise<Session> {
    // Validate credentials format
    this.validateCredentials(credentials);

    // Get OAuth token from provider
    const token = await this.oauth.getToken(credentials);

    // Create and store session
    return this.createSession(token);
  }

  async refreshToken(session: Session): Promise<Session> {
    const newToken = await this.oauth.refresh(session.refreshToken);
    return this.updateSession(session.id, newToken);
  }
}
\`\`\`

### 2. TokenManager (\`src/auth/tokens.ts\`)

Handles secure token storage and lifecycle:

- Stores tokens securely using AES-256 encryption
- Handles automatic token refresh before expiry (5 minute buffer)
- Provides token revocation and cleanup
- Supports both access tokens and refresh tokens

### 3. SessionStore (\`src/auth/sessions.ts\`)

Maintains active user sessions with the following features:

- In-memory session cache for fast lookups
- Persistent storage backed by Redis
- Automatic session timeout and cleanup
- Session restoration on app restart

## Security Considerations

The current implementation has several security strengths:

1. **Token encryption** - All tokens are encrypted at rest
2. **Short-lived tokens** - Access tokens expire in 15 minutes
3. **Secure refresh** - Refresh tokens are rotated on each use
4. **Session binding** - Sessions are bound to device fingerprint

However, I noticed a few areas that could be improved:

- **PKCE support** - Not currently implemented for public clients
- **Rate limiting** - Auth endpoints lack rate limiting
- **Audit logging** - Authentication events aren't logged

## Recommendations

Based on my analysis, here are my recommendations:

1. **Implement PKCE** for all OAuth flows to prevent authorization code interception
2. **Add rate limiting** to prevent brute force attacks (suggest: 5 attempts per minute)
3. **Enable audit logging** for security monitoring and compliance
4. **Add MFA support** for sensitive operations

Would you like me to implement any of these improvements?`

/** Plan-style content for testing plan variant */
const samplePlanContent = `# Implement Authentication Improvements

## Summary

This plan outlines the implementation of security improvements to the authentication system based on the analysis findings.

## Steps

### 1. Implement PKCE Support

Add PKCE (Proof Key for Code Exchange) to all OAuth flows:

- Generate code verifier and challenge on auth start
- Include code_challenge in authorization request
- Verify code_verifier on token exchange

**Files to modify:**
- \`src/auth/oauth.ts\`
- \`src/auth/index.ts\`

### 2. Add Rate Limiting

Implement rate limiting on authentication endpoints:

- Configure limits: 5 attempts per minute per IP
- Use sliding window algorithm
- Add Redis-backed rate limiter

**New files:**
- \`src/middleware/rate-limiter.ts\`

### 3. Enable Audit Logging

Add comprehensive audit logging for auth events:

- Log successful/failed login attempts
- Track token refresh and revocation
- Include metadata (IP, user agent, timestamp)

**Files to modify:**
- \`src/auth/index.ts\`
- \`src/lib/logger.ts\`

### 4. Add MFA Support

Implement multi-factor authentication:

- Support TOTP (Google Authenticator, Authy)
- Add SMS fallback option
- Implement backup codes

**New files:**
- \`src/auth/mfa.ts\`
- \`src/auth/totp.ts\`

## Testing

After implementation, we'll need to:

1. Update existing auth tests
2. Add PKCE verification tests
3. Add rate limiting tests
4. Add MFA enrollment/verification tests

## Timeline

Estimated completion: 3-4 days`

/** Wrapper that provides controlled open state for playground */
function DocumentFormattedMarkdownOverlayPlayground({
  content,
  variant,
}: {
  content: string
  variant?: 'response' | 'plan'
}) {
  const [isOpen, setIsOpen] = useState(true)

  return (
    <div className="p-8">
      <button
        onClick={() => setIsOpen(true)}
        className="px-4 py-2 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:bg-accent/90"
      >
        Open Document Overlay
      </button>
      <DocumentFormattedMarkdownOverlay
        content={content}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        variant={variant}
        onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
        onOpenFile={(path) => console.log('[Playground] Open file:', path)}
      />
    </div>
  )
}

// ============================================================================
// Code Preview Overlay - Playground Wrapper
// ============================================================================

const sampleTypeScriptCode = `import { useState, useEffect, useCallback } from 'react'
import type { Session, AuthToken } from '../types'
import { encryptToken, decryptToken } from '../lib/crypto'

/**
 * TokenManager - Handles secure token storage and lifecycle
 *
 * Features:
 * - AES-256 encryption for token storage
 * - Automatic refresh before expiry (5 min buffer)
 * - Token revocation and cleanup
 */
export class TokenManager {
  private readonly encryptionKey: CryptoKey
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map()

  constructor(private readonly storage: TokenStorage) {
    this.encryptionKey = this.deriveKey()
  }

  /**
   * Store a new token pair securely.
   * Encrypts both access and refresh tokens before persisting.
   */
  async storeToken(sessionId: string, token: AuthToken): Promise<void> {
    const encrypted = await encryptToken(token, this.encryptionKey)
    await this.storage.set(sessionId, encrypted)

    // Schedule refresh before expiry
    this.scheduleRefresh(sessionId, token.expiresIn)
  }

  /**
   * Retrieve and decrypt a stored token.
   * Returns null if token doesn't exist or decryption fails.
   */
  async getToken(sessionId: string): Promise<AuthToken | null> {
    const encrypted = await this.storage.get(sessionId)
    if (!encrypted) return null

    try {
      return await decryptToken(encrypted, this.encryptionKey)
    } catch (error) {
      console.error('[TokenManager] Decryption failed:', error)
      await this.revokeToken(sessionId)
      return null
    }
  }

  /**
   * Revoke a token and clean up associated resources.
   */
  async revokeToken(sessionId: string): Promise<void> {
    const timer = this.refreshTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.refreshTimers.delete(sessionId)
    }
    await this.storage.delete(sessionId)
  }

  private scheduleRefresh(sessionId: string, expiresIn: number): void {
    // Refresh 5 minutes before expiry
    const refreshIn = Math.max(0, (expiresIn - 300) * 1000)
    const timer = setTimeout(() => this.refreshToken(sessionId), refreshIn)
    this.refreshTimers.set(sessionId, timer)
  }

  private async refreshToken(sessionId: string): Promise<void> {
    const token = await this.getToken(sessionId)
    if (!token?.refreshToken) return

    try {
      const newToken = await this.oauth.refresh(token.refreshToken)
      await this.storeToken(sessionId, newToken)
    } catch (error) {
      console.error('[TokenManager] Refresh failed:', error)
      await this.revokeToken(sessionId)
    }
  }

  private deriveKey(): CryptoKey {
    // Key derivation from environment secret
    return crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(process.env.TOKEN_SECRET),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    ) as unknown as CryptoKey
  }
}

interface TokenStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
`

const samplePythonCode = `"""
Machine Learning Pipeline - Data preprocessing and model training

This module provides a complete ML pipeline for classification tasks,
including data loading, preprocessing, training, and evaluation.
"""

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.metrics import classification_report, confusion_matrix
from typing import Optional, Tuple, Dict, Any
import logging

logger = logging.getLogger(__name__)


class MLPipeline:
    """End-to-end machine learning pipeline for classification."""

    def __init__(self, random_state: int = 42):
        self.random_state = random_state
        self.scaler = StandardScaler()
        self.label_encoder = LabelEncoder()
        self.model: Optional[Any] = None
        self._is_fitted = False

    def load_data(self, filepath: str) -> pd.DataFrame:
        """Load dataset from CSV with basic validation."""
        logger.info(f"Loading data from {filepath}")
        df = pd.read_csv(filepath)

        if df.empty:
            raise ValueError(f"Empty dataset: {filepath}")

        logger.info(f"Loaded {len(df)} rows, {len(df.columns)} columns")
        return df

    def preprocess(
        self,
        df: pd.DataFrame,
        target_col: str,
        drop_cols: Optional[list] = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Preprocess data: encode labels, scale features, handle missing values."""
        if drop_cols:
            df = df.drop(columns=drop_cols, errors='ignore')

        # Handle missing values
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        df[numeric_cols] = df[numeric_cols].fillna(df[numeric_cols].median())

        # Encode target
        y = self.label_encoder.fit_transform(df[target_col])

        # Scale features
        X = df.drop(columns=[target_col])
        X = pd.get_dummies(X, drop_first=True)  # One-hot encode categoricals
        X_scaled = self.scaler.fit_transform(X)

        return X_scaled, y

    def train(
        self,
        X: np.ndarray,
        y: np.ndarray,
        model_type: str = "random_forest",
        **kwargs: Dict[str, Any],
    ) -> Dict[str, float]:
        """Train model and return cross-validation scores."""
        if model_type == "random_forest":
            self.model = RandomForestClassifier(
                random_state=self.random_state, **kwargs
            )
        elif model_type == "gradient_boosting":
            self.model = GradientBoostingClassifier(
                random_state=self.random_state, **kwargs
            )
        else:
            raise ValueError(f"Unknown model type: {model_type}")

        # Cross-validation
        scores = cross_val_score(self.model, X, y, cv=5, scoring="accuracy")
        logger.info(f"CV Accuracy: {scores.mean():.4f} (+/- {scores.std():.4f})")

        # Fit on full training data
        self.model.fit(X, y)
        self._is_fitted = True

        return {"mean_accuracy": scores.mean(), "std_accuracy": scores.std()}
`

/** Embedded preview of CodePreviewOverlay */
function CodePreviewOverlayPlayground({
  content,
  filePath,
  mode,
  startLine,
  totalLines,
  numLines,
  error,
}: {
  content: string
  filePath: string
  mode?: 'read' | 'write'
  startLine?: number
  totalLines?: number
  numLines?: number
  error?: string
}) {
  return (
    <div className="h-[500px]">
      <CodePreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        content={content}
        filePath={filePath}
        mode={mode}
        startLine={startLine}
        totalLines={totalLines}
        numLines={numLines}
        error={error}
      />
    </div>
  )
}

// ============================================================================
// Multi-Diff Preview Overlay - Playground Wrapper
// ============================================================================

const sampleMultiDiffChanges: FileChange[] = [
  {
    id: 'change-1',
    filePath: '/src/auth/index.ts',
    toolType: 'Edit',
    original: `  async authenticate(credentials: Credentials): Promise<Session> {
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }`,
    modified: `  async authenticate(credentials: Credentials): Promise<Session> {
    // Validate credentials before attempting OAuth flow
    this.validateCredentials(credentials);

    // Generate PKCE challenge for security
    const { verifier, challenge } = await generatePKCE();

    const token = await this.oauth.getToken(credentials, {
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    // Store verifier for token exchange verification
    await this.storeVerifier(token.authCode, verifier);

    return this.createSession(token);
  }`,
  },
  {
    id: 'change-2',
    filePath: '/src/auth/oauth.ts',
    toolType: 'Edit',
    original: `export interface OAuthOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
}`,
    modified: `export interface OAuthOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** PKCE code challenge for authorization request */
  codeChallenge?: string;
  /** PKCE challenge method (always S256) */
  codeChallengeMethod?: 'S256' | 'plain';
}`,
  },
  {
    id: 'change-3',
    filePath: '/src/middleware/rate-limiter.ts',
    toolType: 'Write',
    original: '',
    modified: `import { Redis } from 'ioredis'

/**
 * Sliding window rate limiter using Redis.
 * Limits authentication attempts to prevent brute force attacks.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly windowMs: number = 60000,
    private readonly maxAttempts: number = 5,
  ) {}

  async isAllowed(key: string): Promise<boolean> {
    const now = Date.now()
    const windowStart = now - this.windowMs

    // Remove expired entries and count remaining
    await this.redis.zremrangebyscore(key, 0, windowStart)
    const count = await this.redis.zcard(key)

    if (count >= this.maxAttempts) {
      return false
    }

    // Add current attempt
    await this.redis.zadd(key, now, \`\${now}\`)
    await this.redis.expire(key, Math.ceil(this.windowMs / 1000))

    return true
  }
}
`,
  },
  {
    id: 'change-4',
    filePath: '/src/auth/index.ts',
    toolType: 'Edit',
    original: `import { OAuthClient } from './oauth'
import { TokenManager } from './tokens'`,
    modified: `import { OAuthClient } from './oauth'
import { TokenManager } from './tokens'
import { RateLimiter } from '../middleware/rate-limiter'
import { AuditLogger } from '../lib/audit'`,
  },
]

const sampleSingleChange: FileChange[] = [
  {
    id: 'single-1',
    filePath: '/src/components/Button.tsx',
    toolType: 'Edit',
    original: `export function Button({ children, onClick }: ButtonProps) {
  return (
    <button onClick={onClick} className="btn">
      {children}
    </button>
  )
}`,
    modified: `export function Button({ children, onClick, variant = 'primary', disabled }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn('btn', \`btn-\${variant}\`, disabled && 'btn-disabled')}
    >
      {children}
    </button>
  )
}`,
  },
]

/** Embedded preview of MultiDiffPreviewOverlay */
function MultiDiffPreviewOverlayPlayground({
  changes,
  consolidated,
  focusedChangeId,
}: {
  changes: FileChange[]
  consolidated?: boolean
  focusedChangeId?: string
}) {
  return (
    <div className="h-[500px]">
      <MultiDiffPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        changes={changes}
        consolidated={consolidated}
        focusedChangeId={focusedChangeId}
      />
    </div>
  )
}

// ============================================================================
// Terminal Preview Overlay - Playground Wrapper
// ============================================================================

const sampleBashOutput = `> npm test

 PASS  src/auth/__tests__/handler.test.ts (2.341s)
  AuthHandler
    ✓ should authenticate with valid credentials (45ms)
    ✓ should reject invalid credentials (12ms)
    ✓ should refresh expired tokens (23ms)
    ✓ should handle token revocation (8ms)
    ✓ should validate PKCE challenge (15ms)

 PASS  src/auth/__tests__/tokens.test.ts (1.892s)
  TokenManager
    ✓ should encrypt tokens at rest (34ms)
    ✓ should decrypt stored tokens (28ms)
    ✓ should schedule automatic refresh (5ms)
    ✓ should handle decryption failures gracefully (11ms)
    ✓ should revoke tokens and cleanup timers (7ms)

 PASS  src/middleware/__tests__/rate-limiter.test.ts (0.956s)
  RateLimiter
    ✓ should allow requests under limit (3ms)
    ✓ should block requests over limit (4ms)
    ✓ should reset after window expires (102ms)

Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        5.412s
Ran all test suites.`

const sampleGrepOutput = `src/auth/index.ts:15:export class AuthHandler {
src/auth/index.ts:42:  async authenticate(credentials: Credentials): Promise<Session> {
src/auth/index.ts:67:  async refreshToken(session: Session): Promise<Session> {
src/auth/oauth.ts:8:export class OAuthClient {
src/auth/oauth.ts:23:  async getToken(credentials: Credentials): Promise<AuthToken> {
src/auth/tokens.ts:12:export class TokenManager {
src/auth/tokens.ts:34:  async storeToken(sessionId: string, token: AuthToken): Promise<void> {
src/auth/tokens.ts:52:  async getToken(sessionId: string): Promise<AuthToken | null> {
src/middleware/rate-limiter.ts:9:export class RateLimiter {
src/middleware/rate-limiter.ts:18:  async isAllowed(key: string): Promise<boolean> {`

const sampleGlobOutput = `src/auth/index.ts
src/auth/oauth.ts
src/auth/tokens.ts
src/auth/sessions.ts
src/auth/types.ts
src/auth/__tests__/handler.test.ts
src/auth/__tests__/tokens.test.ts
src/auth/__tests__/sessions.test.ts
src/auth/mfa.ts
src/auth/totp.ts`

const sampleBashErrorOutput = `> npm run deploy

Error: Command failed with exit code 1
  at ChildProcess.exithandler (node:child_process:420:12)
  at ChildProcess.emit (node:events:519:28)

npm ERR! code ELIFECYCLE
npm ERR! errno 1
npm ERR! myapp@1.0.0 deploy: \`aws s3 sync ./dist s3://my-bucket\`
npm ERR! Exit status 1
npm ERR!
npm ERR! Failed at the myapp@1.0.0 deploy script.

An error occurred during deployment. Check your AWS credentials and permissions.`

/** Embedded preview of TerminalPreviewOverlay */
function TerminalPreviewOverlayPlayground({
  command,
  output,
  exitCode,
  toolType,
  description,
  error,
}: {
  command: string
  output: string
  exitCode?: number
  toolType?: 'bash' | 'grep' | 'glob'
  description?: string
  error?: string
}) {
  return (
    <div className="h-[500px]">
      <TerminalPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        command={command}
        output={output}
        exitCode={exitCode}
        toolType={toolType}
        description={description}
        error={error}
      />
    </div>
  )
}

// ============================================================================
// JSON Preview Overlay - Playground Wrapper
// ============================================================================

const sampleJsonData = {
  user: {
    id: 'usr_2x8kM9pQ',
    name: 'Jane Developer',
    email: 'jane@example.com',
    role: 'admin',
    permissions: ['read', 'write', 'delete', 'manage_users'],
    metadata: {
      created_at: '2024-01-15T10:30:00Z',
      last_login: '2025-01-24T14:22:00Z',
      login_count: 342,
      preferences: {
        theme: 'dark',
        language: 'en',
        notifications: {
          email: true,
          push: false,
          slack: true,
        },
      },
    },
  },
  organization: {
    id: 'org_4k2nR7wL',
    name: 'Acme Corp',
    plan: 'enterprise',
    members_count: 47,
    features: ['sso', 'audit_logs', 'custom_roles', 'api_access'],
    billing: {
      plan: 'enterprise',
      status: 'active',
      next_invoice: '2025-02-01',
      amount: 4999,
      currency: 'USD',
    },
  },
  api_keys: [
    { id: 'key_1', name: 'Production', prefix: 'sk_live_...', created: '2024-06-01' },
    { id: 'key_2', name: 'Staging', prefix: 'sk_test_...', created: '2024-08-15' },
    { id: 'key_3', name: 'Development', prefix: 'sk_dev_...', created: '2025-01-10' },
  ],
}

const sampleNestedJsonData = {
  status: 'success',
  data: {
    results: [
      { id: 1, title: 'First Result', score: 0.95, tags: ['important', 'reviewed'] },
      { id: 2, title: 'Second Result', score: 0.87, tags: ['pending'] },
      { id: 3, title: 'Third Result', score: 0.72, tags: ['archived'] },
    ],
    pagination: { page: 1, per_page: 10, total: 3, total_pages: 1 },
    meta: { request_id: 'req_abc123', duration_ms: 42, cache_hit: false },
  },
}

/** Embedded preview of JSONPreviewOverlay */
function JSONPreviewOverlayPlayground({
  data,
  title,
  error,
}: {
  data: unknown
  title?: string
  error?: string
}) {
  return (
    <div className="h-[500px]">
      <JSONPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        data={data}
        title={title}
        error={error}
      />
    </div>
  )
}

// ============================================================================
// Generic Overlay - Playground Wrapper
// ============================================================================

const sampleGenericContent = `# WebFetch Result

Fetched content from https://docs.example.com/api/authentication

## Authentication

All API requests require authentication using a Bearer token in the Authorization header:

\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

### Rate Limits

| Plan       | Requests/min | Burst |
|-----------|-------------|-------|
| Free       | 60          | 10    |
| Pro        | 600         | 100   |
| Enterprise | 6000        | 1000  |

### Error Responses

When authentication fails, the API returns:

\`\`\`json
{
  "error": {
    "code": "unauthorized",
    "message": "Invalid or expired API key",
    "status": 401
  }
}
\`\`\`

For more details, see the [API Reference](https://docs.example.com/api).`

/** Embedded preview of GenericOverlay */
function GenericOverlayPlayground({
  content,
  title,
}: {
  content: string
  title?: string
}) {
  return (
    <div className="h-[500px]">
      <GenericOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        content={content}
        title={title}
      />
    </div>
  )
}

// ============================================================================
// Data Table Overlay - Playground Wrapper
// ============================================================================

/** Sample table component rendered inside DataTableOverlay */
function SampleDataTable() {
  const rows = [
    { tool: 'Read', permission: 'allowed', description: 'Read files from disk' },
    { tool: 'Write', permission: 'ask', description: 'Write files to disk' },
    { tool: 'Edit', permission: 'ask', description: 'Edit existing files' },
    { tool: 'Bash', permission: 'ask', description: 'Execute shell commands' },
    { tool: 'Grep', permission: 'allowed', description: 'Search file contents' },
    { tool: 'Glob', permission: 'allowed', description: 'Find files by pattern' },
    { tool: 'WebFetch', permission: 'allowed', description: 'Fetch URL content' },
    { tool: 'WebSearch', permission: 'blocked', description: 'Search the web' },
  ]

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">Tool</th>
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">Permission</th>
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.tool} className="border-b border-border/50">
            <td className="py-2 px-4 font-mono text-xs">{row.tool}</td>
            <td className="py-2 px-4">
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                row.permission === 'allowed' ? 'bg-green-500/10 text-green-600' :
                row.permission === 'ask' ? 'bg-amber-500/10 text-amber-600' :
                'bg-red-500/10 text-red-600'
              }`}>
                {row.permission}
              </span>
            </td>
            <td className="py-2 px-4 text-muted-foreground">{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Wrapper with button to open DataTableOverlay */
function DataTableOverlayPlayground({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}) {
  const [isOpen, setIsOpen] = useState(true)

  return (
    <div className="p-8">
      <button
        onClick={() => setIsOpen(true)}
        className="px-4 py-2 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:bg-accent/90"
      >
        Open Data Table
      </button>
      <DataTableOverlay
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={title}
        subtitle={subtitle}
      >
        <SampleDataTable />
      </DataTableOverlay>
    </div>
  )
}

// ============================================================================
// Fullscreen Overlay Component Registry
// ============================================================================

/** Export all fullscreen overlay components */
export const fullscreenOverlayComponents: ComponentEntry[] = [
  {
    id: 'document-overlay',
    name: 'DocumentFormattedMarkdownOverlay',
    category: 'Fullscreen',
    description: 'Fullscreen document view for reading AI responses and plans',
    component: DocumentFormattedMarkdownOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'variant',
        description: 'Style variant: response (default) or plan (shows header)',
        control: {
          type: 'select',
          options: [
            { label: 'Response', value: 'response' },
            { label: 'Plan', value: 'plan' },
          ],
        },
        defaultValue: 'response',
      },
    ],
    variants: [
      {
        name: 'Response (Default)',
        description: 'Standard response view with commenting support',
        props: {
          content: sampleMarkdownContent,
          variant: 'response',
        },
      },
      {
        name: 'Plan Variant',
        description: 'Plan view with green header badge',
        props: {
          content: samplePlanContent,
          variant: 'plan',
        },
      },
      {
        name: 'Short Content',
        description: 'Minimal content to test layout',
        props: {
          content: '# Quick Response\n\nThis is a short response to test the layout with minimal content.\n\nLooks good!',
          variant: 'response',
        },
      },
      {
        name: 'Code Heavy',
        description: 'Content with lots of code blocks',
        props: {
          content: `# Code Examples

Here are some code examples:

\`\`\`typescript
// TypeScript example
interface User {
  id: string;
  name: string;
  email: string;
}

async function getUser(id: string): Promise<User> {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}
\`\`\`

\`\`\`python
# Python example
def fibonacci(n: int) -> int:
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)
\`\`\`

\`\`\`rust
// Rust example
fn main() {
    let numbers: Vec<i32> = (1..=10).collect();
    let sum: i32 = numbers.iter().sum();
    println!("Sum: {}", sum);
}
\`\`\`

These examples demonstrate different syntax highlighting.`,
          variant: 'response',
        },
      },
    ],
    mockData: () => ({
      content: sampleMarkdownContent,
    }),
  },

  // Code Preview Overlay
  {
    id: 'code-preview-overlay',
    name: 'CodePreviewOverlay',
    category: 'Fullscreen',
    description: 'Syntax-highlighted code file preview (Read/Write tools)',
    component: CodePreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'mode',
        description: 'Display mode: read or write',
        control: {
          type: 'select',
          options: [
            { label: 'Read', value: 'read' },
            { label: 'Write', value: 'write' },
          ],
        },
        defaultValue: 'read',
      },
    ],
    variants: [
      {
        name: 'TypeScript File (Read)',
        description: 'Reading a TypeScript source file',
        props: {
          content: sampleTypeScriptCode,
          filePath: '/src/auth/tokens.ts',
          mode: 'read',
          startLine: 1,
          totalLines: 98,
          numLines: 98,
        },
      },
      {
        name: 'Python File (Read)',
        description: 'Reading a Python ML pipeline',
        props: {
          content: samplePythonCode,
          filePath: '/src/ml/pipeline.py',
          mode: 'read',
          startLine: 1,
          totalLines: 85,
          numLines: 85,
        },
      },
      {
        name: 'Partial Read (Lines 15-45)',
        description: 'Reading a subset of lines from a large file',
        props: {
          content: sampleTypeScriptCode.split('\n').slice(14, 45).join('\n'),
          filePath: '/src/auth/tokens.ts',
          mode: 'read',
          startLine: 15,
          totalLines: 98,
          numLines: 31,
        },
      },
      {
        name: 'Write Mode',
        description: 'Showing a file being written',
        props: {
          content: sampleTypeScriptCode,
          filePath: '/src/auth/tokens.ts',
          mode: 'write',
        },
      },
      {
        name: 'Read Failed',
        description: 'Error state when file read fails',
        props: {
          content: '',
          filePath: './apps/electron/src/main/sessions.ts',
          mode: 'read',
          error: "Bash command `python3 -c import re; f=open('./node_modules/@qwen-code/qwen-code/dist/cli.js','r'); content=f.read(); f.close(); [print(m.group(),'---') for m in list(re.finditer(r'.{0,150}AbortError.{0,150}', content))[:5]]` is not in the read-only allowlist.\n\nMatched: `python3 -` (9 chars)\nFailed at: `c` (position 9)\n\nPattern: Python 3 version",
        },
      },
    ],
    mockData: () => ({
      content: sampleTypeScriptCode,
      filePath: '/src/auth/tokens.ts',
    }),
  },

  // Multi-Diff Preview Overlay
  {
    id: 'multi-diff-overlay',
    name: 'MultiDiffPreviewOverlay',
    category: 'Fullscreen',
    description: 'Multi-file diff preview with sidebar navigation (Edit/Write tools)',
    component: MultiDiffPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'consolidated',
        description: 'Group changes by file path',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Multiple Files (Ungrouped)',
        description: 'Several file changes shown individually',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: false,
        },
      },
      {
        name: 'Multiple Files (Consolidated)',
        description: 'Changes grouped by file path',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: true,
        },
      },
      {
        name: 'Single Edit',
        description: 'Single file change (no sidebar)',
        props: {
          changes: sampleSingleChange,
          consolidated: false,
        },
      },
      {
        name: 'Focused Change',
        description: 'Opens with a specific change focused',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: false,
          focusedChangeId: 'change-3',
        },
      },
      {
        name: 'New File (Write)',
        description: 'A newly written file (no original)',
        props: {
          changes: [sampleMultiDiffChanges[2]], // The rate-limiter Write
          consolidated: false,
        },
      },
    ],
    mockData: () => ({
      changes: sampleMultiDiffChanges,
    }),
  },

  // Terminal Preview Overlay
  {
    id: 'terminal-preview-overlay',
    name: 'TerminalPreviewOverlay',
    category: 'Fullscreen',
    description: 'Terminal output preview (Bash/Grep/Glob tools)',
    component: TerminalPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'toolType',
        description: 'Tool type for display styling',
        control: {
          type: 'select',
          options: [
            { label: 'Bash', value: 'bash' },
            { label: 'Grep', value: 'grep' },
            { label: 'Glob', value: 'glob' },
          ],
        },
        defaultValue: 'bash',
      },
    ],
    variants: [
      {
        name: 'Bash: Test Suite',
        description: 'npm test output with passing tests',
        props: {
          command: 'npm test',
          output: sampleBashOutput,
          exitCode: 0,
          toolType: 'bash',
          description: 'Running the test suite',
        },
      },
      {
        name: 'Bash: Error',
        description: 'Failed deployment command',
        props: {
          command: 'npm run deploy',
          output: sampleBashErrorOutput,
          exitCode: 1,
          toolType: 'bash',
          description: 'Deploy to production',
        },
      },
      {
        name: 'Grep: Search Results',
        description: 'Searching for class/function definitions',
        props: {
          command: 'grep "export class" src/auth/',
          output: sampleGrepOutput,
          exitCode: 0,
          toolType: 'grep',
          description: 'Search for "export class" in src/auth/',
        },
      },
      {
        name: 'Glob: File Listing',
        description: 'Finding files matching a pattern',
        props: {
          command: 'glob "src/auth/**/*.ts"',
          output: sampleGlobOutput,
          exitCode: 0,
          toolType: 'glob',
          description: 'Find files matching "src/auth/**/*.ts"',
        },
      },
      {
        name: 'Command Failed (Error Banner)',
        description: 'Command blocked by permission system',
        props: {
          command: 'rm -rf /tmp/build-cache',
          output: '',
          exitCode: 1,
          toolType: 'bash',
          description: 'Clean build cache',
          error: "Bash command `rm -rf /tmp/build-cache` is not in the read-only allowlist.\n\nMatched: `rm` (2 chars)\nFailed at: ` ` (position 2)\n\nPattern: Remove files\n\nSwitch to Ask before edits, Edit automatically, or YOLO (SHIFT+TAB) to run it.",
        },
      },
    ],
    mockData: () => ({
      command: 'npm test',
      output: sampleBashOutput,
      exitCode: 0,
      toolType: 'bash',
      description: 'Running tests',
    }),
  },

  // JSON Preview Overlay
  {
    id: 'json-preview-overlay',
    name: 'JSONPreviewOverlay',
    category: 'Fullscreen',
    description: 'Interactive JSON tree viewer with expand/collapse',
    component: JSONPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Title shown in header',
        control: { type: 'string', placeholder: 'e.g., API Response' },
        defaultValue: 'JSON Result',
      },
    ],
    variants: [
      {
        name: 'Complex Object',
        description: 'Deeply nested user/org data',
        props: {
          data: sampleJsonData,
          title: 'User Profile',
        },
      },
      {
        name: 'API Response',
        description: 'Typical paginated API response',
        props: {
          data: sampleNestedJsonData,
          title: 'Search Results',
        },
      },
      {
        name: 'Simple Array',
        description: 'Array of simple objects',
        props: {
          data: [
            { id: 1, name: 'Alpha', status: 'active' },
            { id: 2, name: 'Beta', status: 'pending' },
            { id: 3, name: 'Gamma', status: 'inactive' },
          ],
          title: 'Items List',
        },
      },
      {
        name: 'Minimal',
        description: 'Small JSON payload',
        props: {
          data: { success: true, message: 'Operation completed', count: 42 },
          title: 'Status',
        },
      },
      {
        name: 'Parse Error',
        description: 'Error state when JSON parsing fails',
        props: {
          data: {},
          title: 'API Response',
          error: "Unexpected token '<' at position 0. The server returned HTML instead of JSON.\n\nResponse starts with: <!DOCTYPE html><html><head><title>502 Bad Gateway</title>...",
        },
      },
    ],
    mockData: () => ({
      data: sampleJsonData,
      title: 'JSON Result',
    }),
  },

  // Generic Overlay
  {
    id: 'generic-overlay',
    name: 'GenericOverlay',
    category: 'Fullscreen',
    description: 'Fallback overlay for unknown tool content with auto-language detection',
    component: GenericOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Header title',
        control: { type: 'string', placeholder: 'e.g., WebFetch Result' },
        defaultValue: 'Activity',
      },
    ],
    variants: [
      {
        name: 'Markdown Content',
        description: 'Web-fetched documentation',
        props: {
          content: sampleGenericContent,
          title: 'WebFetch Result',
        },
      },
      {
        name: 'Plain Text',
        description: 'Simple text output',
        props: {
          content: 'Build completed successfully.\n\nOutput:\n  dist/index.js (245 KB)\n  dist/index.css (12 KB)\n  dist/assets/ (3 files)\n\nTotal size: 257 KB (gzipped: 62 KB)',
          title: 'Build Output',
        },
      },
      {
        name: 'JSON-like Content',
        description: 'Content that looks like JSON',
        props: {
          content: JSON.stringify({ status: 'ok', version: '2.1.0', uptime: '14d 3h 22m' }, null, 2),
          title: 'Health Check',
        },
      },
    ],
    mockData: () => ({
      content: sampleGenericContent,
      title: 'Activity',
    }),
  },

  // Data Table Overlay
  {
    id: 'data-table-overlay',
    name: 'DataTableOverlay',
    category: 'Fullscreen',
    description: 'Fullscreen data table view with scrollable content',
    component: DataTableOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Table title in header',
        control: { type: 'string', placeholder: 'e.g., Permissions' },
        defaultValue: 'Permissions',
      },
      {
        name: 'subtitle',
        description: 'Optional subtitle (e.g., row count)',
        control: { type: 'string', placeholder: 'e.g., 8 tools' },
        defaultValue: '8 tools',
      },
    ],
    variants: [
      {
        name: 'Tool Permissions',
        description: 'Table showing tool permission levels',
        props: {
          title: 'Tool Permissions',
          subtitle: '8 tools configured',
        },
      },
      {
        name: 'No Subtitle',
        description: 'Table without subtitle',
        props: {
          title: 'Configuration',
        },
      },
    ],
    mockData: () => ({
      title: 'Permissions',
      subtitle: '8 tools',
    }),
  },
]
