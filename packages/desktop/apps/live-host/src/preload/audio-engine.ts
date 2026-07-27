import { ipcRenderer } from 'electron';
import { CaptureRecoveryPolicy } from './capture-recovery-policy.ts';

const OUTPUT_SAMPLE_RATE = 24_000;
const MAX_QUEUED_OUTPUT_SECONDS = 10;

type AudioSelfCheck = {
  audioInput: boolean;
  audioOutput: boolean;
  inputError?: string;
  outputError?: string;
};

function errorCode(error: unknown): string {
  if (error instanceof DOMException && error.name) return error.name;
  return 'audio_unavailable';
}

export class HostAudioEngine {
  private captureContext: AudioContext | undefined;
  private captureStream: MediaStream | undefined;
  private captureNode: AudioWorkletNode | undefined;
  private outputContext: AudioContext | undefined;
  private outputSources = new Set<AudioBufferSourceNode>();
  private outputCursor = 0;
  private outputGeneration = 0;
  private outputMuted = false;
  private captureRequested = false;
  private inputMuted = false;
  private captureEpoch: number | undefined;
  private captureGeneration = 0;
  private captureRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly captureRecoveryPolicy = new CaptureRecoveryPolicy();
  private mediaDeviceListenerInstalled = false;
  private microphoneAllowed = false;

  private readonly handleDeviceChange = (): void => {
    if (this.captureRequested && this.inputMuted) return;
    if (this.captureRequested && this.captureStream) {
      this.scheduleCaptureRecovery();
      return;
    }
    ipcRenderer.send('live:audio:capture-error', {
      code: 'audio_input_device_changed',
    });
    void this.initialize(this.microphoneAllowed);
  };

  async initialize(microphoneAllowed: boolean): Promise<void> {
    this.microphoneAllowed = microphoneAllowed;
    this.installMediaDeviceListener();
    const result: AudioSelfCheck = {
      audioInput: false,
      audioOutput: false,
    };
    try {
      await this.checkOutput();
      result.audioOutput = true;
    } catch (error) {
      result.outputError = errorCode(error);
    }

    if (microphoneAllowed) {
      try {
        await this.checkInput();
        result.audioInput = true;
      } catch (error) {
        result.inputError = errorCode(error);
      }
    }
    ipcRenderer.send('live:audio:self-check', result);
  }

  async setCapture(
    enabled: boolean,
    muted: boolean,
    epoch?: number,
  ): Promise<void> {
    if (
      enabled &&
      !muted &&
      (epoch === undefined || !Number.isSafeInteger(epoch) || epoch < 0)
    ) {
      throw new Error('audio_epoch_unavailable');
    }
    const epochChanged = this.captureEpoch !== epoch;
    this.captureRequested = enabled;
    this.inputMuted = muted;
    this.captureEpoch = epoch;
    if (!enabled || muted) {
      this.cancelCaptureRecovery();
      await this.stopCapture();
      return;
    }
    if (epochChanged && this.captureContext) await this.stopCapture();
    await this.startCapture();
  }

  setOutputMuted(muted: boolean): void {
    this.outputMuted = muted;
    if (muted) this.clearOutput();
  }

  async play(frame: Uint8Array): Promise<void> {
    if (
      this.outputMuted ||
      frame.byteLength === 0 ||
      frame.byteLength % 2 !== 0
    ) {
      return;
    }
    const generation = this.outputGeneration;
    const context = await this.ensureOutputContext();
    if (generation !== this.outputGeneration || this.outputMuted) return;
    const queuedSeconds = Math.max(0, this.outputCursor - context.currentTime);
    if (queuedSeconds >= MAX_QUEUED_OUTPUT_SECONDS) this.clearOutput();

    const samples = frame.byteLength / 2;
    const audioBuffer = context.createBuffer(1, samples, OUTPUT_SAMPLE_RATE);
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    for (let index = 0; index < samples; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 0x8000;
    }

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    source.onended = () => this.outputSources.delete(source);
    this.outputSources.add(source);
    const startAt = Math.max(context.currentTime + 0.01, this.outputCursor);
    source.start(startAt);
    this.outputCursor = startAt + audioBuffer.duration;
  }

  clearOutput(): void {
    this.outputGeneration += 1;
    for (const source of this.outputSources) {
      try {
        source.stop();
      } catch {
        // A source that ended between iteration and stop is already clear.
      }
    }
    this.outputSources.clear();
    this.outputCursor = this.outputContext?.currentTime ?? 0;
  }

  async dispose(): Promise<void> {
    this.clearOutput();
    this.captureRequested = false;
    this.captureEpoch = undefined;
    this.cancelCaptureRecovery();
    await this.stopCapture();
    await this.outputContext?.close();
    this.outputContext = undefined;
    if (this.mediaDeviceListenerInstalled) {
      navigator.mediaDevices.removeEventListener(
        'devicechange',
        this.handleDeviceChange,
      );
      this.mediaDeviceListenerInstalled = false;
    }
  }

  private async checkInput(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const context = new AudioContext({ latencyHint: 'interactive' });
    let worklet: AudioWorkletNode | undefined;
    try {
      if (
        !stream.getAudioTracks().some((track) => track.readyState === 'live')
      ) {
        throw new Error('audio_input_unavailable');
      }
      await context.audioWorklet.addModule(
        new URL('./audio-input-worklet.js', window.location.href).href,
      );
      const source = context.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(context, 'qwen-pcm16-input', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silent);
      silent.connect(context.destination);
      if (context.state === 'suspended') await context.resume();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('audio_input_timeout')),
          2_000,
        );
        worklet!.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
          if (event.data.byteLength !== 640) return;
          clearTimeout(timeout);
          resolve();
        };
      });
    } finally {
      worklet?.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => undefined);
    }
  }

  private async checkOutput(): Promise<void> {
    const context = await this.ensureOutputContext();
    const buffer = context.createBuffer(1, 1, OUTPUT_SAMPLE_RATE);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        source.stop();
        reject(new Error('audio_output_timeout'));
      }, 2_000);
      source.onended = () => {
        clearTimeout(timeout);
        resolve();
      };
      source.start();
    });
  }

  private async ensureOutputContext(): Promise<AudioContext> {
    const context =
      this.outputContext ??
      new AudioContext({
        latencyHint: 'interactive',
        sampleRate: OUTPUT_SAMPLE_RATE,
      });
    this.outputContext = context;
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running')
      throw new Error('audio_output_unavailable');
    return context;
  }

  private async startCapture(): Promise<void> {
    const epoch = this.captureEpoch;
    if (
      this.captureContext ||
      !this.captureRequested ||
      this.inputMuted ||
      epoch === undefined
    )
      return;
    const generation = ++this.captureGeneration;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (
      generation !== this.captureGeneration ||
      !this.captureRequested ||
      this.inputMuted ||
      this.captureEpoch !== epoch
    ) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const context = new AudioContext({ latencyHint: 'interactive' });
    try {
      await context.audioWorklet.addModule(
        new URL('./audio-input-worklet.js', window.location.href).href,
      );
      if (
        generation !== this.captureGeneration ||
        !this.captureRequested ||
        this.inputMuted ||
        this.captureEpoch !== epoch
      ) {
        for (const track of stream.getTracks()) track.stop();
        await context.close();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, 'qwen-pcm16-input', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silent);
      silent.connect(context.destination);
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (
          !this.inputMuted &&
          this.captureRequested &&
          this.captureEpoch === epoch &&
          event.data.byteLength > 0
        ) {
          ipcRenderer.send('live:audio:input', {
            epoch,
            pcm16: new Uint8Array(event.data),
          });
        }
      };
      this.captureStream = stream;
      this.captureContext = context;
      this.captureNode = worklet;
      for (const track of stream.getAudioTracks()) {
        const handleUnavailable = (): void => {
          if (generation === this.captureGeneration) {
            this.scheduleCaptureRecovery();
          }
        };
        track.addEventListener('ended', handleUnavailable, { once: true });
        track.addEventListener('mute', handleUnavailable, { once: true });
      }
      if (context.state === 'suspended') await context.resume();
      this.captureRecoveryPolicy.reset();
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  private async stopCapture(): Promise<void> {
    this.captureGeneration += 1;
    const node = this.captureNode;
    const stream = this.captureStream;
    const context = this.captureContext;
    this.captureNode = undefined;
    this.captureStream = undefined;
    this.captureContext = undefined;
    node?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    await context?.close().catch(() => undefined);
  }

  private installMediaDeviceListener(): void {
    if (this.mediaDeviceListenerInstalled) return;
    navigator.mediaDevices.addEventListener(
      'devicechange',
      this.handleDeviceChange,
    );
    this.mediaDeviceListenerInstalled = true;
  }

  private scheduleCaptureRecovery(): void {
    if (
      !this.captureRequested ||
      this.inputMuted ||
      this.captureRecoveryTimer
    ) {
      return;
    }
    const delay = this.captureRecoveryPolicy.nextDelayMs();
    if (delay === undefined) {
      this.captureRequested = false;
      ipcRenderer.send('live:audio:capture-error', {
        code: 'audio_input_recovery_exhausted',
      });
      void this.stopCapture();
      return;
    }

    void this.stopCapture();
    this.captureRecoveryTimer = setTimeout(() => {
      this.captureRecoveryTimer = undefined;
      if (!this.captureRequested || this.inputMuted) return;
      void this.startCapture().catch(() => this.scheduleCaptureRecovery());
    }, delay);
  }

  private cancelCaptureRecovery(): void {
    if (this.captureRecoveryTimer) clearTimeout(this.captureRecoveryTimer);
    this.captureRecoveryTimer = undefined;
    this.captureRecoveryPolicy.reset();
  }
}
