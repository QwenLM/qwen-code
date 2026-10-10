import type { ManagedArtifactSave } from './managed-tool-result-types';

interface FilePickerHost {
  showSaveFilePicker(options: {
    suggestedName: string;
  }): Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
}

export function browserArtifactSave(): ManagedArtifactSave | undefined {
  if (
    typeof window === 'undefined' ||
    !('showSaveFilePicker' in window) ||
    typeof window.showSaveFilePicker !== 'function'
  ) {
    return undefined;
  }
  return async (artifact, { signal, openStream }) => {
    const file = await (window as unknown as FilePickerHost).showSaveFilePicker(
      {
        suggestedName: `${artifact.stream_role}-${artifact.id.replace(/[^\w-]/g, '_')}.log`,
      },
    );
    signal?.throwIfAborted();
    const writable = await file.createWritable();
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await openStream();
    } catch (error) {
      await writable.abort(error).catch(() => undefined);
      throw error;
    }
    await stream.pipeTo(writable, { signal });
  };
}
