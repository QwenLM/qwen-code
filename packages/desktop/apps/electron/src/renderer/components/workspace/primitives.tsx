import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "@/components/ui/button"
import { Spinner } from "@craft-agent/ui"

/* =============================================================================
   ADD WORKSPACE PRIMITIVES

   Shared components for consistent styling across the Add Workspace flow.
   These primitives ensure:
   - Unified visual design across all steps
   - Easy global style updates
   - Consistent spacing and typography
============================================================================= */

// =============================================================================
// CONTAINER
// =============================================================================

interface AddWorkspaceContainerProps {
  children: React.ReactNode
  className?: string
}

/**
 * AddWorkspaceContainer - Main container for workspace creation steps
 *
 * Provides:
 * - Fixed width (28rem)
 * - Background with rounded corners
 * - Strong shadow for elevation
 * - Consistent padding
 */
export function AddWorkspaceContainer({ children, className }: AddWorkspaceContainerProps) {
  return (
    <div className={cn(
      "flex w-full max-w-[28rem] flex-col items-center",
      "bg-background rounded-[20px] shadow-strong p-8",
      className
    )}>
      {children}
    </div>
  )
}

// =============================================================================
// STEP HEADER
// =============================================================================

interface AddWorkspaceStepHeaderProps {
  /** The main title */
  title: string
  /** Optional description below the title */
  description?: React.ReactNode
  className?: string
}

/**
 * AddWorkspaceStepHeader - Title and description for workspace steps
 *
 * Always center-aligned with tight spacing for visual consistency.
 */
export function AddWorkspaceStepHeader({
  title,
  description,
  className
}: AddWorkspaceStepHeaderProps) {
  return (
    <div className={cn("text-center", className)}>
      <h1 className="text-lg font-semibold tracking-tight">
        {title}
      </h1>
      {description && (
        <p className="mt-1 text-sm max-w-sm text-muted-foreground mx-auto">
          {description}
        </p>
      )}
    </div>
  )
}

// =============================================================================
// BUTTONS
// =============================================================================

interface AddWorkspacePrimaryButtonProps extends Omit<ButtonProps, 'variant' | 'children'> {
  children?: React.ReactNode
  loading?: boolean
  loadingText?: string
}

/**
 * AddWorkspacePrimaryButton - Primary action button for workspace flow
 *
 * Used for main actions like "Create", "Open", etc.
 * Includes loading state with spinner.
 */
export function AddWorkspacePrimaryButton({
  children = 'Continue',
  loading,
  loadingText,
  className,
  disabled,
  ...props
}: AddWorkspacePrimaryButtonProps) {
  return (
    <Button
      className={cn("w-full", className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="mr-2" />
          {loadingText || children}
        </>
      ) : (
        children
      )}
    </Button>
  )
}

interface AddWorkspaceSecondaryButtonProps extends Omit<ButtonProps, 'variant'> {
  children?: React.ReactNode
}

/**
 * AddWorkspaceSecondaryButton - Secondary action button for workspace flow
 *
 * Used for actions like "Browse", or inline actions within forms.
 */
export function AddWorkspaceSecondaryButton({
  children,
  className,
  ...props
}: AddWorkspaceSecondaryButtonProps) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className={cn("bg-background shadow-minimal", className)}
      {...props}
    >
      {children}
    </Button>
  )
}
