import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  McpAppGeneratedUiContext,
  McpAppGeneratedUiOwnerContext,
  McpAppHostContext,
  McpAppMessagesContext,
  McpAppSessionContext,
  McpAppToolsContext,
} from '../mcpAppHostContext';
import {
  GeneratedUiSummary,
  McpAppRuntime,
  type McpAppDisplay,
} from '../components/messages/McpApp';
import { Button } from '../components/ui/button';
import { useI18n } from '../i18n';
import { useWebShellPortalRoot } from '../portalRoot';
import {
  GeneratedUiInstanceStore,
  instanceKey,
  resourceKey,
  type InstanceSlot,
} from './instance-store';

const InstanceStoreContext = createContext<
  GeneratedUiInstanceStore | undefined
>(undefined);

export function GeneratedUiRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [store] = useState(() => new GeneratedUiInstanceStore());
  const portalRoot = useWebShellPortalRoot();
  const portalParkingCleanup = useRef<(() => void) | undefined>(undefined);
  const setParking = useCallback(
    (element: HTMLDivElement | null) => {
      element?.setAttribute('inert', '');
      store.parking = element ?? undefined;
    },
    [store],
  );
  const setPortalParking = useCallback(
    (element: HTMLDivElement | null) => {
      portalParkingCleanup.current?.();
      portalParkingCleanup.current = undefined;
      if (element) {
        element.setAttribute('inert', '');
        portalParkingCleanup.current = store.registerParking(element);
      }
    },
    [store],
  );
  const owner = useContext(McpAppGeneratedUiOwnerContext);
  const subscribeInvalidation = owner?.subscribeInvalidation;
  const entries = useSyncExternalStore(
    store.subscribe,
    store.getEntries,
    store.getEntries,
  );
  useLayoutEffect(
    () => subscribeInvalidation?.(store.invalidate),
    [store, subscribeInvalidation],
  );
  useLayoutEffect(() => () => store.clear(), [store]);
  return (
    <InstanceStoreContext.Provider value={store}>
      {children}
      <div
        hidden
        aria-hidden="true"
        data-generated-ui-parking
        ref={setParking}
      />
      {portalRoot &&
        createPortal(
          <div
            hidden
            aria-hidden="true"
            data-generated-ui-parking
            ref={setPortalParking}
          />,
          portalRoot,
        )}
      {entries.map((entry) =>
        createPortal(
          <McpAppHostContext.Provider value={entry.baseUrl}>
            <McpAppSessionContext.Provider value={entry.sessionId}>
              <McpAppToolsContext.Provider
                value={entry.canCallTool ? entry.tools : undefined}
              >
                <McpAppMessagesContext.Provider
                  value={entry.canMessage ? entry.messages : undefined}
                >
                  <McpAppRuntime
                    display={entry.display}
                    retained={entry.runtime}
                  />
                </McpAppMessagesContext.Provider>
              </McpAppToolsContext.Provider>
            </McpAppSessionContext.Provider>
          </McpAppHostContext.Provider>,
          entry.container,
          String(entry.id),
        ),
      )}
    </InstanceStoreContext.Provider>
  );
}

export function useGeneratedUiRetention() {
  return useContext(InstanceStoreContext);
}

export function GeneratedUiSlot({
  display,
  toolId,
  visible,
}: {
  display: McpAppDisplay;
  toolId: string;
  visible: boolean;
}) {
  const store = useContext(InstanceStoreContext)!;
  const { t } = useI18n();
  const source = useContext(McpAppGeneratedUiOwnerContext)?.source;
  const receipt = useContext(McpAppGeneratedUiContext);
  const sessionId = useContext(McpAppSessionContext);
  const baseUrl = useContext(McpAppHostContext);
  const tools = useContext(McpAppToolsContext);
  const messages = useContext(McpAppMessagesContext);
  const element = useRef<HTMLDivElement>(null);
  const token = useRef({}).current;
  const [ordinary, setOrdinary] = useState<{
    key: string;
    resourceKey: string;
  }>();
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const key = useMemo(
    () =>
      source && source.sessionId === sessionId
        ? instanceKey(source, toolId, display)
        : '',
    [source, sessionId, toolId, display],
  );
  const toolsMatch = !!sessionId && tools?.sessionId === sessionId;
  const messagesMatch = !!sessionId && messages?.sessionId === sessionId;
  const resource = useMemo(
    () =>
      resourceKey(display, source?.eventEpoch, {
        tools: toolsMatch,
        messages: messagesMatch,
      }),
    [display, source?.eventEpoch, toolsMatch, messagesMatch],
  );
  const ordinaryActive =
    visible && ordinary?.key === key && ordinary.resourceKey === resource;
  useLayoutEffect(() => {
    if (ordinary && !ordinaryActive) setOrdinary(undefined);
  }, [ordinary, ordinaryActive]);
  const input = useRef<InstanceSlot | undefined>(undefined);
  const open = () => {
    const slot = input.current;
    if (
      !slot ||
      !slot.element.isConnected ||
      !slot.source.captureOwner().isCurrent()
    )
      return;
    const previous = store.getRecord(slot.key)?.entry;
    if (previous?.token && previous.token !== slot.token) return;
    if (previous) store.dispose(slot.key, 'reset');
    if (!store.attach(slot, true))
      setOrdinary({ key: slot.key, resourceKey: slot.resourceKey });
  };
  input.current =
    source && receipt && baseUrl && key && receipt.sessionId === sessionId
      ? {
          source,
          receipt,
          baseUrl,
          tools,
          messages,
          key,
          resourceKey: resource,
          display,
          element: element.current!,
          token,
          visible,
          reset: open,
        }
      : undefined;
  useLayoutEffect(() => {
    const slot = input.current;
    if (slot && element.current) {
      slot.element = element.current;
      if (!ordinaryActive) store.attach(slot);
    }
    return () => store.release(key, token);
  }, [store, key, resource, ordinaryActive, token]);
  useLayoutEffect(() => {
    const slot = input.current;
    if (slot && element.current) {
      slot.element = element.current;
      // The first attach can be refused while the owner snapshot is stale,
      // which happens during a live turn. Retry until the card first attaches;
      // a card whose instance was later released still needs an explicit open.
      if (!ordinaryActive && !store.getRecord(slot.key)) store.attach(slot);
      else store.update(slot);
    }
  });
  const entry = store.getRecord(key)?.entry;
  const elsewhere = !!entry?.token && entry.token !== token;
  const attached = entry?.token === token;
  return (
    <div ref={element} data-generated-ui-slot>
      {ordinaryActive && key ? (
        <>
          <p className="p-3 text-sm text-muted-foreground">
            {t('mcpApp.generatedUi.reopenNotice')}
          </p>
          <McpAppRuntime display={display} />
        </>
      ) : !attached ? (
        <div className="p-3 text-sm text-muted-foreground">
          <div className="whitespace-pre-wrap">
            <GeneratedUiSummary display={display} />
          </div>
          <p>
            {t(
              elsewhere
                ? 'mcpApp.generatedUi.openElsewhere'
                : 'mcpApp.generatedUi.reopenNotice',
            )}
          </p>
          {!elsewhere && (
            <Button
              variant="outline"
              size="sm"
              onClick={open}
              disabled={!input.current}
            >
              {t('mcpApp.generatedUi.reopen')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
