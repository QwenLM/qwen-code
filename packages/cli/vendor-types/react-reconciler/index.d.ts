import type { ReactNode } from 'react';

interface HostConfig {
  [key: string]: any;
}

interface OpaqueRoot {
  [key: string]: any;
}

export interface Reconciler {
  createContainer(
    containerInfo: any,
    tag: number,
    hydrationCallbacks: any,
    isStrictMode: boolean,
    concurrentUpdatesByDefaultOverride: any,
    identifierPrefix: string,
    onUncaughtError: (error: any) => void,
    onCaughtError: (error: any) => void,
    onRecoverableError: (error: any) => void,
    transitionCallbacks: any,
  ): OpaqueRoot;
  updateContainer(
    element: ReactNode,
    container: OpaqueRoot,
    parentComponent: any,
    callback?: () => void,
  ): void;
  updateContainerSync(
    element: ReactNode,
    container: OpaqueRoot,
    parentComponent: any,
    callback?: () => void,
  ): void;
  flushSync<T>(fn: () => T): T;
  flushSyncWork(): void;
  flushSyncFromReconciler<T>(fn?: () => T): T | void;
  getPublicRootInstance(container: OpaqueRoot): any;
  injectIntoDevTools(devToolsConfig: any): void;
  discreteUpdates<A, B, C, D, R>(
    fn: (a: A, b: B, c: C, d: D) => R,
    a: A,
    b: B,
    c: C,
    d: D,
  ): R;
  discreteUpdates<A, B, C, R>(fn: (a: A, b: B, c: C) => R, a: A, b: B, c: C): R;
  discreteUpdates<A, B, R>(fn: (a: A, b: B) => R, a: A, b: B): R;
  discreteUpdates<A, R>(fn: (a: A) => R, a: A): R;
  discreteUpdates<R>(fn: () => R): R;
}

export default function createReconciler<
  Type = any,
  Props = any,
  Container = any,
  Instance = any,
  TextInstance = any,
  SuspenseInstance = any,
  HydratableInstance = any,
  PublicInstance = any,
  HostContext = any,
  UpdatePayload = any,
  ChildSet = any,
  TimeoutHandle = any,
  NoTimeout = any,
  TransitionStatus = any,
>(config: HostConfig): Reconciler;

export type FiberRoot = any;
export type Fiber = any;
