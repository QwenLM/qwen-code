import { useCallback, useMemo, useState } from 'react'
import * as Icons from 'lucide-react'
import type { ComponentEntry } from './types'
import {
  BrowserControls,
  BrowserEmptyStateCard,
  TurnCard,
  type ActivityItem,
  type ResponseContent,
} from '@craft-agent/ui'
import { AnimatePresence, motion } from 'motion/react'
import { BrowserTabStrip } from '@/components/browser/BrowserTabStrip'
import { EMPTY_STATE_PROMPT_SAMPLES } from '@/components/browser/empty-state-prompts'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { BROWSER_LIVE_FX_BORDER, getBrowserLiveFxCornerRadii } from '../../../shared/browser-live-fx'
import { routes } from '../../../shared/routes'
import { isLinux, isMac, isWindows } from '@/lib/platform'

interface BrowserTraceSidebarSampleProps {
  scenario: 'core' | 'all-native-tools' | 'browser-tool-wrapper' | 'full-matrix'
  runState: 'completed' | 'running' | 'failed'
  sidebarWidth: number
  hdrEffect: boolean
  cursorPulse: boolean
}

type RunState = BrowserTraceSidebarSampleProps['runState']
type Scenario = BrowserTraceSidebarSampleProps['scenario']
type AgentVisualState = 'idle' | 'active' | 'failed'
type BrowserSurfaceMode = 'content' | 'empty-state'

const now = Date.now()
const PLAYGROUND_LIVE_FX_CORNERS = getBrowserLiveFxCornerRadii(
  isMac
    ? 'darwin'
    : isWindows
      ? 'win32'
      : isLinux
        ? 'linux'
        : 'other',
)

const CORE_TURN: ActivityItem[] = [
  {
    id: 'browser-open-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_open',
    toolInput: {},
    intent: 'Open in-app browser window',
    timestamp: now - 5000,
  },
  {
    id: 'browser-navigate-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_navigate',
    toolInput: { url: 'https://news.ycombinator.com' },
    intent: 'Navigate to Hacker News',
    timestamp: now - 4200,
  },
  {
    id: 'browser-snapshot-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_snapshot',
    toolInput: {},
    intent: 'Get accessibility refs for interactive elements',
    timestamp: now - 3500,
  },
  {
    id: 'browser-click-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_click',
    toolInput: { ref: '@e12' },
    intent: 'Open top story',
    timestamp: now - 3000,
  },
  {
    id: 'browser-screenshot-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_screenshot',
    toolInput: { mode: 'agent', refs: ['@e12'], includeMetadata: true },
    intent: 'Capture agent-mode screenshot with semantic annotation',
    timestamp: now - 2500,
  },
]

const ALL_NATIVE_TOOLS_TURN: ActivityItem[] = [
  { id: 'native-open', type: 'tool', status: 'completed', toolName: 'browser_open', toolInput: {}, intent: 'Open browser window', timestamp: now - 5200 },
  { id: 'native-navigate', type: 'tool', status: 'completed', toolName: 'browser_navigate', toolInput: { url: 'https://example.com' }, intent: 'Navigate to target URL', timestamp: now - 4900 },
  { id: 'native-snapshot', type: 'tool', status: 'completed', toolName: 'browser_snapshot', toolInput: {}, intent: 'Capture a11y tree refs', timestamp: now - 4600 },
  { id: 'native-click', type: 'tool', status: 'completed', toolName: 'browser_click', toolInput: { ref: '@e12' }, intent: 'Click interactive element', timestamp: now - 4300 },
  { id: 'native-fill', type: 'tool', status: 'completed', toolName: 'browser_fill', toolInput: { ref: '@e5', value: 'balint@example.com' }, intent: 'Fill input field', timestamp: now - 4000 },
  { id: 'native-select', type: 'tool', status: 'completed', toolName: 'browser_select', toolInput: { ref: '@e9', value: 'pro' }, intent: 'Select dropdown option', timestamp: now - 3700 },
  { id: 'native-scroll', type: 'tool', status: 'completed', toolName: 'browser_scroll', toolInput: { direction: 'down', amount: 800 }, intent: 'Scroll for more content', timestamp: now - 3400 },
  { id: 'native-back', type: 'tool', status: 'completed', toolName: 'browser_back', toolInput: {}, intent: 'Navigate back in history', timestamp: now - 3100 },
  { id: 'native-forward', type: 'tool', status: 'completed', toolName: 'browser_forward', toolInput: {}, intent: 'Navigate forward in history', timestamp: now - 2800 },
  { id: 'native-evaluate', type: 'tool', status: 'completed', toolName: 'browser_evaluate', toolInput: { expression: 'document.title' }, intent: 'Run JS extraction in page context', timestamp: now - 2500 },
  { id: 'native-screenshot', type: 'tool', status: 'completed', toolName: 'browser_screenshot', toolInput: { mode: 'agent', includeMetadata: true }, intent: 'Capture visual proof with metadata', timestamp: now - 2200 },
]

const WRAPPER_COMMANDS_TURN: ActivityItem[] = [
  { id: 'wrapper-open', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'open' }, intent: 'Wrapper: open browser', timestamp: now - 4200 },
  { id: 'wrapper-navigate', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'navigate https://example.com' }, intent: 'Wrapper: navigate to URL', timestamp: now - 3900 },
  { id: 'wrapper-snapshot', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'snapshot' }, intent: 'Wrapper: list refs', timestamp: now - 3600 },
  { id: 'wrapper-fill', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'fill @e5 hello@craft.do' }, intent: 'Wrapper: fill text field', timestamp: now - 3300 },
  { id: 'wrapper-click', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'click @e8' }, intent: 'Wrapper: click target', timestamp: now - 3000 },
  { id: 'wrapper-scroll', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'scroll down 600' }, intent: 'Wrapper: scroll viewport', timestamp: now - 2700 },
  { id: 'wrapper-evaluate', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'evaluate document.title' }, intent: 'Wrapper: evaluate expression', timestamp: now - 2400 },
]

function applyRunState(activities: ActivityItem[], runState: RunState): ActivityItem[] {
  if (runState === 'completed') return activities

  return activities.map((activity, index) => {
    if (runState === 'running' && index === activities.length - 1) {
      return { ...activity, status: 'running' }
    }
    if (runState === 'failed' && index === activities.length - 1) {
      return { ...activity, status: 'error' }
    }
    return { ...activity, status: 'completed' }
  })
}

function getScenarioTurns(scenario: Scenario): ActivityItem[][] {
  switch (scenario) {
    case 'core':
      return [CORE_TURN]
    case 'all-native-tools':
      return [ALL_NATIVE_TOOLS_TURN]
    case 'browser-tool-wrapper':
      return [WRAPPER_COMMANDS_TURN]
    case 'full-matrix':
      return [ALL_NATIVE_TOOLS_TURN, WRAPPER_COMMANDS_TURN]
    default:
      return [CORE_TURN]
  }
}

function getScenarioResponse(scenario: Scenario, runState: RunState): ResponseContent {
  if (runState === 'failed') {
    return {
      text: 'One browser action failed in this turn. Verify refs/inputs and retry.',
      isStreaming: false,
    }
  }

  if (runState === 'running') {
    return {
      text: 'Browser action in progress… waiting for completion.',
      isStreaming: true,
    }
  }

  return {
    text: scenario === 'full-matrix'
      ? 'Rendered all native browser_* tools and browser_tool wrapper command flows.'
      : 'Rendered browser tool flow for this scenario.',
    isStreaming: false,
  }
}

function getLiveFxPayload(scenario: Scenario, runState: RunState): { active: boolean; label: string; cursor: { x: number; y: number } | null } {
  if (runState === 'failed') {
    return {
      active: true,
      label: 'Action failed — verify refs and retry',
      cursor: null,
    }
  }

  if (runState === 'running') {
    const cursorByScenario: Record<Scenario, { x: number; y: number } | null> = {
      core: { x: 296, y: 252 },
      'all-native-tools': { x: 426, y: 214 },
      'browser-tool-wrapper': { x: 342, y: 304 },
      'full-matrix': { x: 382, y: 246 },
    }

    return {
      active: true,
      label: 'Craft Agents are working…',
      cursor: cursorByScenario[scenario],
    }
  }

  return {
    active: false,
    label: '',
    cursor: null,
  }
}

function getLiveFxPayloadFromAgentState(
  scenario: Scenario,
  agentState: AgentVisualState,
): { active: boolean; label: string; cursor: { x: number; y: number } | null } {
  switch (agentState) {
    case 'failed':
      return getLiveFxPayload(scenario, 'failed')
    case 'active':
      return getLiveFxPayload(scenario, 'running')
    case 'idle':
    default:
      return getLiveFxPayload(scenario, 'completed')
  }
}

function BrowserAgentEmptyState({
  title,
  description,
  showExamplePrompts,
  showSafetyHint,
}: {
  title: string
  description: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  const handlePromptSelect = useCallback(async (prompt: string) => {
    const deepLinkRoute = routes.action.newSession({ input: prompt, send: true })
    const deepLinkUrl = `craftagents://${deepLinkRoute}`

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.openUrl) {
        await window.electronAPI.openUrl(deepLinkUrl)
        return
      }

      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt)
      }
      console.info('[BrowserEmptyState] Prompt copied (Electron API unavailable):', prompt)
    } catch (error) {
      console.warn('[BrowserEmptyState] Failed to open prompt deep link:', error)
    }
  }, [])

  return (
    <BrowserEmptyStateCard
      title={title}
      description={description}
      prompts={EMPTY_STATE_PROMPT_SAMPLES}
      showExamplePrompts={showExamplePrompts}
      showSafetyHint={showSafetyHint}
      onPromptSelect={(sample) => void handlePromptSelect(sample.full)}
    />
  )
}

function BrowserMockPageSurface({
  className,
  mode = 'content',
  emptyStateTitle = 'This browser is ready for your Agents - and you ;)',
  emptyStateDescription = 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
  showExamplePrompts = true,
  showSafetyHint = true,
}: {
  className?: string
  mode?: BrowserSurfaceMode
  emptyStateTitle?: string
  emptyStateDescription?: string
  showExamplePrompts?: boolean
  showSafetyHint?: boolean
}) {
  if (mode === 'empty-state') {
    return (
      <div className={className ?? 'absolute inset-0 p-6 z-10'}>
        <BrowserAgentEmptyState
          title={emptyStateTitle}
          description={emptyStateDescription}
          showExamplePrompts={showExamplePrompts}
          showSafetyHint={showSafetyHint}
        />
      </div>
    )
  }

  return (
    <div className={className ?? 'absolute inset-0 p-6 z-10'}>
      <div className="h-10 rounded-lg border border-foreground/10 bg-background/80 backdrop-blur-sm" />
      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="h-24 rounded-lg bg-foreground/5" />
        <div className="h-24 rounded-lg bg-foreground/5" />
        <div className="h-24 rounded-lg bg-foreground/5" />
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-4 w-[70%] rounded bg-foreground/10" />
        <div className="h-4 w-[85%] rounded bg-foreground/8" />
        <div className="h-4 w-[60%] rounded bg-foreground/10" />
      </div>
    </div>
  )
}

function BrowserEdgeShaderFx({ className = 'absolute inset-0 pointer-events-none z-20', rounded = false }: { className?: string; rounded?: boolean }) {
  return (
    <div
      className={className}
      style={{
        borderTopLeftRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.topLeft : undefined,
        borderTopRightRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.topRight : undefined,
        borderBottomLeftRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.bottomLeft : undefined,
        borderBottomRightRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.bottomRight : undefined,
        borderWidth: BROWSER_LIVE_FX_BORDER.width,
        borderStyle: BROWSER_LIVE_FX_BORDER.style,
        borderColor: BROWSER_LIVE_FX_BORDER.color,
        boxShadow: BROWSER_LIVE_FX_BORDER.boxShadow,
      }}
    />
  )
}

function BrowserTraceSidebarSample({ scenario, runState, sidebarWidth, hdrEffect, cursorPulse }: BrowserTraceSidebarSampleProps) {
  const turns = getScenarioTurns(scenario).map((items, index) => applyRunState(items, runState))

  return (
    <div className="w-full h-[700px] rounded-xl border border-border overflow-hidden bg-background shadow-sm flex">
      <div className="flex-1 relative overflow-hidden">
        {/* Base placeholder browser content */}
        <div className="absolute inset-0 bg-gradient-to-br from-slate-100 via-slate-50 to-slate-100 dark:from-slate-900 dark:via-slate-950 dark:to-slate-900" />

        {/* Shared edge shader effect (same visual as Browser Frame overlay) */}
        {hdrEffect && <BrowserEdgeShaderFx className="absolute inset-0 pointer-events-none z-20" />}

        {/* Cursor pulse simulation */}
        {cursorPulse && (
          <>
            <motion.div
              className="absolute h-6 w-5 z-30 [will-change:transform]"
              style={{ transform: 'translateZ(0)' }}
              initial={false}
              animate={{ x: [220, 300, 430, 330, 220], y: [180, 260, 240, 350, 180], rotate: [0, 2, -3, 1, 0] }}
              transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
            >
              <div
                className="h-full w-full bg-black shadow-[0_0_12px_rgba(0,0,0,0.35)]"
                style={{
                  clipPath: 'polygon(0% 0%, 0% 100%, 34% 73%, 51% 100%, 66% 94%, 48% 67%, 100% 67%)',
                  borderRadius: '2px',
                  outline: '1px solid rgba(255,255,255,0.75)',
                }}
              />
            </motion.div>
            <motion.div
              className="absolute h-10 w-10 rounded-full border-2 border-cyan-400/65 z-30 [will-change:transform,opacity]"
              style={{ transform: 'translateZ(0)' }}
              initial={{ x: 213, y: 173, opacity: 0.75, scale: 0.55 }}
              animate={{ x: [213, 293, 423, 323, 213], y: [173, 253, 233, 343, 173], opacity: [0.68, 0.16, 0.68, 0.16, 0.68], scale: [0.6, 1.5, 0.6, 1.5, 0.6] }}
              transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
            />
          </>
        )}

        <BrowserMockPageSurface />
      </div>

      <div
        className="h-full border-l border-border bg-background/95 backdrop-blur-sm overflow-y-auto p-3 space-y-3"
        style={{ width: `${sidebarWidth}px` }}
      >
        {turns.map((activities, index) => {
          const isRunning = runState === 'running' && index === turns.length - 1
          const response = getScenarioResponse(scenario, runState)

          return (
            <TurnCard
              key={`browser-trace-turn-${index + 1}`}
              sessionId="playground-browser-session"
              turnId={`browser-trace-turn-${index + 1}`}
              activities={activities}
              response={response}
              intent={index === 0 ? 'Tool execution trace' : 'Wrapper command trace'}
              isStreaming={isRunning}
              isComplete={!isRunning}
              onOpenFile={(path) => console.log('[Playground] Open file:', path)}
              onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
              compactMode={true}
            />
          )
        })}
      </div>
    </div>
  )
}

function BrowserFramePlayground({
  initialUrl,
  loading,
  agentState,
  themeColor,
  surfaceMode,
  emptyStateTitle,
  emptyStateDescription,
  showExamplePrompts,
  showSafetyHint,
}: {
  initialUrl: string
  loading: boolean
  agentState: AgentVisualState
  themeColor: string
  surfaceMode: BrowserSurfaceMode
  emptyStateTitle: string
  emptyStateDescription: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  const [url, setUrl] = useState(initialUrl)
  const scenario: Scenario = 'full-matrix'
  const liveFx = getLiveFxPayloadFromAgentState(scenario, agentState)

  return (
    <div className="w-full h-[700px] rounded-xl border border-border overflow-hidden bg-background shadow-sm flex">
      <div className="flex-1 min-w-0">
        <BrowserControls
          url={url}
          loading={loading}
          onNavigate={setUrl}
          onUrlChange={setUrl}
          themeColor={themeColor || undefined}
          urlBarClassName="max-w-[600px]"
          className="border-b-0"
        />
        <div className="h-[calc(100%-48px)] bg-foreground-2">
          <div className="relative h-full w-full bg-background overflow-hidden">
            <BrowserMockPageSurface
              className="absolute inset-0 p-6"
              mode={surfaceMode}
              emptyStateTitle={emptyStateTitle}
              emptyStateDescription={emptyStateDescription}
              showExamplePrompts={showExamplePrompts}
              showSafetyHint={showSafetyHint}
            />

            <AnimatePresence>
              {liveFx.active && (
                <motion.div
                  className="absolute inset-0 pointer-events-none z-20"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                  <BrowserEdgeShaderFx className="absolute inset-0" rounded />

                  <div
                    className="absolute text-[11px]"
                    style={{
                      top: '8px',
                      right: '8px',
                      padding: '4px 8px',
                      borderRadius: '7px',
                      font: '11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
                      background: 'rgba(2, 6, 23, 0.82)',
                      color: 'rgba(236, 254, 255, 0.95)',
                      backdropFilter: 'blur(4px)',
                    }}
                  >
                    {liveFx.label}
                  </div>

                  {liveFx.cursor && (
                    <motion.div
                      className="absolute"
                      style={{
                        width: '18px',
                        height: '22px',
                        left: liveFx.cursor.x - 2,
                        top: liveFx.cursor.y - 2,
                        filter: 'drop-shadow(0 0 8px rgba(0,0,0,0.35))',
                      }}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                    >
                      <div
                        className="h-full w-full bg-black"
                        style={{
                          clipPath: 'polygon(0% 0%, 0% 100%, 34% 73%, 51% 100%, 66% 94%, 48% 67%, 100% 67%)',
                          borderRadius: '2px',
                          outline: '1px solid rgba(255,255,255,0.75)',
                        }}
                      />
                    </motion.div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

    </div>
  )
}

function BrowserEmptyStatePlayground({
  title,
  description,
  showExamplePrompts,
  showSafetyHint,
}: {
  title: string
  description: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  return (
    <div className="w-full h-[700px] rounded-xl border border-border overflow-hidden bg-background shadow-sm flex">
      <div className="relative h-full w-full bg-foreground-2 overflow-hidden">
        <BrowserMockPageSurface
          className="absolute inset-0 p-8"
          mode="empty-state"
          emptyStateTitle={title}
          emptyStateDescription={description}
          showExamplePrompts={showExamplePrompts}
          showSafetyHint={showSafetyHint}
        />
      </div>
    </div>
  )
}

type BrowserTabStripMode = 'auto' | 'live' | 'mock'
type BrowserTabStripMockPreset = 'default' | 'long-names' | 'many-running' | 'stress-mix'

// NOTE: Theme colors below are derived from the same extraction logic used by browser-pane-manager
// (meta tags + top-surface sampling fallback) and then applied to realistic mock scenarios.
const MOCK_BROWSER_PRESETS: Record<BrowserTabStripMockPreset, BrowserInstanceInfo[]> = {
  default: [
    {
      id: 'mock-1',
      url: 'https://localhost:5173/playground.html',
      title: 'localhost',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#4f46e5',
    },
    {
      id: 'mock-2',
      url: 'https://linear.app/craft-docs/settings/teams',
      title: 'Linear',
      favicon: null,
      isLoading: true,
      canGoBack: true,
      canGoForward: true,
      boundSessionId: '260228-vital-thistle',
      ownerType: 'session',
      ownerSessionId: '260228-vital-thistle',
      isVisible: true,
      agentControlActive: true,
      themeColor: 'lch(96.667% 0 282.863 / 1)',
    },
    {
      id: 'mock-3',
      url: 'https://craftdocs.bamboohr.com/employees/pto/?id=132',
      title: 'BambooHR',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-quick-bobcat',
      ownerType: 'session',
      ownerSessionId: '260228-quick-bobcat',
      isVisible: false,
      agentControlActive: false,
      themeColor: '#6db33f',
    },
    {
      id: 'mock-4',
      url: 'https://github.com/lukilabs/craft-agents-oss',
      title: 'GitHub',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: true,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#1e2327',
    },
    {
      id: 'mock-5',
      url: 'https://telex.hu/',
      title: 'Telex',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#002244',
    },
  ],
  'long-names': [
    {
      id: 'long-1',
      url: 'https://www.notion.so/Craft-Agents-Multi-Session-Browser-Registry-Design-Review-Thread-2026-Q1',
      title: 'Craft Agents Multi-Session Browser Registry Design Review Thread (Q1 2026)',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: true,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: false,
      themeColor: null,
    },
    {
      id: 'long-2',
      url: 'https://linear.app/craft-docs/issue/CHA-999/very-long-title-to-test-truncation-behavior-in-top-bar-badges',
      title: 'CHA-999 — Extremely Long Issue Title to Validate Ellipsis and Badge Width Constraints',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-vital-thistle',
      ownerType: 'session',
      ownerSessionId: '260228-vital-thistle',
      isVisible: true,
      agentControlActive: true,
      themeColor: 'lch(96.667% 0 282.863 / 1)',
    },
    {
      id: 'long-3',
      url: 'https://docs.google.com/document/d/this-is-a-super-long-doc-id-used-for-playground-visual-tests/edit',
      title: 'Quarterly Platform Reliability Retrospective — Working Draft — Internal Only',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-quick-bobcat',
      ownerType: 'session',
      ownerSessionId: '260228-quick-bobcat',
      isVisible: false,
      agentControlActive: false,
      themeColor: null,
    },
  ],
  'many-running': [
    {
      id: 'run-1',
      url: 'https://app.datadoghq.eu/dashboard/abc',
      title: 'Datadog',
      favicon: null,
      isLoading: true,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: true,
      themeColor: null,
    },
    {
      id: 'run-2',
      url: 'https://linear.app/craft-docs/team/CHA/active',
      title: 'Linear Active Issues',
      favicon: null,
      isLoading: true,
      canGoBack: true,
      canGoForward: true,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: true,
      themeColor: 'lch(96.667% 0 282.863 / 1)',
    },
    {
      id: 'run-3',
      url: 'https://github.com/lukilabs/craft-agents-oss/pulls',
      title: 'GitHub PRs',
      favicon: null,
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      boundSessionId: '260228-vital-thistle',
      ownerType: 'session',
      ownerSessionId: '260228-vital-thistle',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#1e2327',
    },
    {
      id: 'run-4',
      url: 'https://craftdocs.bamboohr.com/reports',
      title: 'BambooHR Reports',
      favicon: null,
      isLoading: true,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-quick-bobcat',
      ownerType: 'session',
      ownerSessionId: '260228-quick-bobcat',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#6db33f',
    },
    {
      id: 'run-5',
      url: 'https://www.notion.so/',
      title: 'Notion',
      favicon: null,
      isLoading: true,
      canGoBack: true,
      canGoForward: true,
      boundSessionId: '260228-quick-bobcat',
      ownerType: 'session',
      ownerSessionId: '260228-quick-bobcat',
      isVisible: false,
      agentControlActive: false,
      themeColor: '#111111',
    },
  ],
  'stress-mix': [
    {
      id: 'mix-1',
      url: 'https://localhost:5173/playground.html',
      title: 'localhost',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: false,
      themeColor: null,
    },
    {
      id: 'mix-2',
      url: 'https://linear.app/craft-docs/settings/new-team',
      title: 'Add team',
      favicon: null,
      isLoading: true,
      canGoBack: true,
      canGoForward: true,
      boundSessionId: '260228-vital-thistle',
      ownerType: 'session',
      ownerSessionId: '260228-vital-thistle',
      isVisible: true,
      agentControlActive: true,
      themeColor: 'lch(96.667% 0 282.863 / 1)',
    },
    {
      id: 'mix-3',
      url: 'https://craftdocs.bamboohr.com/employees/pto/?id=132',
      title: 'Péter Bobula - Time Off',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-quick-bobcat',
      ownerType: 'session',
      ownerSessionId: '260228-quick-bobcat',
      isVisible: false,
      agentControlActive: false,
      themeColor: null,
    },
    {
      id: 'mix-4',
      url: 'https://github.com/lukilabs/craft-agents-oss',
      title: 'Craft Agents OSS Repo with a Surprisingly Long Branch and Compare View Name',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: true,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#1e2327',
    },
    {
      id: 'mix-5',
      url: 'https://www.figma.com/file/abc/Design-System',
      title: 'Figma Design System',
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      boundSessionId: '260228-vital-thistle',
      ownerType: 'session',
      ownerSessionId: '260228-vital-thistle',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#1abcfe',
    },
    {
      id: 'mix-6',
      url: 'https://calendar.google.com',
      title: 'Google Calendar',
      favicon: null,
      isLoading: true,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-quick-bobcat',
      ownerType: 'session',
      ownerSessionId: '260228-quick-bobcat',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#1a73e8',
    },
    {
      id: 'mix-7',
      url: 'https://telex.hu/',
      title: 'Telex - friss hírek, hiteles információk',
      favicon: null,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      boundSessionId: '260228-high-comet',
      ownerType: 'session',
      ownerSessionId: '260228-high-comet',
      isVisible: true,
      agentControlActive: false,
      themeColor: '#002244',
    },
  ],
}

function BrowserTabStripPlayground({
  activeSessionId,
  mode,
  mockPreset,
}: {
  activeSessionId: string
  mode: BrowserTabStripMode
  mockPreset: BrowserTabStripMockPreset
}) {
  const hasBrowserPaneBridge = typeof window !== 'undefined' && !!window.electronAPI?.browserPane
  const resolvedMode: Exclude<BrowserTabStripMode, 'auto'> = mode === 'auto'
    ? (hasBrowserPaneBridge ? 'live' : 'mock')
    : mode

  const mockInstances = useMemo(() => {
    const items = [...(MOCK_BROWSER_PRESETS[mockPreset] ?? MOCK_BROWSER_PRESETS.default)]
    if (!activeSessionId) return items

    items.sort((a, b) => {
      const aInActiveSession = a.boundSessionId === activeSessionId ? 0 : 1
      const bInActiveSession = b.boundSessionId === activeSessionId ? 0 : 1
      if (aInActiveSession !== bInActiveSession) return aInActiveSession - bInActiveSession
      return a.id.localeCompare(b.id)
    })

    return items
  }, [activeSessionId, mockPreset])

  if (resolvedMode === 'live' && !hasBrowserPaneBridge) {
    return (
      <div className="w-full max-w-[900px] p-6 rounded-xl border border-border bg-background shadow-sm">
        <div className="text-sm font-medium mb-2">Top Bar Browser Strip</div>
        <p className="text-xs text-foreground/60">
          Live mode requires Electron preload APIs (`window.electronAPI.browserPane`), which are not available in plain browser context.
          Switch mode to Auto or Mock for visual review here.
        </p>
      </div>
    )
  }

  return (
    <div className="w-full max-w-[900px] p-6 rounded-xl border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Top Bar Browser Strip</h3>
        <span className="text-xs text-foreground/50">
          {resolvedMode === 'live' ? 'Live data from browser registry' : 'Mock preview states'}
        </span>
      </div>
      {resolvedMode === 'mock' && (
        <div className="text-xs text-foreground/50 mb-2">
          {mockInstances.length} tabs • {mockInstances.filter(i => i.isLoading).length} loading • {mockInstances.filter(i => !i.isVisible).length} hidden • {mockInstances.filter(i => i.agentControlActive).length} agent-controlled
        </div>
      )}
      <div className="h-[48px] px-3 rounded-lg border border-foreground/[0.08] bg-background flex items-center justify-end gap-1">
        <BrowserTabStrip
          activeSessionId={activeSessionId || null}
          instancesOverride={resolvedMode === 'mock' ? mockInstances : undefined}
        />
      </div>
      <p className="text-xs text-foreground/50 mt-3">
        Accent 1px border indicates a browser currently controlled by an agent.
      </p>
    </div>
  )
}

export const browserUiComponents: ComponentEntry[] = [
  {
    id: 'browser-frame-playground',
    name: 'Browser Frame (Dedicated Controls)',
    category: 'Browser',
    description: 'Dedicated always-visible browser controls frame for iterating visual design before wiring to native window.',
    component: BrowserFramePlayground,
    layout: 'top',
    props: [
      {
        name: 'initialUrl',
        description: 'Initial URL value shown in the address field.',
        control: { type: 'string' },
        defaultValue: 'https://www.iana.org/help',
      },
      {
        name: 'loading',
        description: 'Website loading state only (URL bar spinner + Stop/Reload).',
        control: { type: 'boolean' },
        defaultValue: false,
      },


      {
        name: 'agentState',
        description: 'Agent activity state only (independent from website loading).',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Active', value: 'active' },
            { label: 'Failed', value: 'failed' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'themeColor',
        description: 'Website theme color (hex). Simulates <meta name="theme-color">.',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: '' },
            { label: 'Google Blue (#4285f4)', value: '#4285f4' },
            { label: 'GitHub Dark (#24292e)', value: '#1e2327' },
            { label: 'Stripe Purple (#635bff)', value: '#635bff' },
            { label: 'Slack (#4a154b)', value: '#4a154b' },
            { label: 'Linear (#5e6ad2)', value: 'lch(96.667% 0 282.863 / 1)' },
            { label: 'Twitter/X (#15202b)', value: '#15202b' },
            { label: 'YouTube Red (#ff0000)', value: '#ff0000' },
            { label: 'Light Gray (#f5f5f5)', value: '#f5f5f5' },
            { label: 'White (#ffffff)', value: '#ffffff' },
          ],
        },
        defaultValue: '',
      },
      {
        name: 'surfaceMode',
        description: 'Switch between generic mock page content and the new browser onboarding empty state.',
        control: {
          type: 'select',
          options: [
            { label: 'Empty State', value: 'empty-state' },
            { label: 'Mock Content', value: 'content' },
          ],
        },
        defaultValue: 'empty-state',
      },
      {
        name: 'emptyStateTitle',
        description: 'Main heading shown in the browser empty state.',
        control: { type: 'string' },
        defaultValue: 'This browser is ready for your Agents - and you ;)',
      },
      {
        name: 'emptyStateDescription',
        description: 'Body copy describing how sessions can use this browser window.',
        control: { type: 'string' },
        defaultValue: 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
      },
      {
        name: 'showExamplePrompts',
        description: 'Show quick prompt chips that demonstrate browser automation requests.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showSafetyHint',
        description: 'Show a small trust hint explaining that browser control is user-triggered.',
        control: { type: 'boolean' },
        defaultValue: true,
      },

    ],
  },
  {
    id: 'browser-empty-state-playground',
    name: 'Browser Empty State (Agent Guidance)',
    category: 'Browser',
    description: 'Focused preview of the first-load browser empty state message for copy and visual iteration.',
    component: BrowserEmptyStatePlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Main heading for the empty state card.',
        control: { type: 'string' },
        defaultValue: 'This browser is ready for your Agents - and you ;)',
      },
      {
        name: 'description',
        description: 'Explanatory copy shown under the title.',
        control: { type: 'string' },
        defaultValue: 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
      },
      {
        name: 'showExamplePrompts',
        description: 'Show quick prompt examples for common browser workflows.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showSafetyHint',
        description: 'Show a subtle note that browser control happens only when requested.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
  },
  {
    id: 'browser-tab-strip-playground',
    name: 'Browser Tab Strip (Top Bar)',
    category: 'Browser',
    description: 'Live BrowserTabStrip used in the main top bar, including global registry and agent-control accent border.',
    component: BrowserTabStripPlayground,
    props: [
      {
        name: 'mode',
        description: 'Auto: use live in Electron and mock in plain browser. Live: force bridge usage. Mock: always show sample badges.',
        control: {
          type: 'select',
          options: [
            { label: 'Auto', value: 'auto' },
            { label: 'Live', value: 'live' },
            { label: 'Mock', value: 'mock' },
          ],
        },
        defaultValue: 'mock',
      },
      {
        name: 'mockPreset',
        description: 'Mock state bundle for visual QA: long names, multiple running tabs, hidden tabs, and agent-controlled accents.',
        control: {
          type: 'select',
          options: [
            { label: 'Default', value: 'default' },
            { label: 'Long Names', value: 'long-names' },
            { label: 'Many Running', value: 'many-running' },
            { label: 'Stress Mix', value: 'stress-mix' },
          ],
        },
        defaultValue: 'stress-mix',
      },
      {
        name: 'activeSessionId',
        description: 'Session used for ordering preference (session-local windows first) in both live and mock modes.',
        control: { type: 'string', placeholder: '260228-high-comet' },
        defaultValue: '260228-high-comet',
      },
    ],
  },

]
