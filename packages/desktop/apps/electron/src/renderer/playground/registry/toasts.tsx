import * as React from 'react'
import type { ComponentEntry } from './types'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// ============================================================================
// Sonner Toast Playground
// Demonstrates different toast types, actions, and stacking behavior
// ============================================================================

type ToastType = 'default' | 'success' | 'error' | 'warning' | 'info' | 'loading' | 'action' | 'long-url'

const TOAST_TYPES: { id: ToastType; label: string; color: string }[] = [
  { id: 'default', label: 'Default', color: 'bg-foreground' },
  { id: 'success', label: 'Success', color: 'bg-green-500' },
  { id: 'error', label: 'Error', color: 'bg-red-500' },
  { id: 'warning', label: 'Warning', color: 'bg-amber-500' },
  { id: 'info', label: 'Info', color: 'bg-blue-500' },
  { id: 'loading', label: 'Loading', color: 'bg-purple-500' },
  { id: 'action', label: 'With Action', color: 'bg-foreground' },
  { id: 'long-url', label: 'With Long URL and Action', color: 'bg-cyan-500' },
]

function SonnerPlayground() {
  const [lastType, setLastType] = React.useState<ToastType>('default')

  const showToast = (type: ToastType) => {
    setLastType(type)

    switch (type) {
      case 'success':
        toast.success('Success!', { description: 'Your action completed successfully.' })
        break
      case 'error':
        toast.error('Error', { description: 'Something went wrong. Please try again.' })
        break
      case 'warning':
        toast.warning('Warning', { description: 'This action may have consequences.' })
        break
      case 'info':
        toast.info('Info', { description: 'Here is some useful information.' })
        break
      case 'loading':
        toast.loading('Loading...', { description: 'Please wait while we process.' })
        break
      case 'action':
        toast('Session deleted', {
          description: 'Your session has been removed.',
          action: {
            label: 'Undo',
            onClick: () => toast.success('Restored!'),
          },
        })
        break
      case 'long-url':
        toast('Resource available', {
          description: 'https://api.example.com/v2/organizations/acme-corp/projects/my-super-long-project-name/resources/12345/details?include=metadata&format=json',
          action: {
            label: 'Open',
            onClick: () => toast.success('Opening URL...'),
          },
        })
        break
      default:
        toast('Default toast', { description: 'This is a basic notification.' })
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-sm font-medium text-foreground/80 mb-2">Toast Types</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Click to trigger different toast styles. Last triggered: <span className="font-medium">{lastType}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          {TOAST_TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => showToast(t.id)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all',
                'bg-muted/50 hover:bg-muted text-foreground',
                lastType === t.id && 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
              )}
            >
              <div className={cn('w-3 h-3 rounded-full', t.color)} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-foreground/80 mb-2">Quick Actions</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => toast.dismiss()}
            className="px-3 py-2 rounded-lg text-sm bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            Dismiss All
          </button>
          <button
            onClick={() => {
              const id = toast.loading('Processing...')
              setTimeout(() => toast.success('Done!', { id }), 2000)
            }}
            className="px-3 py-2 rounded-lg text-sm bg-muted/50 hover:bg-muted"
          >
            Loading → Success
          </button>
          <button
            onClick={() => {
              for (let i = 0; i < 3; i++) {
                setTimeout(() => toast(`Toast ${i + 1}`), i * 200)
              }
            }}
            className="px-3 py-2 rounded-lg text-sm bg-muted/50 hover:bg-muted"
          >
            Stack 3 Toasts
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Component Registry Entries
// ============================================================================

export const toastsComponents: ComponentEntry[] = [
  {
    id: 'sonner-toasts',
    name: 'Sonner Toasts',
    category: 'Toast Messages',
    description: 'Toast notifications with different types, actions, and stacking behavior',
    component: SonnerPlayground,
    props: [],
    variants: [],
    mockData: () => ({}),
  },
]
