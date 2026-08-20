import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface AddWorkspace_RadioOptionProps {
  name: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
  title: string
  subtitle: string | ReactNode
  action?: ReactNode
}

/**
 * AddWorkspace_RadioOption - Shared radio button component for workspace creation flows
 *
 * Used in:
 * - AddWorkspaceStep_OpenFolder: Browse/Create folder options + Location selection
 * - AddWorkspaceStep_CreateNew: Location selection
 */
export function AddWorkspace_RadioOption({
  name,
  checked,
  onChange,
  disabled = false,
  title,
  subtitle,
  action
}: AddWorkspace_RadioOptionProps) {
  return (
    <label className={cn(
      "flex items-center gap-3 p-3 rounded-lg cursor-pointer",
      "bg-background shadow-minimal",
      "transition-all duration-150",
      checked
        ? "hover:bg-accent/5"
        : "hover:bg-foreground/5",
      disabled && "opacity-50 cursor-not-allowed"
    )}>
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      <div className={cn(
        "h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0",
        checked
          ? "border-accent"
          : "border-foreground/30"
      )}>
        {checked && (
          <div className="h-2 w-2 rounded-full bg-accent" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground mt-[-1px]">
          {typeof subtitle === 'string' ? (
            <div className="truncate">{subtitle}</div>
          ) : (
            subtitle
          )}
        </div>
      </div>
      {action}
    </label>
  )
}
