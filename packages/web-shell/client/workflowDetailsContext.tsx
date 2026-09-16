import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';

interface WorkflowDetailsContextValue {
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[];
}

const WorkflowDetailsContext = createContext<
  WorkflowDetailsContextValue | undefined
>(undefined);

export function WorkflowDetailsProvider({
  tasks,
  children,
}: {
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[];
  children: ReactNode;
}) {
  const value = useMemo(() => ({ tasks }), [tasks]);
  return (
    <WorkflowDetailsContext.Provider value={value}>
      {children}
    </WorkflowDetailsContext.Provider>
  );
}

export function useWorkflowDetails(): WorkflowDetailsContextValue | undefined {
  return useContext(WorkflowDetailsContext);
}
