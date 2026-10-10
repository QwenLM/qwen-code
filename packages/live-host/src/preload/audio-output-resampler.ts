const FILTER_HALF_LENGTH = 16;
const FILTER_PHASES = 1024;

export class StreamingOutputResampler {
  private pending = new Float32Array(0);
  private pendingStart = 0;
  private inputLength = 0;
  private outputLength = 0;
  private finished = false;
  private readonly cutoff: number;
  private readonly radius: number;
  private readonly kernels = new Map<number, Float64Array>();

  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
  ) {
    this.cutoff = Math.min(1, outputRate / inputRate) * 0.94;
    this.radius = Math.ceil(FILTER_HALF_LENGTH / this.cutoff);
  }

  push(samples: Float32Array): Float32Array {
    if (this.finished) return new Float32Array(0);
    if (this.inputRate === this.outputRate) return samples;
    const pending = new Float32Array(this.pending.length + samples.length);
    pending.set(this.pending);
    pending.set(samples, this.pending.length);
    this.pending = pending;
    this.inputLength += samples.length;
    return this.render(false);
  }

  finish(): Float32Array {
    if (this.finished) return new Float32Array(0);
    this.finished = true;
    const output = this.render(true);
    this.pending = new Float32Array(0);
    this.kernels.clear();
    return output;
  }

  private render(final: boolean): Float32Array {
    // Only a terminal marker may pad future samples; chunks share filter state.
    const targetLength = final
      ? Math.round((this.inputLength * this.outputRate) / this.inputRate)
      : Math.max(
          0,
          Math.ceil(
            ((this.inputLength - this.radius) * this.outputRate) /
              this.inputRate,
          ),
        );
    const output = new Float32Array(targetLength - this.outputLength);
    for (let index = 0; index < output.length; index += 1) {
      const position = (this.outputLength * this.inputRate) / this.outputRate;
      const center = Math.floor(position);
      const phase = Math.round((position - center) * FILTER_PHASES);
      const kernel = this.kernel(phase);
      let value = 0;
      for (let tap = 0; tap < kernel.length; tap += 1) {
        const inputIndex = Math.max(
          0,
          Math.min(this.inputLength - 1, center + tap - this.radius),
        );
        value += this.pending[inputIndex - this.pendingStart] * kernel[tap];
      }
      output[index] = value;
      this.outputLength += 1;
    }
    const nextCenter = Math.floor(
      (this.outputLength * this.inputRate) / this.outputRate,
    );
    const discard = Math.max(0, nextCenter - this.radius - this.pendingStart);
    this.pending = this.pending.slice(discard);
    this.pendingStart += discard;
    return output;
  }

  private kernel(phase: number): Float64Array {
    const cached = this.kernels.get(phase);
    if (cached) return cached;
    const coefficients = new Float64Array(this.radius * 2 + 1);
    let sum = 0;
    for (let tap = 0; tap < coefficients.length; tap += 1) {
      const distance = tap - this.radius - phase / FILTER_PHASES;
      if (Math.abs(distance) > this.radius) continue;
      const angle = Math.PI * distance * this.cutoff;
      const sinc = angle === 0 ? 1 : Math.sin(angle) / angle;
      const window =
        0.42 +
        0.5 * Math.cos((Math.PI * distance) / this.radius) +
        0.08 * Math.cos((2 * Math.PI * distance) / this.radius);
      coefficients[tap] = this.cutoff * sinc * window;
      sum += coefficients[tap];
    }
    for (let tap = 0; tap < coefficients.length; tap += 1) {
      coefficients[tap] /= sum;
    }
    this.kernels.set(phase, coefficients);
    return coefficients;
  }
}
