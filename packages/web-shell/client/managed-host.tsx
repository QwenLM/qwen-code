import { createRoot } from 'react-dom/client';
import {
  ManagedAgentWebShell,
  type ManagedAgentWebShellProps,
} from './ManagedAgentWebShell';

export type { ManagedAgentWebShellProps } from './ManagedAgentWebShell';
export type { ManagedAgentProvider } from './components/managed/managed-agent-provider';

export function renderManagedAgentWebShell(
  container: Element,
  props: ManagedAgentWebShellProps,
): {
  update(nextProps: ManagedAgentWebShellProps): void;
  unmount(): void;
} {
  const root = createRoot(container);
  const update = (nextProps: ManagedAgentWebShellProps) => {
    root.render(<ManagedAgentWebShell {...nextProps} />);
  };
  update(props);
  return {
    update,
    unmount() {
      root.unmount();
    },
  };
}
