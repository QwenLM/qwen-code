import { base64ToBlob } from './base64.js';

type DownloadBridge = {
  postMessage(message: string | ArrayBuffer): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
};

const MAX_NATIVE_SIZE = 16 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
let saving = false;

function nativeBridge(): DownloadBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as { qwenAndroidDownloadV1?: DownloadBridge })
    .qwenAndroidDownloadV1;
  return bridge && typeof bridge.postMessage === 'function'
    ? bridge
    : undefined;
}

export async function saveBlob(
  blob: Blob,
  filename: string,
  isCancelled?: () => boolean,
): Promise<void> {
  const checkCurrent = () => {
    if (isCancelled?.())
      throw new Error('The download source is no longer active.');
  };
  checkCurrent();
  const bridge = nativeBridge();
  if (!bridge) {
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.addEventListener('click', (event) => event.stopPropagation());
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return;
  }
  if (blob.size > MAX_NATIVE_SIZE) {
    throw new Error(
      'Android downloads are limited to 16 MiB. Use a browser for this file.',
    );
  }
  if (saving) throw new Error('Another download is still active.');
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  const command = (op: string) => JSON.stringify({ v: 1, id, op });
  let failure: Error | undefined;
  let cancelled = false;
  let pending:
    | {
        state: string;
        offset?: number;
        resolve: (cancelled: boolean) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: Error) => {
    failure = error;
    pending?.reject(error);
  };
  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    let response: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!parsed || typeof parsed !== 'object') return;
      response = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (response['v'] !== 1 || response['id'] !== id) return;
    if (response['state'] === 'error') {
      fail(
        new Error(
          typeof response['error'] === 'string'
            ? response['error']
            : 'Could not save the download.',
        ),
      );
      return;
    } else if (response['state'] === 'cancelled') {
      cancelled = true;
      pending?.resolve(true);
      return;
    }
    if (!pending) return;
    if (response['state'] === 'choosing' && pending.state === 'saved') {
      clearTimeout(timer);
      return;
    }
    if (
      response['state'] === pending.state &&
      (pending.offset === undefined || response['offset'] === pending.offset)
    ) {
      pending.resolve(false);
    } else {
      fail(new Error('Invalid native download acknowledgement.'));
    }
  };
  const send = async (
    message: string | ArrayBuffer,
    state: string,
    offset?: number,
  ) => {
    checkCurrent();
    if (failure) throw failure;
    if (cancelled) return true;
    try {
      return await new Promise<boolean>((resolve, reject) => {
        pending = { state, offset, resolve, reject };
        timer = setTimeout(
          () => fail(new Error('Download transfer timed out. Please retry.')),
          30_000,
        );
        bridge.postMessage(message);
      });
    } finally {
      clearTimeout(timer);
      pending = undefined;
    }
  };
  saving = true;
  const cancellation = isCancelled
    ? setInterval(() => {
        try {
          checkCurrent();
        } catch (error) {
          fail(
            error instanceof Error ? error : new Error('Download cancelled.'),
          );
        }
      }, 250)
    : undefined;
  try {
    bridge.addEventListener('message', onMessage);
    if (
      await send(
        JSON.stringify({
          v: 1,
          id,
          op: 'begin',
          name: Array.from(filename).slice(0, 255).join(''),
          mime: blob.type.slice(0, 127),
          size: blob.size,
        }),
        'ready',
      )
    )
      return;
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
      checkCurrent();
      const chunk = await blob.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      const frame = new Uint8Array(36 + chunk.byteLength);
      frame.set(new TextEncoder().encode(id));
      new DataView(frame.buffer).setUint32(32, offset);
      frame.set(new Uint8Array(chunk), 36);
      if (await send(frame.buffer, 'chunk', offset + chunk.byteLength)) return;
    }
    await send(command('finish'), 'saved');
  } catch (error) {
    try {
      bridge.postMessage(command('cancel'));
    } catch {
      /* The document may have gone away. */
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(cancellation);
    saving = false;
    bridge.removeEventListener('message', onMessage);
  }
}

export function handleNativeDownload(
  event: { currentTarget: HTMLAnchorElement; preventDefault(): void },
  onError: (error: unknown) => void,
  isCancelled?: () => boolean,
  data?: Blob,
): void {
  if (!nativeBridge()) return;
  event.preventDefault();
  const { href, download } = event.currentTarget;
  void (async () => {
    if (data) {
      await saveBlob(data, download || 'download', isCancelled);
      return;
    }
    if (!href.startsWith('blob:') && !href.startsWith('data:')) {
      throw new Error('Open this remote download in a browser to save it.');
    }
    if (href.startsWith('data:')) {
      const comma = href.indexOf(',');
      if (comma < 0) throw new Error('Invalid download data.');
      const header = href.slice(5, comma);
      const content = href.slice(comma + 1);
      if (content.length > MAX_NATIVE_SIZE * 4)
        throw new Error(
          'Android downloads are limited to 16 MiB. Use a browser for this file.',
        );
      const type = header.split(';')[0] || 'text/plain';
      const blob = /;base64$/i.test(header)
        ? base64ToBlob(content, type)
        : new Blob([decodeURIComponent(content)], { type });
      await saveBlob(blob, download || 'download', isCancelled);
      return;
    }
    throw new Error(
      'The original download data is unavailable. Reopen the file or save it in a browser.',
    );
  })().catch((error: unknown) => {
    if (!isCancelled?.()) onError(error);
  });
}
