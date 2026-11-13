/**
 * Type-level pins for the QR-login identity contract: the tab's own client id is
 * not a per-call argument on anything the channels hook publishes.
 *
 * `tsc` is the runner — this file is never imported and never executed. Three
 * layers, because no single one is sufficient:
 *
 * 1. Identity: every published surface must be exactly the narrow handler type,
 *    so re-declaring a prop or the hook's return to something wider fails here.
 * 2. Arity of the contract itself: adding an *optional* parameter leaves the
 *    object types identical to the checker, so the contract's argument counts
 *    and first arguments are pinned too. An optional member makes the inferred
 *    tuple's length `1 | 2`.
 * 3. Positive controls: real calls, so renaming a member reds the build instead
 *    of leaving the assertions comparing types that no longer describe it.
 *
 * Sampling call shapes with `@ts-expect-error` cannot do any of this: a
 * suppression keeps swallowing an unrelated error (a renamed member, an excess
 * property) and goes silent about the thing it names.
 *
 * The collectors below are deliberately not generic: an indexed access into a
 * conditionally inferred tuple stays deferred inside a generic alias, so the
 * comparison would never resolve to a concrete tuple.
 *
 * The name avoids `*.test.ts`: this package's tsconfig excludes test files from
 * typechecking, which would make these pins inert.
 */
import type { useDaemonChannels } from '../../daemon/workspace/hooks/useDaemonChannels';
import type { DaemonChannelQrLoginHandlers } from '../../daemon/workspace/types';
import type { ChannelEditorDialogProps } from './ChannelEditorDialog';
import type { ChannelQrLoginProps } from './ChannelQrLogin';

// Mutual assignability is not identity: a function with an extra optional
// parameter is assignable in both directions.
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type Args<F> = F extends (...args: infer A) => unknown ? A : never;

type HookQrLogin = ReturnType<typeof useDaemonChannels>['qrLogin'];
type PanelQrLogin = ChannelQrLoginProps['actions'];
type EditorQrLogin = NonNullable<ChannelEditorDialogProps['qrLoginActions']>;

export type HookIdentity = Assert<
  Identical<HookQrLogin, DaemonChannelQrLoginHandlers>
>;
export type PanelIdentity = Assert<
  Identical<PanelQrLogin, DaemonChannelQrLoginHandlers>
>;
export type EditorIdentity = Assert<
  Identical<EditorQrLogin, DaemonChannelQrLoginHandlers>
>;

// Length and first argument are compared separately because tuple labels
// (`name` vs `loginId`) are part of tuple identity and are not what this pins.
type ContractLengths = [
  Args<DaemonChannelQrLoginHandlers['start']>['length'],
  Args<DaemonChannelQrLoginHandlers['state']>['length'],
  Args<DaemonChannelQrLoginHandlers['cancel']>['length'],
  Args<DaemonChannelQrLoginHandlers['release']>['length'],
];
type ContractFirsts = [
  Args<DaemonChannelQrLoginHandlers['start']>[0],
  Args<DaemonChannelQrLoginHandlers['state']>[0],
  Args<DaemonChannelQrLoginHandlers['cancel']>[0],
  Args<DaemonChannelQrLoginHandlers['release']>[0],
];

export type ContractArities = Assert<Identical<ContractLengths, [1, 1, 1, 1]>>;
export type ContractFirstArgs = Assert<
  Identical<ContractFirsts, [string, string, string, string]>
>;

declare const hook: HookQrLogin;
declare const panel: ChannelQrLoginProps;
declare const editor: ChannelEditorDialogProps;

void hook.start('bot');
void hook.state('login-1');
void hook.cancel('login-1');
void hook.release('login-1');
void panel.actions.start('bot');
void editor.qrLoginActions?.state('login-1');
