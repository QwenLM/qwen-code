import { createContext, useContext, type ReactNode } from 'react';
import type { DaemonWorkspaceContextValue } from '../daemon/workspace/types.js';

/**
 * Provider-agnostic workspace facts for the shared composer. The daemon
 * host bridges its workspace context into this provider; hosts without a
 * daemon leave it undefined, which hides daemon-only composer integrations
 * exactly as the optional daemon hook did before.
 */
const ComposerWorkspaceContext = createContext<
  DaemonWorkspaceContextValue | undefined
>(undefined);

export function ComposerWorkspaceProvider({
  value,
  children,
}: {
  value: DaemonWorkspaceContextValue | undefined;
  children: ReactNode;
}) {
  return (
    <ComposerWorkspaceContext.Provider value={value}>
      {children}
    </ComposerWorkspaceContext.Provider>
  );
}

export function useOptionalComposerWorkspace():
  | DaemonWorkspaceContextValue
  | undefined {
  return useContext(ComposerWorkspaceContext);
}
