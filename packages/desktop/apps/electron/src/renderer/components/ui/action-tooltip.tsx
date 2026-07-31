import { useActionLabel } from '@/actions'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import type { ActionId } from '@/actions/definitions'

interface ActionTooltipProps {
  action: ActionId
  children: React.ReactNode
}

export function ActionTooltip({ action, children }: ActionTooltipProps) {
  const { label, hotkey } = useActionLabel(action)

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {hotkey && <kbd className="ml-2 text-xs opacity-60">{hotkey}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
