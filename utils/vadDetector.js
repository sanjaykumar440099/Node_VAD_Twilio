class VADDetector {
  constructor(options = {}) {
    this.frameSize = options.frameSize || 320;
    this.threshold = 800; // Lowered further for better sensitivity to short words
    this.smoothingWindow = options.smoothingWindow || 5; // Reduced for quicker response
    this.requiredVoicedFrames = options.requiredVoicedFrames || 2; // Reduced for short words
    this.recentVoices = [];
    this.maxRecent = this.smoothingWindow;
    this.debug = options.debug || false;
    this.lastRms = 0;

    // Enhanced parameters
    this.minEnergy = 400;
    this.maxEnergy = 15000; // to reject loud grunts
    this.gruntSpectralThreshold = 1500; // reject sounds with poor spectral distribution
    this.spectralCentroid = 0;
    this.zeroCrossingRate = 0;
    this.previousFrame = null;
    
    // Adaptive threshold
    this.adaptiveThreshold = this.threshold;
    this.backgroundNoise = 100;
    this.adaptationRate = 0.01;
    
    // State tracking
    this.consecutiveVoiced = 0;
    this.consecutiveSilence = 0;
    this.hangoverTime = 3; // Reduced frames to continue after voice stops
    this.hangoverCounter = 0;
  }

  detect(audioData) {
    if (!audioData || audioData.length < this.frameSize) return false;

    // Calculate multiple audio features
    const features = this.extractFeatures(audioData);
    
    // Update adaptive threshold based on background noise
    this.updateAdaptiveThreshold(features.rms);
    
    // Multi-criteria voice detection
    const isVoiced = this.multiCriteriaDetection(features);
    
    // Apply temporal smoothing
    const smoothedDecision = this.applyTemporalSmoothing(isVoiced);
    
    if (this.debug) {
      console.log(`[VAD] RMS: ${features.rms.toFixed(2)}, ZCR: ${features.zcr.toFixed(3)}, ` +
                  `SC: ${features.spectralCentroid.toFixed(1)}, Voiced: ${smoothedDecision}, ` +
                  `AdaptiveThresh: ${this.adaptiveThreshold.toFixed(1)}`);
    }

    return smoothedDecision;
  }

  extractFeatures(audioData) {
    let sum = 0;
    let samples = 0;
    let zeroCrossings = 0;
    let spectralSum = 0;
    let spectralWeightSum = 0;
    let previousSample = 0;

    for (let i = 0; i + 1 < audioData.length; i += 2) {
      const sample = audioData.readInt16LE(i);
      sum += sample * sample;
      samples++;

      // Zero crossing rate calculation
      if (i > 0 && ((previousSample >= 0 && sample < 0) || (previousSample < 0 && sample >= 0))) {
        zeroCrossings++;
      }
      previousSample = sample;

      // Simple spectral centroid approximation
      const magnitude = Math.abs(sample);
      const frequency = (i / audioData.length) * 4000; // Approximate frequency
      spectralSum += magnitude;
      spectralWeightSum += magnitude * frequency;
    }

    const rms = Math.sqrt(sum / samples);
    const zcr = zeroCrossings / samples;
    const spectralCentroid = spectralWeightSum / (spectralSum || 1);

    return {
      rms,
      zcr,
      spectralCentroid,
    };
  }

  updateAdaptiveThreshold(currentRms) {
    // Update background noise estimate
    if (currentRms < this.adaptiveThreshold * 0.5) {
      this.backgroundNoise = this.backgroundNoise * (1 - this.adaptationRate) + 
                            currentRms * this.adaptationRate;
    }

    // Adaptive threshold is a multiple of background noise
    this.adaptiveThreshold = Math.max(
      this.threshold,
      this.backgroundNoise * 3
    );
  }

  multiCriteriaDetection(features) {
    const { rms, zcr, spectralCentroid } = features;
    
    // Primary energy threshold
    const energyCheck = rms > this.adaptiveThreshold;
    
    // Zero crossing rate check (speech typically has moderate ZCR)
    const zcrCheck = zcr > 0.01 && zcr < 0.3;
    
    // Spectral centroid check (speech energy concentrated in mid frequencies)
    const spectralCheck = spectralCentroid > 200 && spectralCentroid < 3000;
    
    // Noise rejection (too high energy might be noise/echo)
    const noiseCheck = rms < this.maxEnergy;
    
    // Combined decision with weights
    let score = 0;
    if (energyCheck) score += 3;
    if (zcrCheck) score += 2;
    if (spectralCheck) score += 2;
    if (noiseCheck) score += 1;
    
    return score >= 4; // Threshold for voice detection
  }

  applyTemporalSmoothing(isVoiced) {
    // Update consecutive counters
    if (isVoiced) {
      this.consecutiveVoiced++;
      this.consecutiveSilence = 0;
      this.hangoverCounter = this.hangoverTime;
    } else {
      this.consecutiveVoiced = 0;
      this.consecutiveSilence++;
      if (this.hangoverCounter > 0) {
        this.hangoverCounter--;
        isVoiced = true; // Continue voice detection during hangover
      }
    }

    // Add to recent voices for smoothing
    this.recentVoices.push(isVoiced);
    if (this.recentVoices.length > this.maxRecent) {
      this.recentVoices.shift();
    }

    const voicedCount = this.recentVoices.filter(Boolean).length;
    
    // For short words, be more responsive - require fewer consecutive frames
    if (this.consecutiveVoiced >= Math.max(1, this.requiredVoicedFrames - 1)) {
      return voicedCount >= Math.max(1, this.requiredVoicedFrames - 1);
    }
    
    // During ongoing voice activity, be more lenient
    if (this.hangoverCounter > 0) {
      return voicedCount >= 1; // Very lenient during hangover
    }
    
    return voicedCount >= this.requiredVoicedFrames;
  }

  reset() {
    this.recentVoices = [];
    this.consecutiveVoiced = 0;
    this.consecutiveSilence = 0;
    this.hangoverCounter = 0;
    this.backgroundNoise = 100;
    this.adaptiveThreshold = this.threshold;
  }

  updateThreshold(newThreshold) {
    this.threshold = newThreshold;
    this.adaptiveThreshold = Math.max(this.adaptiveThreshold, newThreshold);
  }

  getLastRMS() {
    return this.lastRms;
  }

  getBackgroundNoise() {
    return this.backgroundNoise;
  }

  getAdaptiveThreshold() {
    return this.adaptiveThreshold;
  }

  // Method to manually set background noise (useful for calibration)
  calibrateBackgroundNoise(noiseLevel) {
    this.backgroundNoise = noiseLevel;
    this.adaptiveThreshold = Math.max(this.threshold, noiseLevel * 3);
    console.log(`[VAD] Background noise calibrated to: ${noiseLevel.toFixed(2)}`);
  }
}

module.exports = VADDetector;