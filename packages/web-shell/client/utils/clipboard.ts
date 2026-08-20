/**
 * Clipboard write helper with a fallback for non-secure contexts.
 *
 * The async Clipboard API (`navigator.clipboard`) is only exposed in secure
 * contexts (HTTPS or loopback). The daemon serves the Web Shell over plain
 * HTTP, so opening it through a non-loopback address (e.g.
 * `http://10.x.x.x:4170`) leaves `navigator.clipboard` undefined and every
 * copy entry point used to fail. Fall back to the legacy
 * `document.execCommand('copy')` path so copying keeps working there.
 * See https://github.com/QwenLM/qwen-code/issues/9485.
 *
 * Known edge: in a secure context where clipboard-write permission has never
 * been decided, `writeText` only settles when the user answers the permission
 * prompt. If they block it after several seconds, the transient user
 * activation that `execCommand('copy')` needs may already have expired, so
 * the fallback can still fail. The `denied` short-circuit below covers the
 * common repeat-visit case; the first-copy prompt case is accepted.
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    if ((await queryClipboardWritePermission()) !== 'denied') {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Permission may be denied or the write may transiently fail; try
        // the legacy user-gesture path before giving up.
      }
    }
  }

  if (copyViaExecCommand(text)) {
    return;
  }

  throw new Error(
    'Clipboard is not available. Open the page in a secure context (HTTPS or http://localhost) or copy the text manually.',
  );
}

async function queryClipboardWritePermission(): Promise<
  PermissionState | undefined
> {
  try {
    const status = await navigator.permissions.query({
      name: 'clipboard-write' as PermissionName,
    });
    return status.state;
  } catch {
    return undefined;
  }
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep the element invisible and avoid any page jump while selecting.
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.setAttribute('readonly', '');
  // Append inside the enclosing Radix layer when the copy button lives in a
  // dialog or popover: a body-appended textarea sits outside the FocusScope /
  // DismissableLayer, so the scope refocuses the button during select() and
  // execCommand copies nothing, or the focusin dismisses a popover mid-copy.
  const layerContainer =
    document.activeElement?.closest(
      '[role="dialog"], [data-radix-popper-content-wrapper]',
    ) ?? document.body;
  layerContainer.appendChild(textarea);
  const previousFocus = document.activeElement;

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    layerContainer.removeChild(textarea);
    if (previousFocus instanceof HTMLElement) {
      previousFocus.focus();
    }
  }
}
