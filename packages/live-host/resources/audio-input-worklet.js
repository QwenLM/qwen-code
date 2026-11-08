class QwenPcm16InputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.cursor = 0;
    this.output = [];
    this.ratio = sampleRate / 16000;
  }

  process(inputs, outputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;
    const output = outputs[0]?.[0];
    if (output) output.set(channel.subarray(0, output.length));
    for (let index = 0; index < channel.length; index += 1) {
      this.pending.push(channel[index]);
    }

    while (this.cursor + this.ratio <= this.pending.length) {
      let value;
      if (this.ratio >= 1) {
        const start = Math.floor(this.cursor);
        const end = Math.max(start + 1, Math.floor(this.cursor + this.ratio));
        let sum = 0;
        for (let index = start; index < end; index += 1)
          sum += this.pending[index];
        value = sum / (end - start);
      } else {
        const start = Math.floor(this.cursor);
        const fraction = this.cursor - start;
        const next = Math.min(start + 1, this.pending.length - 1);
        value =
          this.pending[start] * (1 - fraction) + this.pending[next] * fraction;
      }
      this.output.push(Math.max(-1, Math.min(1, value)));
      this.cursor += this.ratio;

      if (this.output.length >= 320) {
        const pcm = new Int16Array(320);
        let peak = 0;
        for (let index = 0; index < pcm.length; index += 1) {
          const sample = this.output[index];
          peak = Math.max(peak, Math.abs(sample));
          pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        this.output.splice(0, pcm.length);
        this.port.postMessage({ level: peak, pcm16: pcm.buffer }, [pcm.buffer]);
      }
    }

    const consumed = Math.floor(this.cursor);
    if (consumed > 0) {
      this.pending.splice(0, consumed);
      this.cursor -= consumed;
    }
    return true;
  }
}

registerProcessor('qwen-pcm16-input', QwenPcm16InputProcessor);
