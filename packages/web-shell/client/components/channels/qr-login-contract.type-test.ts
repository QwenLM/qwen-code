/**
 * Type-level pins for the QR-login identity contract: the tab's own client id is
 * not a per-call argument on anything the channels hook publishes.
 *
 * `tsc` is the runner — this file is never imported and never executed. Each
 * surface is asserted to be *exactly* the narrow handler contract, so any
 * widening, renaming or optionality change fails the build regardless of which
 * encoding it uses. Sampling call shapes with `@ts-expect-error` cannot do that:
 * a suppression keeps swallowing an unrelated error (a renamed member, an
 * excess property) and goes silent about the thing it names.
 *
 * The positive controls below exist so a rename reds the build instead of
 * leaving the identity assertions comparing two types that no longer describe
 * the published members.
 *
 * The name deliberately avoids `*.test.ts`: this package's tsconfig excludes
 * test files from typechecking, which would make these pins inert.
 */
import type { useDaemonChannels } from '../../daemon/workspace/hooks/useDaemonChannels';
import type { DaemonChannelQrLoginHandlers } from '../../daemon/workspace/types';
import type { ChannelEditorDialogProps } from './ChannelEditorDialog';
import type { ChannelQrLoginProps } from './ChannelQrLogin';

// Mutual assignability is not identity: a function with an extra *optional*
// parameter is assignable in both directions, so `extends` both ways would
// accept exactly the widening these pins exist to reject.
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

type HookQrLogin = ReturnType<typeof useDaemonChannels>['qrLogin'];

export type HookIdentity = Assert<
  Identical<HookQrLogin, DaemonChannelQrLoginHandlers>
>;
export type PanelIdentity = Assert<
  Identical<ChannelQrLoginProps['actions'], DaemonChannelQrLoginHandlers>
>;
export type EditorIdentity = Assert<
  Identical<
    NonNullable<ChannelEditorDialogProps['qrLoginActions']>,
    DaemonChannelQrLoginHandlers
  >
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
