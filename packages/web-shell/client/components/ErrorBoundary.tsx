import { Component, type ErrorInfo, type ReactNode } from 'react';

type FallbackRender = (error: Error, reset: () => void) => ReactNode;

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Rendered in place of the children once one of them throws. A function form
   * receives the captured error and a `reset` callback that clears the error
   * and re-mounts the children (for an explicit "try again" affordance).
   */
  fallback: ReactNode | FallbackRender;
  /**
   * When any value here changes between renders, the boundary clears its error
   * state and retries. Pass the rendered content's identity (e.g. a message
   * object) so an edited/retried/streamed update recovers on its own instead of
   * staying stuck on the fallback. A stable broken child keeps the fallback and
   * never loops, since unchanged keys never trigger a reset.
   */
  resetKeys?: ReadonlyArray<unknown>;
  /** Identifies the boundary in console diagnostics. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKeys: ReadonlyArray<unknown>;
}

const EMPTY_KEYS: ReadonlyArray<unknown> = [];

function resetKeysChanged(
  prev: ReadonlyArray<unknown>,
  next: ReadonlyArray<unknown>,
): boolean {
  if (prev === next) return false;
  if (prev.length !== next.length) return true;
  return prev.some((value, index) => !Object.is(value, next[index]));
}

/**
 * Generic React error boundary. web-shell ships as an embeddable component, so
 * a throw in any one subtree (Markdown, KaTeX, Mermaid, a tool panel) must not
 * white-screen the host page. Wrap risky subtrees with this and supply a
 * graceful fallback.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    resetKeys: this.props.resetKeys ?? EMPTY_KEYS,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    const nextKeys = props.resetKeys ?? EMPTY_KEYS;
    if (resetKeysChanged(state.resetKeys, nextKeys)) {
      return { error: null, resetKeys: nextKeys };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[web-shell] ${this.props.label ?? 'render'} failed:`,
      error,
      info.componentStack,
    );
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === 'function'
      ? fallback(error, this.reset)
      : fallback;
  }
}
