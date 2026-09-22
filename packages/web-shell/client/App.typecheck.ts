import type { WebShellProps } from './App';
import type { TurnOutputOpenRequest } from './components/artifacts/TurnOutputs';

type Assert<T extends true> = T;
type OpenHandler = NonNullable<WebShellProps['onRightPanelOpen']>;

// Included by the package typecheck; legacy asynchronous handlers still claim
// ownership immediately, without waiting for their Promise to settle.
export type SyncVoidHandler = Assert<
  ((request: TurnOutputOpenRequest) => void) extends OpenHandler ? true : false
>;
export type AsyncVoidHandler = Assert<
  ((request: TurnOutputOpenRequest) => Promise<void>) extends OpenHandler
    ? true
    : false
>;
export type SelectiveHandler = Assert<
  ((request: TurnOutputOpenRequest) => boolean) extends OpenHandler
    ? true
    : false
>;
