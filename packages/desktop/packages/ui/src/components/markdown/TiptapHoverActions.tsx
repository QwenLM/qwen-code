import * as React from 'react'
import { cn } from '../../lib/utils'

interface TiptapHoverActionsHostProps {
  children: React.ReactNode
  className?: string
  actionsOpen?: boolean
}

export function TiptapHoverActionsHost({ children, className, actionsOpen = false }: TiptapHoverActionsHostProps) {
  return (
    <div
      className={cn('tiptap-hover-actions-host', className)}
      data-actions-open={actionsOpen ? 'true' : 'false'}
    >
      {children}
    </div>
  )
}

interface TiptapHoverActionsProps {
  children: React.ReactNode
  className?: string
  contentEditable?: boolean
}

export function TiptapHoverActions({ children, className, contentEditable = false }: TiptapHoverActionsProps) {
  return (
    <div className={cn('tiptap-hover-actions', className)} contentEditable={contentEditable ? undefined : false}>
      {children}
    </div>
  )
}

interface TiptapHoverActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
}

export function TiptapHoverActionButton({
  className,
  active = false,
  type = 'button',
  ...props
}: TiptapHoverActionButtonProps) {
  return (
    <button
      type={type}
      className={cn('tiptap-hover-action-btn', active && 'is-active', className)}
      {...props}
    />
  )
}
