import { createContext, useContext } from 'react';

export const WebShellPortalRootContext = createContext<HTMLElement | null>(
  null,
);

export function useWebShellPortalRoot(): HTMLElement | null {
  return useContext(WebShellPortalRootContext);
}
