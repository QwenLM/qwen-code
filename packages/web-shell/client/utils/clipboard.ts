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
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission may be denied or the write may transiently fail; try the
      // legacy user-gesture path before giving up.
    }
  }

  if (copyViaExecCommand(text)) {
    return;
  }

  throw new Error(
    'Clipboard is not available. Open the page in a secure context (HTTPS or http://localhost) or copy the text manually.',
  );
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
  document.body.appendChild(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
