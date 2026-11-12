/**
 * Type-level pins for the QR-login identity contract: the tab's own client id is
 * not a per-call argument on anything the channels hook publishes.
 *
 * `tsc` is the runner — this file is never imported and never executed. Each
 * directive below turns into TS2578 ("Unused '@ts-expect-error' directive") the
 * moment one of these surfaces advertises the wider contract again. The types
 * are derived from the real hook return value and the real props, so widening
 * any one of them is caught here rather than only at the interface.
 *
 * The name deliberately avoids `*.test.ts`: this package's tsconfig excludes
 * test files from typechecking, which would make these pins inert.
 */
import type { useDaemonChannels } from '../../daemon/workspace/hooks/useDaemonChannels';
import type { ChannelEditorDialogProps } from './ChannelEditorDialog';
import type { ChannelQrLoginProps } from './ChannelQrLogin';

declare const hook: ReturnType<typeof useDaemonChannels>['qrLogin'];
declare const panel: ChannelQrLoginProps;
declare const editor: ChannelEditorDialogProps;

// @ts-expect-error a per-call client id must not be expressible
void hook.start('bot', 'peer-tab');
// @ts-expect-error a per-call client id must not be expressible
void hook.state('login-1', 'peer-tab');
// @ts-expect-error a per-call client id must not be expressible
void hook.cancel('login-1', 'peer-tab');
// @ts-expect-error a per-call client id must not be expressible
void hook.release('login-1', 'peer-tab');
// @ts-expect-error a per-call workspace must not be expressible either
void hook.release('login-1', 'peer-tab', '/workspace-x');

// The props that carry the handlers to the UI must not re-widen them.
// @ts-expect-error the panel cannot attribute a login per call
void panel.actions.start('bot', 'peer-tab');
// @ts-expect-error the editor cannot attribute a login per call
void editor.qrLoginActions?.state('login-1', 'peer-tab');
