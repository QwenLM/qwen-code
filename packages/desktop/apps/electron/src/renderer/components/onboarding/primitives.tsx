import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "@/components/ui/button"
import { Spinner } from "@craft-agent/ui"

/* =============================================================================
   ONBOARDING PRIMITIVES

   Shared components for consistent styling across all onboarding steps.
   These primitives make it easy to:
   - Change styles globally (one place to update)
   - Maintain consistent spacing and typography
   - Keep step components focused on their logic
============================================================================= */

// =============================================================================
// STEP ICON
// =============================================================================

export type StepIconVariant = 'primary' | 'success' | 'error' | 'loading' | 'none'

interface StepIconProps {
  /** The icon to display (should be a lucide-react icon or SVG) */
  children: React.ReactNode
  /** Visual variant - affects icon color */
  variant?: StepIconVariant
  className?: string
}

const iconVariantStyles: Record<StepIconVariant, { container: string; icon: string }> = {
  primary: {
    container: '',
    icon: 'text-foreground',
  },
  success: {
    container: '',
    icon: 'text-success',
  },
  error: {
    container: '',
    icon: 'text-destructive',
  },
  loading: {
    container: '',
    icon: 'text-foreground',
  },
  none: {
    container: '',
    icon: '',
  },
}

/**
 * StepIcon - Circular icon container for step headers
 *
 * Use at the top of centered step layouts to provide visual context.
 */
export function StepIcon({ children, variant = 'primary', className }: StepIconProps) {
  const styles = iconVariantStyles[variant]

  return (
    <div
      className={cn(
        "step-icon",
        "mb-6 flex size-16 items-center justify-center",
        styles.container,
        className
      )}
    >
      <div className={cn("size-8 [&>svg]:size-full", styles.icon)}>
        {children}
      </div>
    </div>
  )
}

// =============================================================================
// STEP HEADER
// =============================================================================

interface StepHeaderProps {
  /** The main title */
  title: string
  /** Optional description below the title */
  description?: React.ReactNode
  /** Whether to center the text (default: true) */
  centered?: boolean
  className?: string
}

/**
 * StepHeader - Title and description for steps
 *
 * Works for both centered layouts (with icon) and form layouts.
 */
export function StepHeader({
  title,
  description,
  centered = true,
  className
}: StepHeaderProps) {
  return (
    <div className={cn(centered && "text-center", className)}>
      <h1 className="step-title text-lg font-semibold tracking-tight">
        {title}
      </h1>
      {description && (
        <p className="step-description mt-2 text-sm max-w-sm text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  )
}

// =============================================================================
// STEP LAYOUT
// =============================================================================

interface StepFormLayoutProps {
  /** Icon to display at the top, wrapped in StepIcon (optional) */
  icon?: React.ReactNode
  /** Icon variant */
  iconVariant?: StepIconVariant
  /** Raw icon element to display without StepIcon wrapper (optional) */
  iconElement?: React.ReactNode
  /** Step title */
  title: string
  /** Step description */
  description?: React.ReactNode
  /** Action buttons at the bottom */
  actions?: React.ReactNode
  /** Form content */
  children?: React.ReactNode
  /** Whether children should grow to fill available space (for scrollable content) */
  grow?: boolean
  /** Whether to fill parent height without max-height limit */
  fillHeight?: boolean
  className?: string
}

/**
 * StepFormLayout - Unified layout for onboarding steps
 *
 * Use for all steps. Supports:
 * - Optional icon at top (wrapped in StepIcon, or raw via iconElement)
 * - Centered header (title + description)
 * - Full-width content below (forms, lists, etc.)
 * - Flex action buttons at bottom
 */
export function StepFormLayout({
  icon,
  iconVariant = 'primary',
  iconElement,
  title,
  description,
  actions,
  children,
  grow = false,
  fillHeight = false,
  className
}: StepFormLayoutProps) {
  return (
    <div className={cn(
      "flex w-[28rem] flex-col items-center",
      grow && !fillHeight && "h-full max-h-[600px]",
      fillHeight && "h-full",
      className
    )}>
      {iconElement && (
        <div className="mb-6 shrink-0">
          {iconElement}
        </div>
      )}
      {icon && !iconElement && (
        <StepIcon variant={iconVariant}>
          {icon}
        </StepIcon>
      )}

      <div className="shrink-0">
        <StepHeader title={title} description={description} />
      </div>

      {children && (
        <div className={cn(
          "mt-6 w-full",
          (grow || fillHeight) && "flex-1 min-h-0"
        )}>
          {children}
        </div>
      )}

      {actions && (
        <StepActions variant="flex" className="mt-6 w-full shrink-0">
          {actions}
        </StepActions>
      )}
    </div>
  )
}

// =============================================================================
// STEP ACTIONS
// =============================================================================

interface StepActionsProps {
  children: React.ReactNode
  /** Layout variant: 'stack' for vertical, 'flex' for horizontal with flex-1 buttons */
  variant?: 'stack' | 'flex'
  className?: string
}

/**
 * StepActions - Container for action buttons
 *
 * - 'stack' variant: Vertical stack, used for centered layouts with multiple CTAs
 * - 'flex' variant: Horizontal with flex-1 buttons, used for Back/Continue patterns
 */
export function StepActions({ children, variant = 'stack', className }: StepActionsProps) {
  return (
    <div
      className={cn(
        "step-actions mt-8",
        variant === 'stack' && "flex flex-col gap-3",
        variant === 'flex' && "flex gap-3 justify-center",
        className
      )}
    >
      {children}
    </div>
  )
}

// =============================================================================
// BUTTON HELPERS
// =============================================================================

interface BackButtonProps extends Omit<ButtonProps, 'variant' | 'children'> {
  children?: React.ReactNode
}

/**
 * BackButton - Consistent back/cancel button
 */
export function BackButton({ children = 'Back', className, ...props }: BackButtonProps) {
  return (
    <Button variant="ghost" className={cn("flex-1 max-w-[320px] bg-foreground-2 shadow-minimal text-foreground hover:bg-foreground/5 rounded-lg", className)} {...props}>
      {children}
    </Button>
  )
}

interface ContinueButtonProps extends Omit<ButtonProps, 'children'> {
  children?: React.ReactNode
  loading?: boolean
  loadingText?: string
}

/**
 * ContinueButton - Consistent primary action button
 */
export function ContinueButton({
  children = 'Continue',
  loading,
  loadingText = 'Loading...',
  className,
  disabled,
  ...props
}: ContinueButtonProps) {
  return (
    <Button className={cn("flex-1 max-w-[320px] bg-background shadow-minimal text-foreground hover:bg-foreground/5 rounded-lg", className)} disabled={disabled || loading} {...props}>
      {loading ? (
        <>
          <Spinner className="mr-2" />
          {loadingText}
        </>
      ) : (
        children
      )}
    </Button>
  )
}
