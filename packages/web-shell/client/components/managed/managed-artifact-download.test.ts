// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserArtifactSave } from './managed-artifact-download';
import { artifact } from './managed-tool-result.test-fixtures';

afterEach(() => {
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

describe('browser artifact saving', () => {
  it('opens the picker in the click turn before requesting any authenticated bytes', async () => {
    const write = vi.fn();
    const close = vi.fn();
    const openStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
          },
        }),
    );
    let choose: (file: {
      createWritable: () => Promise<WritableStream<Uint8Array>>;
    }) => void = () => undefined;
    const picker = vi.fn(
      () =>
        new Promise<{
          createWritable: () => Promise<WritableStream<Uint8Array>>;
        }>((resolve) => {
          choose = resolve;
        }),
    );
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
    const saving = browserArtifactSave()!(artifact, { openStream });
    expect(picker).toHaveBeenCalledOnce();
    expect(openStream).not.toHaveBeenCalled();
    choose({
      createWritable: async () => new WritableStream({ write, close }),
    });
    await saving;
    expect(openStream).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      new Uint8Array([1, 2]),
      expect.anything(),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('aborts the selected file when opening the authenticated stream fails', async () => {
    const abort = vi.fn();
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => new WritableStream({ abort }),
      }),
    });
    const failure = new Error('authorization revoked');
    await expect(
      browserArtifactSave()!(artifact, {
        openStream: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(abort).toHaveBeenCalledWith(failure);
  });
});
