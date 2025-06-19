class VADDetector {
  constructor() {
    this.threshold = 500; // Adjust based on your needs
    this.frameSize = 160; // 20ms at 8kHz
  }

  detect(audioData) {
    if (audioData.length < this.frameSize) {
      return false;
    }

    // Calculate RMS energy
    let sum = 0;
    for (let i = 0; i < audioData.length; i += 2) {
      const sample = audioData.readInt16LE(i);
      sum += sample * sample;
    }
    
    const rms = Math.sqrt(sum / (audioData.length / 2));
    return rms > this.threshold;
  }
}

module.exports = VADDetector;