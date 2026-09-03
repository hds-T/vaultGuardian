// Mic capture worklet: batches the 128-sample render quanta into ~256ms frames
// and ships them to the page, which forwards them to the server's whisper
// session. The AudioContext is created at 16 kHz, so no resampling here.
const FRAME_SAMPLES = 4096

class MicProcessor extends AudioWorkletProcessor {
  constructor () {
    super()
    this.frame = new Float32Array(FRAME_SAMPLES)
    this.filled = 0
  }

  process (inputs) {
    const channel = inputs[0]?.[0]
    // No input connected yet (or the track ended) — keep the node alive.
    if (!channel) return true

    let read = 0
    while (read < channel.length) {
      const take = Math.min(FRAME_SAMPLES - this.filled, channel.length - read)
      this.frame.set(channel.subarray(read, read + take), this.filled)
      this.filled += take
      read += take
      if (this.filled === FRAME_SAMPLES) {
        // Transferred, so allocate a fresh buffer for the next frame.
        this.port.postMessage(this.frame.buffer, [this.frame.buffer])
        this.frame = new Float32Array(FRAME_SAMPLES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('mic-processor', MicProcessor)
