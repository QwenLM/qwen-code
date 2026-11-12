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

// The options-bag encoding has to be pinned too: a bare string would still be
// rejected by `(name, options?: { clientId?: string })`, so a positional-only
// pin would stay silent while a per-call id became expressible again.
// @ts-expect-error a per-call client id must not be expressible as an option
void hook.start('bot', { clientId: 'peer-tab' });
// @ts-expect-error a per-call client id must not be expressible as an option
void hook.state('login-1', { clientId: 'peer-tab' });
// @ts-expect-error a per-call client id must not be expressible as an option
void hook.cancel('login-1', { clientId: 'peer-tab' });
// @ts-expect-error neither identity nor workspace may arrive as an option
void hook.release('login-1', {
  clientId: 'peer-tab',
  workspaceCwd: '/workspace-x',
});

// The props that carry the handlers to the UI must not re-widen them.
// @ts-expect-error the panel cannot attribute a login per call
void panel.actions.start('bot', 'peer-tab');
// @ts-expect-error the panel cannot attribute a login per call via an option
void panel.actions.start('bot', { clientId: 'peer-tab' });
// @ts-expect-error the editor cannot attribute a login per call
void editor.qrLoginActions?.state('login-1', 'peer-tab');
// @ts-expect-error the editor cannot attribute a login per call via an option
void editor.qrLoginActions?.state('login-1', { clientId: 'peer-tab' });
