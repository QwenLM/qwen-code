import React, { createContext, useContext, useCallback, useRef } from 'react'

/**
 * Modal registry context - tracks open modals for layered close handling.
 *
 * Cmd+W (keyboard close) checks this registry first: if a modal is open,
 * the topmost modal is closed before panels/window.
 *
 * Modals register themselves with a priority (higher = closed first) and a close handler.
 */

interface RegisteredModal {
  id: string
  priority: number
  close: () => void
}

interface ModalContextValue {
  /** Register a modal when it opens. Returns unregister function. */
  registerModal: (id: string, close: () => void, priority?: number) => () => void
  /** Check if any modals are open */
  hasOpenModals: () => boolean
  /** Close the topmost modal (highest priority). Returns true if a modal was closed. */
  closeTopModal: () => boolean
}

const ModalContext = createContext<ModalContextValue | null>(null)

/**
 * Provider for modal registry. Wrap your app with this to enable close interception.
 */
export function ModalProvider({ children }: { children: React.ReactNode }) {
  // Using ref instead of state to avoid re-renders when modals register/unregister.
  // The UI doesn't need to know about the registry - only the close handler does.
  const modalsRef = useRef<Map<string, RegisteredModal>>(new Map())

  const registerModal = useCallback((id: string, close: () => void, priority = 0) => {
    modalsRef.current.set(id, { id, priority, close })

    // Return unregister function for cleanup
    return () => {
      modalsRef.current.delete(id)
    }
  }, [])

  const hasOpenModals = useCallback(() => {
    return modalsRef.current.size > 0
  }, [])

  const closeTopModal = useCallback(() => {
    const modals = Array.from(modalsRef.current.values())
    if (modals.length === 0) return false

    // Sort by priority descending, close the highest priority modal
    modals.sort((a, b) => b.priority - a.priority)
    const topModal = modals[0]
    topModal.close()
    return true
  }, [])

  const value: ModalContextValue = {
    registerModal,
    hasOpenModals,
    closeTopModal,
  }

  return (
    <ModalContext.Provider value={value}>
      {children}
    </ModalContext.Provider>
  )
}

/**
 * Hook to access modal registry functions.
 */
export function useModalRegistry() {
  const context = useContext(ModalContext)
  if (!context) {
    throw new Error('useModalRegistry must be used within a ModalProvider')
  }
  return context
}

/**
 * Hook to register a modal. Call this in your modal component.
 * The modal will be automatically unregistered when the component unmounts.
 *
 * @param isOpen - Whether the modal is currently open
 * @param onClose - Function to close the modal
 * @param priority - Higher priority modals are closed first (default: 0)
 *
 * @example
 * ```tsx
 * function MyDialog({ open, onClose }) {
 *   useRegisterModal(open, onClose)
 *   return <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>...</Dialog>
 * }
 * ```
 */
export function useRegisterModal(isOpen: boolean, onClose: () => void, priority = 0) {
  const { registerModal } = useModalRegistry()
  const idRef = useRef(`modal-${Math.random().toString(36).slice(2)}`)

  React.useEffect(() => {
    if (isOpen) {
      const unregister = registerModal(idRef.current, onClose, priority)
      return unregister
    }
  }, [isOpen, onClose, priority, registerModal])
}
