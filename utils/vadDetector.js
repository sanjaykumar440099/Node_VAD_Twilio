class VADDetector {
  constructor(options = {}) {
    this.frameSize = options.frameSize || 320;
    this.threshold = 600; // Lowered for better sensitivity
    this.smoothingWindow = options.smoothingWindow || 4; // Optimized for responsiveness
    this.requiredVoicedFrames = options.requiredVoicedFrames || 2;
    this.recentVoices = [];
    this.maxRecent = this.smoothingWindow;
    this.debug = options.debug || false;
    this.lastRms = 0;

    // Enhanced parameters for better voice detection
    this.minEnergy = 250; // Lowered to catch quieter speech
    this.maxEnergy = 25000; // Increased range
    this.spectralThreshold = 1200; // Adjusted for better voice detection
    this.spectralCentroid = 0;
    this.zeroCrossingRate = 0;
    this.previousFrame = null;
    
    // Advanced adaptive threshold system
    this.adaptiveThreshold = this.threshold;
    this.backgroundNoise = 80; // Lower initial background noise
    this.adaptationRate = 0.02; // Faster adaptation
    this.longTermNoise = 80;
    this.noiseUpdateCounter = 0;
    
    // Enhanced state tracking
    this.consecutiveVoiced = 0;
    this.consecutiveSilence = 0;
    this.hangoverTime = 5; // Increased hangover for better continuity
    this.hangoverCounter = 0;
    this.voiceActivityStrength = 0;
    
    // Voice quality metrics
    this.voiceConfidence = 0;
    this.spectralBalance = 0;
    this.energyVariance = 0;
    this.recentEnergies = [];
    this.maxRecentEnergies = 10;
  }

  detect(audioData) {
    if (!audioData || audioData.length < this.frameSize) return false;

    // Extract comprehensive audio features
    const features = this.extractEnhancedFeatures(audioData);
    
    // Update adaptive systems
    this.updateAdaptiveThreshold(features.rms);
    this.updateEnergyHistory(features.rms);
    
    // Advanced multi-criteria voice detection
    const voiceDecision = this.advancedVoiceDetection(features);
    
    // Enhanced temporal smoothing with confidence
    const smoothedDecision = this.enhancedTemporalSmoothing(voiceDecision, features);
    
    if (this.debug) {
      console.log(`[VAD] RMS: ${features.rms.toFixed(2)}, ZCR: ${features.zcr.toFixed(3)}, ` +
                  `SC: ${features.spectralCentroid.toFixed(1)}, Confidence: ${this.voiceConfidence.toFixed(2)}, ` +
                  `Decision: ${smoothedDecision}, AdaptThresh: ${this.adaptiveThreshold.toFixed(1)}`);
    }

    this.lastRms = features.rms;
    return smoothedDecision;
  }

  extractEnhancedFeatures(audioData) {
    let sum = 0;
    let samples = 0;
    let zeroCrossings = 0;
    let spectralSum = 0;
    let spectralWeightSum = 0;
    let previousSample = 0;
    let peakLevel = 0;
    let energyVariance = 0;
    let lowFreqEnergy = 0;
    let midFreqEnergy = 0;
    let highFreqEnergy = 0;

    for (let i = 0; i + 1 < audioData.length; i += 2) {
      const sample = audioData.readInt16LE(i);
      const absSample = Math.abs(sample);
      sum += sample * sample;
      samples++;
      
      peakLevel = Math.max(peakLevel, absSample);

      // Enhanced zero crossing detection
      if (i > 0 && ((previousSample >= 0 && sample < 0) || (previousSample < 0 && sample >= 0))) {
        zeroCrossings++;
      }
      
      // Spectral analysis (simplified)
      const magnitude = absSample;
      const frequency = (i / audioData.length) * 4000;
      spectralSum += magnitude;
      spectralWeightSum += magnitude * frequency;
      
      // Frequency band analysis
      if (frequency < 500) lowFreqEnergy += magnitude;
      else if (frequency < 2000) midFreqEnergy += magnitude;
      else highFreqEnergy += magnitude;
      
      previousSample = sample;
    }

    const rms = Math.sqrt(sum / samples);
    const zcr = zeroCrossings / samples;
    const spectralCentroid = spectralWeightSum / (spectralSum || 1);
    
    // Calculate spectral balance (voice has good mid-frequency content)
    const totalEnergy = lowFreqEnergy + midFreqEnergy + highFreqEnergy;
    const spectralBalance = totalEnergy > 0 ? midFreqEnergy / totalEnergy : 0;
    
    // Calculate energy variance from recent history
    if (this.recentEnergies.length > 3) {
      const mean = this.recentEnergies.reduce((a, b) => a + b, 0) / this.recentEnergies.length;
      energyVariance = this.recentEnergies.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / this.recentEnergies.length;
    }

    return {
      rms,
      zcr,
      spectralCentroid,
      peakLevel,
      spectralBalance,
      energyVariance,
      lowFreqEnergy,
      midFreqEnergy,
      highFreqEnergy
    };
  }

  updateAdaptiveThreshold(currentRms) {
    // Update background noise with different rates for increase/decrease
    if (currentRms < this.adaptiveThreshold * 0.4) {
      // Slowly increase background noise when quiet
      this.backgroundNoise = this.backgroundNoise * (1 - this.adaptationRate * 0.5) + 
                            currentRms * (this.adaptationRate * 0.5);
    } else if (currentRms > this.adaptiveThreshold * 2) {
      // Ignore very loud sounds for background estimation
      return;
    }

    // Long-term noise tracking
    this.noiseUpdateCounter++;
    if (this.noiseUpdateCounter % 50 === 0) {
      this.longTermNoise = this.longTermNoise * 0.9 + this.backgroundNoise * 0.1;
    }

    // Adaptive threshold with minimum and maximum bounds
    const baseThreshold = Math.max(this.longTermNoise * 4, this.threshold * 0.5);
    this.adaptiveThreshold = Math.min(baseThreshold, this.threshold * 2);
  }

  updateEnergyHistory(rms) {
    this.recentEnergies.push(rms);
    if (this.recentEnergies.length > this.maxRecentEnergies) {
      this.recentEnergies.shift();
    }
  }

  advancedVoiceDetection(features) {
    const { rms, zcr, spectralCentroid, peakLevel, spectralBalance, energyVariance } = features;
    
    let voiceScore = 0;
    let confidence = 0;
    
    // 1. Primary energy check with adaptive threshold
    if (rms > this.adaptiveThreshold) {
      voiceScore += 4;
      confidence += 0.3;
    } else if (rms > this.adaptiveThreshold * 0.7) {
      voiceScore += 2;
      confidence += 0.1;
    }
    
    // 2. Zero crossing rate check (voice has moderate ZCR)
    if (zcr > 0.01 && zcr < 0.35) {
      voiceScore += 3;
      confidence += 0.2;
      
      // Bonus for optimal ZCR range
      if (zcr > 0.03 && zcr < 0.15) {
        voiceScore += 1;
        confidence += 0.1;
      }
    }
    
    // 3. Spectral centroid check (voice energy in speech range)
    if (spectralCentroid > 150 && spectralCentroid < 3500) {
      voiceScore += 2;
      confidence += 0.15;
      
      // Bonus for optimal voice range
      if (spectralCentroid > 400 && spectralCentroid < 2000) {
        voiceScore += 1;
        confidence += 0.1;
      }
    }
    
    // 4. Spectral balance check (voice has good mid-frequency content)
    if (spectralBalance > 0.3 && spectralBalance < 0.8) {
      voiceScore += 2;
      confidence += 0.15;
    }
    
    // 5. Peak level check (avoid clipping and noise)
    if (peakLevel > this.minEnergy && peakLevel < this.maxEnergy) {
      voiceScore += 1;
      confidence += 0.05;
    }
    
    // 6. Energy variance check (voice has natural variation)
    if (energyVariance > 100 && energyVariance < 10000) {
      voiceScore += 1;
      confidence += 0.05;
    }
    
    // 7. Sustained energy check
    if (rms > this.backgroundNoise * 3) {
      voiceScore += 1;
      confidence += 0.05;
    }
    
    this.voiceConfidence = Math.min(1.0, confidence);
    this.spectralBalance = spectralBalance;
    this.voiceActivityStrength = voiceScore;
    
    // Dynamic threshold based on voice quality
    const requiredScore = this.voiceConfidence > 0.7 ? 6 : 8;
    return voiceScore >= requiredScore;
  }

  enhancedTemporalSmoothing(isVoiced, features) {
    // Update consecutive counters with confidence weighting
    if (isVoiced) {
      this.consecutiveVoiced++;
      this.consecutiveSilence = 0;
      
      // Extend hangover time for high-confidence voice
      const hangoverBonus = this.voiceConfidence > 0.8 ? 2 : 0;
      this.hangoverCounter = this.hangoverTime + hangoverBonus;
    } else {
      this.consecutiveVoiced = 0;
      this.consecutiveSilence++;
      if (this.hangoverCounter > 0) {
        this.hangoverCounter--;
        // Continue voice detection during hangover, but with reduced confidence
        isVoiced = true;
      }
    }

    // Add to recent voices with confidence weighting
    this.recentVoices.push({
      voiced: isVoiced,
      confidence: this.voiceConfidence,
      strength: this.voiceActivityStrength
    });
    
    if (this.recentVoices.length > this.maxRecent) {
      this.recentVoices.shift();
    }

    // Weighted voting based on confidence
    let totalWeight = 0;
    let voicedWeight = 0;
    
    this.recentVoices.forEach(entry => {
      const weight = Math.max(0.1, entry.confidence);
      totalWeight += weight;
      if (entry.voiced) {
        voicedWeight += weight;
      }
    });
    
    const voiceRatio = totalWeight > 0 ? voicedWeight / totalWeight : 0;
    
    // Adaptive decision threshold
    let threshold = 0.5;
    
    // Be more responsive for strong voice activity
    if (this.consecutiveVoiced >= 3) {
      threshold = 0.3;
    }
    
    // Be more conservative when just starting
    if (this.consecutiveVoiced === 0 && this.consecutiveSilence > 10) {
      threshold = 0.7;
    }
    
    // During hangover, be more lenient
    if (this.hangoverCounter > 0) {
      threshold = 0.2;
    }
    
    return voiceRatio >= threshold;
  }

  reset() {
    this.recentVoices = [];
    this.consecutiveVoiced = 0;
    this.consecutiveSilence = 0;
    this.hangoverCounter = 0;
    this.backgroundNoise = 80;
    this.longTermNoise = 80;
    this.adaptiveThreshold = this.threshold;
    this.voiceConfidence = 0;
    this.voiceActivityStrength = 0;
    this.recentEnergies = [];
    this.noiseUpdateCounter = 0;
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

  getVoiceConfidence() {
    return this.voiceConfidence;
  }

  getVoiceActivityStrength() {
    return this.voiceActivityStrength;
  }

  // Enhanced calibration with multiple noise samples
  calibrateBackgroundNoise(noiseSamples) {
    if (Array.isArray(noiseSamples)) {
      const avgNoise = noiseSamples.reduce((a, b) => a + b, 0) / noiseSamples.length;
      this.backgroundNoise = avgNoise;
      this.longTermNoise = avgNoise;
    } else {
      this.backgroundNoise = noiseSamples;
      this.longTermNoise = noiseSamples;
    }
    
    this.adaptiveThreshold = Math.max(this.threshold, this.backgroundNoise * 4);
    console.log(`[VAD] Background noise calibrated to: ${this.backgroundNoise.toFixed(2)}`);
  }

  // Method to get diagnostic information
  getDiagnostics() {
    return {
      backgroundNoise: this.backgroundNoise,
      longTermNoise: this.longTermNoise,
      adaptiveThreshold: this.adaptiveThreshold,
      voiceConfidence: this.voiceConfidence,
      voiceActivityStrength: this.voiceActivityStrength,
      consecutiveVoiced: this.consecutiveVoiced,
      hangoverCounter: this.hangoverCounter,
      recentVoicesCount: this.recentVoices.length,
      spectralBalance: this.spectralBalance
    };
  }
}

module.exports = VADDetector;