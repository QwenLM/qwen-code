import * as React from 'react'
import type { ComponentEntry } from './types'
import { SquareSlash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FreeFormInput } from '@/components/app-shell/input/FreeFormInput'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import { ensureMockElectronAPI } from '../mock-utils'
import {
  SlashCommandMenu,
  DEFAULT_SLASH_COMMANDS,
  type SlashCommandId,
} from '@/components/ui/slash-command-menu'

// ============================================================================
// SlashCommandDemo - Full interactive demo
// ============================================================================

function SlashCommandDemo() {
  const [activeCommands, setActiveCommands] = React.useState<SlashCommandId[]>([])
  const [buttonMenuOpen, setButtonMenuOpen] = React.useState(false)
  const [inputValue, setInputValue] = React.useState('')
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('ask')
  const [model, setModel] = React.useState('qwen3-coder-flash')

  // FreeFormInput depends on Electron bridge APIs (attachments, clipboard, etc.)
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  // Handle command selection (toggle active state)
  const handleCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    setActiveCommands(prev =>
      prev.includes(commandId)
        ? prev.filter(id => id !== commandId)
        : [...prev, commandId]
    )
  }, [])

  const handleButtonSelect = (commandId: SlashCommandId) => {
    handleCommandSelect(commandId)
    setButtonMenuOpen(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Description */}
      <div className="shrink-0 p-4 border-b border-border/50">
        <h2 className="text-sm font-medium text-foreground/80 mb-2">
          Slash Command Menu Demo
        </h2>
        <p className="text-xs text-muted-foreground">
          Type <code className="px-1 py-0.5 bg-muted rounded">/</code> to trigger inline autocomplete in the real input component, or click the button to open the standalone menu.
          Active commands in the standalone menu show a checkmark.
        </p>
      </div>

      {/* Active Commands Display */}
      {activeCommands.length > 0 && (
        <div className="shrink-0 px-4 py-2 border-b border-border/50 flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground">Standalone menu active:</span>
          {activeCommands.map(id => {
            const cmd = DEFAULT_SLASH_COMMANDS.find(c => c.id === id)
            const color = cmd?.color || '#888'
            return cmd ? (
              <button
                key={id}
                onClick={() => setActiveCommands(prev => prev.filter(c => c !== id))}
                className="h-6 px-2 text-[11px] font-medium rounded flex items-center gap-1.5 transition-all border"
                style={{
                  backgroundColor: `${color}1A`, // 10% opacity
                  color: color,
                  borderColor: `${color}4D`, // 30% opacity
                }}
              >
                {cmd.icon}
                <span>{cmd.label}</span>
                <span className="opacity-60 hover:opacity-100">×</span>
              </button>
            ) : null
          })}
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex gap-4 p-4">
        {/* Left: Button Menu with Filter */}
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Button Menu (with filter input)
          </div>
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setButtonMenuOpen(!buttonMenuOpen)}
            >
              <SquareSlash className="h-4 w-4" />
              Commands
            </Button>
            {buttonMenuOpen && (
              <div className="absolute top-full left-0 mt-2 z-10">
                <SlashCommandMenu
                  commands={DEFAULT_SLASH_COMMANDS}
                  activeCommands={activeCommands}
                  onSelect={handleButtonSelect}
                  showFilter={true}
                  className="w-[240px]"
                />
              </div>
            )}
          </div>
        </div>

        {/* Right: Static Menu (no filter) */}
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Static Menu (no filter)
          </div>
          <SlashCommandMenu
            commands={DEFAULT_SLASH_COMMANDS}
            activeCommands={activeCommands}
            onSelect={handleButtonSelect}
            className="w-full"
          />
        </div>
      </div>

      {/* Input Area using the real app input component */}
      <div className="shrink-0 p-4 border-t border-border/50">
        <div className="text-xs font-medium text-muted-foreground mb-2">
          Real FreeFormInput (type / in the input)
        </div>
        <FreeFormInput
          placeholder="Type / to see commands..."
          currentModel={model}
          onModelChange={setModel}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          inputValue={inputValue}
          onInputChange={setInputValue}
          sessionId="playground-session"
          onSubmit={() => {}}
          onStop={() => {}}
        />
      </div>
    </div>
  )
}

// ============================================================================
// Component Registry Entries
// ============================================================================

export const slashCommandComponents: ComponentEntry[] = [
  {
    id: 'slash-command-demo',
    name: 'Slash Command Demo',
    category: 'Chat Inputs',
    description: 'Interactive demo showing both button-triggered and inline slash command menus',
    component: SlashCommandDemo,
    layout: 'full',
    props: [],
    variants: [],
    mockData: () => ({}),
  },
]
