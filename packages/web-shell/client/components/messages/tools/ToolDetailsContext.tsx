import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { isShellResultDisplay } from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../../../adapters/types';
import { isActiveToolStatus } from '../toolFormatting';
import { useI18n } from '../../../i18n';

export type ToolDetailsLoader = (
  callId: string,
  signal: AbortSignal,
) => Promise<Pick<ACPToolCall, 'args' | 'rawOutput'>>;

export const ToolDetailsContext = createContext<ToolDetailsLoader | undefined>(
  undefined,
);

export function useToolDetails(tool: ACPToolCall, expanded: boolean) {
  const load = useContext(ToolDetailsContext);
  const [loaded, setLoaded] = useState<{
    load: ToolDetailsLoader;
    callId: string;
    status: ACPToolCall['status'];
    revision?: number;
    details?: Pick<ACPToolCall, 'args' | 'rawOutput'>;
  }>();
  const {
    callId,
    status,
    args,
    rawOutput,
    toolDetailsRevision: revision,
  } = tool;
  const needed =
    Boolean(load) &&
    expanded &&
    !isActiveToolStatus(status) &&
    (args === undefined || rawOutput === undefined);
  useEffect(() => {
    if (
      !load ||
      !expanded ||
      isActiveToolStatus(status) ||
      (args !== undefined && rawOutput !== undefined)
    )
      return;
    const abort = new AbortController();
    const identity = { load, callId, status, revision };
    void load(callId, abort.signal)
      .then((details) => {
        if (!abort.signal.aborted) setLoaded({ ...identity, details });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoaded({ ...identity });
      });
    return () => abort.abort();
  }, [load, expanded, callId, status, args, rawOutput, revision]);
  const current =
    loaded &&
    loaded.load === load &&
    loaded.callId === callId &&
    loaded.status === status &&
    loaded.revision === revision
      ? loaded
      : undefined;
  return {
    tool: current?.details
      ? {
          ...tool,
          args: args ?? current.details.args,
          rawOutput: isShellResultDisplay(current.details.rawOutput)
            ? current.details.rawOutput
            : (rawOutput ?? current.details.rawOutput),
        }
      : tool,
    loading: needed && current === undefined,
  };
}

export function ToolDetails({
  tool,
  enabled,
  children,
}: {
  tool: ACPToolCall;
  enabled: boolean;
  children: (tool: ACPToolCall) => ReactNode;
}) {
  const { t } = useI18n();
  const detail = useToolDetails(tool, enabled);
  if (detail.loading) return <p role="status">{t('managed.loading')}</p>;
  return <>{children(detail.tool)}</>;
}
