import * as React from 'react'
import type { ComponentEntry } from './types'
import { TransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner'
import type { TransportConnectionState } from '../../../shared/types'
import { HelpCircle, Plus } from 'lucide-react'

// =============================================================================
// TransportConnectionBanner Playground
// Demonstrates the banner in context with a mock TopBar to verify no overlap.
// =============================================================================

/** Mock TopBar strip — just the right-side buttons that caused the overlap. */
function MockTopBar() {
  return (
    <div className="absolute top-0 left-0 right-0 h-[48px] z-[50] flex items-center justify-between px-3 border-b border-border/30 bg-background/80 backdrop-blur-sm">
      <span className="text-xs text-muted-foreground">Mock TopBar</span>
      <div className="flex items-center gap-1" style={{ paddingRight: 12 }}>
        <button className="h-[26px] w-[26px] flex items-center justify-center rounded-lg hover:bg-foreground/5">
          <Plus className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        </button>
        <button className="h-[26px] w-[26px] flex items-center justify-center rounded-lg hover:bg-foreground/5">
          <HelpCircle className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

/** Wrapper that provides the mock TopBar + pt-[48px] layout (matching the real App.tsx structure). */
function LayoutWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-full h-[320px] border border-border rounded-lg overflow-hidden bg-background">
      <MockTopBar />
      <div className="h-full flex flex-col pt-[48px]">
        {children}
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          (main content area)
        </div>
      </div>
    </div>
  )
}

// --- Mock states ---

const reconnectingState: TransportConnectionState = {
  mode: 'remote',
  status: 'reconnecting',
  url: 'wss://remote.example.com',
  attempt: 31,
  lastClose: { code: 1006 },
  updatedAt: Date.now(),
}

const connectingState: TransportConnectionState = {
  mode: 'remote',
  status: 'connecting',
  url: 'wss://remote.example.com',
  attempt: 0,
  updatedAt: Date.now(),
}

const failedAuthState: TransportConnectionState = {
  mode: 'remote',
  status: 'failed',
  url: 'wss://remote.example.com',
  attempt: 5,
  lastError: { kind: 'auth', message: 'Authentication failed. Verify CRAFT_SERVER_TOKEN.' },
  updatedAt: Date.now(),
}

const failedNetworkState: TransportConnectionState = {
  mode: 'remote',
  status: 'failed',
  url: 'wss://remote.example.com',
  attempt: 3,
  lastError: { kind: 'network', message: 'Could not connect to wss://remote.example.com. Is the remote server running?' },
  updatedAt: Date.now(),
}

const disconnectedState: TransportConnectionState = {
  mode: 'remote',
  status: 'disconnected',
  url: 'wss://remote.example.com',
  attempt: 1,
  lastClose: { code: 1001, reason: 'Going away' },
  updatedAt: Date.now(),
}

/** Standalone banner (no layout context) */
function BannerStandalone({ state }: { state: TransportConnectionState }) {
  return <TransportConnectionBanner state={state} onRetry={() => console.log('[Playground] Retry clicked')} />
}

/** Banner inside the full mock layout (TopBar + offset) */
function BannerInLayout({ state }: { state: TransportConnectionState }) {
  return (
    <LayoutWrapper>
      <TransportConnectionBanner state={state} onRetry={() => console.log('[Playground] Retry clicked')} />
    </LayoutWrapper>
  )
}

export const transportBannerComponents: ComponentEntry[] = [
  {
    id: 'transport-banner-layout',
    name: 'TransportConnectionBanner (Layout)',
    category: 'Chat',
    description: 'Banner with mock TopBar — verifies Retry button does not overlap help button',
    component: BannerInLayout,
    layout: 'centered',
    props: [],
    variants: [
      { name: 'Reconnecting (code 1006)', props: { state: reconnectingState } },
      { name: 'Connecting', props: { state: connectingState } },
      { name: 'Failed (auth)', props: { state: failedAuthState } },
      { name: 'Failed (network)', props: { state: failedNetworkState } },
      { name: 'Disconnected', props: { state: disconnectedState } },
    ],
    mockData: () => ({ state: reconnectingState }),
  },
  {
    id: 'transport-banner',
    name: 'TransportConnectionBanner',
    category: 'Chat',
    description: 'Remote server connection status banner with retry action',
    component: BannerStandalone,
    props: [],
    variants: [
      { name: 'Reconnecting (code 1006)', props: { state: reconnectingState } },
      { name: 'Connecting', props: { state: connectingState } },
      { name: 'Failed (auth)', props: { state: failedAuthState } },
      { name: 'Failed (network)', props: { state: failedNetworkState } },
      { name: 'Disconnected', props: { state: disconnectedState } },
    ],
    mockData: () => ({ state: reconnectingState }),
  },
]
