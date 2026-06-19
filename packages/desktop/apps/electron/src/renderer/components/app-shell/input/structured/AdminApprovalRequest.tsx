import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface AdminApprovalRequestData {
  appName: string
  reason: string
  command: string
  impact?: string
  requiresSystemPrompt?: boolean
  rememberForMinutes?: number
}

interface AdminApprovalRequestProps {
  request: AdminApprovalRequestData
  onApprove: (options: { rememberForMinutes?: number }) => void
  onCancel: () => void
  /** When true, removes container styling (shadow, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
}

/**
 * AdminApprovalRequest - Friendly admin-elevation approval card for non-technical users.
 *
 * Goal: make privileged escalation understandable and safe.
 */
export function AdminApprovalRequest({
  request,
  onApprove,
  onCancel,
  unstyled = false,
}: AdminApprovalRequestProps) {
  const { t } = useTranslation()
  const [rememberChoice, setRememberChoice] = React.useState(false)

  const rememberForMinutes = request.rememberForMinutes ?? 10

  const handleApprove = () => {
    onApprove({ rememberForMinutes: rememberChoice ? rememberForMinutes : undefined })
  }

  return (
    <div
      className={cn(
        'overflow-hidden h-full flex flex-col bg-info/5',
        unstyled
          ? 'border-0'
          : 'border border-info/30 rounded-[8px] shadow-middle'
      )}
    >
      <div className="p-4 space-y-3 flex-1 min-h-0 flex flex-col">
        <div className="space-y-2 pb-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <ShieldAlert className="h-3.5 w-3.5 text-info" />
            <span>{t('chat.adminApprovalRequired')}</span>
          </div>
          <div className="text-xs leading-[18px] text-muted-foreground">
            Installing <span className="font-medium text-foreground">{request.appName}</span> needs your Mac admin approval.
            {request.requiresSystemPrompt ? " You’ll see your regular macOS password/Touch ID prompt." : ''}
            <br />
            <span className="font-medium text-foreground">Why:</span> {request.reason}
            {request.impact && (
              <>
                <br />
                <span className="font-medium text-foreground">Impact:</span> {request.impact}
              </>
            )}
          </div>
        </div>

        <div className="bg-foreground/5 rounded-md p-3 font-mono text-xs text-foreground/90 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
          {request.command}
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
        <Button
          size="sm"
          variant="default"
          className="h-7 gap-1.5 cursor-pointer"
          onClick={handleApprove}
        >
          <Check className="h-3.5 w-3.5" />
          Approve
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-destructive hover:text-destructive border border-dashed border-destructive/50 hover:bg-destructive/10 hover:border-destructive/70 active:bg-destructive/20"
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </Button>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <Switch
            checked={rememberChoice}
            onCheckedChange={setRememberChoice}
            aria-label={`Remember this exact command for ${rememberForMinutes} minutes`}
          />
          <Label className="text-[11px] text-muted-foreground cursor-pointer" onClick={() => setRememberChoice(!rememberChoice)}>
            Remember for {rememberForMinutes} min
          </Label>
        </div>
      </div>
    </div>
  )
}
