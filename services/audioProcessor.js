const VADDetector = require ('../utils/vadDetector');
const {v4: uuidv4} = require ('uuid');
const TranscriptionService = require ('./transcriptionService');
const RAGService = require ('./ragService');
const TTSService = require ('./ttsService');
const fs = require ('fs');
const path = require ('path');

function timestamp () {
  return `[${new Date ().toISOString ().replace ('T', ' ').replace ('Z', '')}]`;
}

class AudioProcessor {
  constructor (callSid, ws, streamSid) {
    this.callSid = callSid;
    this.ws = ws;
    this.streamSid = streamSid;

    this.vadDetector = new VADDetector ();
    this.transcriptionService = new TranscriptionService ();
    this.ragService = new RAGService ();
    this.ttsService = new TTSService ();

    this.audioBuffer = [];
    this.isRecording = false;
    this.silenceCounter = 0;
    this.silenceThreshold = 80; // waits longer before stopping
    this.baseSilenceThreshold = 50;
    this.extendedSilenceThreshold = 100; // For longer phrases
    this.gruntRejectionThreshold = 800; // New: specific threshold for grunt-like sounds

    // SPECTRAL ANALYSIS for better voice/grunt distinction
    this.minSpectralComplexity = 0.3; // Grunts typically have low spectral complexity
    this.voiceFrequencyRange = { min: 85, max: 3400 }; // Human voice frequency range

    this.sentenceBuffer = '';
    this.ttsQueue = [];
    this.isTtsBusy = false;

    // Enhanced audio processing parameters
    this.lastSample = 0;
    this.previousSamples = [0, 0, 0]; // For smoothing filter
    this.dcOffset = 0; // For DC removal
    this.dcAlpha = 0.995; // DC removal filter coefficient

    // Audio quality thresholds - ADJUSTED FOR SHORT WORDS
    this.minAudioLength = 1600; // Minimum 0.2 seconds at 8kHz (was 8000)
    this.maxAudioLength = 160000; // Maximum 20 seconds at 8kHz
    this.energyThreshold = 300; // Increased from 100 - higher energy required

    // Time tracking
    this.timings = {
      voiceDetected: 0,
      silenceDetected: 0,
      transcriptionDone: 0,
      llmFirstToken: 0,
      ttsAudioReceived: 0,
      audioPlayback: 0,
    };
    this.isProcessingQuery = false;
  }

  async processAudio (audioData) {
    if (this.isProcessingQuery) return;
    try {
      const pcmData = this.mulawToPcmEnhanced (audioData);
      const hasVoice = this.vadDetector.detect (pcmData);

      if (hasVoice) {
        if (!this.isRecording) {
          this.timings.voiceDetected = Date.now ();
          console.log (`${timestamp ()} 🔴 Voice detected, starting recording`);
        }
        this.isRecording = true;
        this.silenceCounter = 0;

        // Enhanced energy calculation with spectral analysis
        const energy = this.calculateEnhancedRMS (pcmData);
        if (energy < this.energyThreshold) return;

        this.audioBuffer.push (pcmData);
      } else if (this.isRecording) {
        this.silenceCounter++;

        const recordingDuration = this.audioBuffer.length * 125 / 1000; // approximate ms
        const dynamicThreshold = recordingDuration > 1000? this.extendedSilenceThreshold : this.baseSilenceThreshold;

        if (this.silenceCounter >= dynamicThreshold) {
          this.timings.silenceDetected = Date.now ();
          const recordTime = (this.timings.silenceDetected -
            this.timings.voiceDetected).toFixed (2);
          console.log (
            `${timestamp ()} ⏸ Silence detected, processing recording (Spoke for ${recordTime} ms)`
          );
          await this.processRecording ();
          this.resetRecording ();
        }
      }
    } catch (error) {
      console.error (`${timestamp ()} ❌ Audio processing error:`, error);
    }
  }

  // Enhanced μ-law to PCM conversion with noise reduction
  mulawToPcmEnhanced (mulawData) {
    const pcmData = Buffer.alloc(mulawData.length * 2);
    
    for (let i = 0; i < mulawData.length; i++) {
      const mulaw = mulawData[i];
      let pcm = this.mulawToPcmSample(mulaw);
      
      // DC offset removal
      this.dcOffset = this.dcAlpha * this.dcOffset + (1 - this.dcAlpha) * pcm;
      pcm = pcm - this.dcOffset;
      
      // ENHANCED NOISE GATE - More aggressive
      const noiseGate = 600; // Increased from 400
      const hysteresis = 200; // Increased from 100
      
      if (Math.abs(pcm) < noiseGate) {
        pcm = Math.abs(this.lastSample) > (noiseGate + hysteresis) ? pcm * 0.05 : 0; // More aggressive reduction
      }
      
      // Multi-point smoothing for better grunt rejection
      const smoothed = (pcm + this.previousSamples[0] + this.previousSamples[1] + this.previousSamples[2]) / 4;
      
      // Update sample history
      this.previousSamples[2] = this.previousSamples[1];
      this.previousSamples[1] = this.previousSamples[0];
      this.previousSamples[0] = pcm;
      
      const limited = this.softLimit(smoothed, 25000); // Reduced from 30000
      
      this.lastSample = limited;
      pcmData.writeInt16LE(Math.round(limited), i * 2);
    }
    
    return pcmData;
  }

  // Soft limiter to prevent harsh clipping
  softLimit (sample, threshold) {
    const abs = Math.abs (sample);
    if (abs <= threshold) return sample;

    const sign = sample >= 0 ? 1 : -1;
    const excess = abs - threshold;
    const compressed = threshold + excess / (1 + excess / 2000);

    return sign * Math.min (compressed, 32767);
  }

  // Enhanced RMS calculation with frequency weighting
  calculateEnhancedRMS (buffer) {
    if (buffer.length < 2) return 0;

    let sum = 0;
    let weightedSum = 0;
    let samples = 0;

    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE (i);
      const sampleSquared = sample * sample;
      sum += sampleSquared;

      // Apply frequency weighting (emphasize mid frequencies for speech)
      const weight = this.getFrequencyWeight (i, buffer.length);
      weightedSum += sampleSquared * weight;
      samples++;
    }

    const rms = Math.sqrt (sum / samples);
    const weightedRms = Math.sqrt (weightedSum / samples);

    // Return combination of regular and weighted RMS
    return rms * 0.7 + weightedRms * 0.3;
  }

  // Simple frequency weighting for speech enhancement
  getFrequencyWeight (index, totalLength) {
    const normalizedIndex = index / totalLength;
    // Emphasize middle frequencies (roughly corresponding to speech formants)
    if (normalizedIndex > 0.2 && normalizedIndex < 0.8) {
      return 1.2;
    }
    return 0.8;
  }

  async processRecording () {
    if (this.audioBuffer.length === 0) return;
    const session = global.activeSessions.get (this.callSid);

    try {
      if (session) session.isProcessing = true;

      const combinedBuffer = Buffer.concat (this.audioBuffer);

      // Check minimum audio length with better logic
      const audioLengthSeconds = combinedBuffer.length / (8000 * 2); // Convert to seconds
      if (audioLengthSeconds < 0.2) {
        console.log (
          `${timestamp ()} 🛑 Audio too short (${audioLengthSeconds.toFixed (2)}s), skipping transcription.`
        );
        return;
      }

      // For very short audio (0.2-0.5s), apply stricter voice validation
      const isShortAudio = audioLengthSeconds < 0.7;

      // Check maximum audio length
      if (combinedBuffer.length > this.maxAudioLength) {
        console.log (
          `${timestamp ()} ⚠️ Audio too long, truncating to ${this.maxAudioLength} bytes.`
        );
        combinedBuffer = combinedBuffer.slice (0, this.maxAudioLength);
      }

      // Apply additional noise reduction to the combined buffer
      const cleanedBuffer = this.applyNoiseReduction (combinedBuffer);

      const wavBuffer = this.createEnhancedWavBuffer (cleanedBuffer);

      // Adjust voice detection threshold for short audio
      const voiceThreshold = isShortAudio ? 400 : 1000;
      if (!this.hasVoiceInWav (wavBuffer, voiceThreshold)) {
        console.log (
          `${timestamp ()} 🛑 No voice detected in wavBuffer (threshold: ${voiceThreshold}), skipping transcription.`
        );
        return;
      }

      const filename = `recording-${Date.now ()}.wav`;
      const filePath = path.join (__dirname, '../public', filename);
      fs.mkdirSync (path.dirname (filePath), {recursive: true});
      fs.writeFileSync (filePath, wavBuffer);

      const transcription = await this.transcriptionService.transcribe (
        wavBuffer
      );

      this.timings.transcriptionDone = Date.now ();
      const transcribeTime = (this.timings.transcriptionDone -
        this.timings.silenceDetected).toFixed (2);

      console.log (`${timestamp ()} ⏱️ Transcription: ${transcription}`);
      console.log (
        `${timestamp ()} 🕒 Time to transcribe: ${transcribeTime} ms`
      );

      if (transcription && transcription.trim ()) {
        this.ragService.getResponse (transcription);
        let lastToken = '';
        let CountToken = 0;

        this.ttsService.removeAllListeners ('token');
        this.ragService.on ('token', token => {
          const TokenCount = CountToken++;
          if (TokenCount === 1) {
            this.timings.llmFirstToken = Date.now ();
            const llmDelay = (this.timings.llmFirstToken -
              this.timings.transcriptionDone).toFixed (2);
            console.log (`${timestamp ()} ⏱️ First Token Received`);
            console.log (`${timestamp ()} 🕒 LLM delay: ${llmDelay} ms`);
          }

          if (token === '[COMPLETED]') {
            this.ragService.removeAllListeners ('token');
            return;
          }

          const needsSpace =
            lastToken && !/['.,!?]/.test (token) && !/^['']/.test (token);
          if (needsSpace) this.sentenceBuffer += ' ';
          this.sentenceBuffer += token;
          lastToken = token;

          const boundaries = [];
          let inNumber = false;
          for (let i = 0; i < this.sentenceBuffer.length; i++) {
            const char = this.sentenceBuffer[i];
            if (/\d/.test (char)) {
              inNumber = true;
              continue;
            }
            if (/[.!?]/.test (char)) {
              if (char === '.' && inNumber) continue;
              if (
                i === this.sentenceBuffer.length - 1 ||
                /\s/.test (this.sentenceBuffer[i + 1])
              ) {
                boundaries.push (i + 1);
              }
            }
            inNumber = false;
          }

          let lastIndex = 0;
          for (const boundary of boundaries) {
            const sentence = this.sentenceBuffer
              .substring (lastIndex, boundary)
              .trim ();
            if (sentence) {
              this.ttsService.synthesize (sentence);
              console.log (
                `${timestamp ()} 💬 LLM First Sentence: "${sentence}"`
              );
            }
            lastIndex = boundary;
          }

          this.sentenceBuffer = this.sentenceBuffer.substring (lastIndex);
        });

        this.ttsService.removeAllListeners ('buffer');
        this.ttsService.on ('buffer', audioBuffer => {
          this.timings.ttsAudioReceived = Date.now ();
          const ttsTime = (this.timings.ttsAudioReceived -
            this.timings.llmFirstToken).toFixed (2);
          console.log (
            `${timestamp ()} 💬 TTS Audio Received, Length: ${audioBuffer.length} bytes`
          );
          console.log (`${timestamp ()} 🕒 TTS delay: ${ttsTime} ms`);

          this.playAudioViaMessage (audioBuffer);
        });
      }
    } catch (error) {
      console.error (`${timestamp ()} ❌ Recording processing error:`, error);
    } finally {
      if (session) session.isProcessing = false;
    }
  }

  // Apply noise reduction to the entire buffer
  applyNoiseReduction (buffer) {
    if (buffer.length < 4) return buffer;

    const cleaned = Buffer.alloc (buffer.length);
    let runningMean = 0;
    const alpha = 0.01; // Smoothing factor

    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE (i);

      // Update running mean for DC removal
      runningMean = alpha * sample + (1 - alpha) * runningMean;
      let cleanSample = sample - runningMean;

      // Apply spectral subtraction (simple version)
      if (Math.abs (cleanSample) < 200) {
        cleanSample *= 0.5; // Reduce low-level noise
      }

      // Write cleaned sample
      cleaned.writeInt16LE (Math.round (cleanSample), i);
    }

    return cleaned;
  }

  // Enhanced WAV buffer creation with better headers
  createEnhancedWavBuffer (pcmData, sampleRate = 8000) {
    const length = pcmData.length;
    const buffer = Buffer.alloc (44 + length);

    // RIFF header
    buffer.write ('RIFF', 0);
    buffer.writeUInt32LE (36 + length, 4);
    buffer.write ('WAVE', 8);

    // fmt chunk
    buffer.write ('fmt ', 12);
    buffer.writeUInt32LE (16, 16); // PCM format chunk size
    buffer.writeUInt16LE (1, 20); // PCM format
    buffer.writeUInt16LE (1, 22); // Mono
    buffer.writeUInt32LE (sampleRate, 24); // Sample rate
    buffer.writeUInt32LE (sampleRate * 2, 28); // Byte rate
    buffer.writeUInt16LE (2, 32); // Block align
    buffer.writeUInt16LE (16, 34); // Bits per sample

    // data chunk
    buffer.write ('data', 36);
    buffer.writeUInt32LE (length, 40);
    pcmData.copy (buffer, 44);

    return buffer;
  }

  hasVoiceInWav(wavBuffer, threshold = 1000) { // Increased default threshold
    const pcmData = wavBuffer.slice(44);
    if (pcmData.length < 2) return false;

    let sum = 0;
    let samples = 0;
    let peakCount = 0;
    let significantSamples = 0;
    let spectralComplexity = 0;
    
    // STRICTER THRESHOLDS
    const peakThreshold = 1200; // Increased from 800
    const significantThreshold = 500; // Increased from 300
    const noiseFloor = 200; // Minimum acceptable signal level

    for (let i = 0; i < pcmData.length; i += 2) {
      const sample = pcmData.readInt16LE(i);
      const magnitude = Math.abs(sample);
      
      sum += sample * sample;
      samples++;
      
      if (magnitude > peakThreshold) peakCount++;
      if (magnitude > significantThreshold) significantSamples++;
      
      // Calculate spectral complexity (frequency domain analysis approximation)
      if (i > 0 && i < pcmData.length - 2) {
        const prev = Math.abs(pcmData.readInt16LE(i - 2));
        const next = Math.abs(pcmData.readInt16LE(i + 2));
        const variation = Math.abs(magnitude - (prev + next) / 2);
        spectralComplexity += variation;
      }
    }

    const rms = Math.sqrt(sum / samples);
    const peakRatio = peakCount / samples;
    const significantRatio = significantSamples / samples;
    const avgSpectralComplexity = spectralComplexity / samples;
    
    console.log(`[Enhanced VoiceCheck] RMS: ${rms.toFixed(2)}, Peak: ${peakRatio.toFixed(4)}, ` +
                `Significant: ${significantRatio.toFixed(4)}, Complexity: ${avgSpectralComplexity.toFixed(2)}`);
    
    // GRUNT REJECTION LOGIC
    const isLikelyGrunt = (rms > this.gruntRejectionThreshold && avgSpectralComplexity < this.minSpectralComplexity && peakRatio < 0.005); // Too few peaks suggests monotone grunt
    
    if (isLikelyGrunt) {
      console.log(`[VoiceCheck] 🚫 Rejected as grunt - Low complexity: ${avgSpectralComplexity.toFixed(3)}`);
      return false;
    }
    
    // ENHANCED VOICE VALIDATION
    const audioLengthSeconds = pcmData.length / (8000 * 2);
    
    if (audioLengthSeconds < 0.3) {
      // Very strict for short audio to avoid grunts
      return rms > threshold * 1.5 && significantRatio > 0.15 &&  avgSpectralComplexity > this.minSpectralComplexity * 1.5;}
    
    // Standard validation with enhanced thresholds
    return rms > threshold &&  peakRatio > 0.002 &&  significantRatio > 0.12 && avgSpectralComplexity > this.minSpectralComplexity;
 }

  async playAudioViaMessage (base64PCM) {
    try {
      const now = Date.now ();
      const playbackDelay = (now - this.timings.ttsAudioReceived).toFixed (2);
      const totalDelay = (now - this.timings.silenceDetected).toFixed (2);
      console.log (
        `${timestamp ()} 🕒 Time from silence to playback: ${totalDelay} ms`
      );

      const chunkDuration = base64PCM.length / 16000 / 2 * 1000;

      this.ws.send (
        JSON.stringify ({
          event: 'media',
          streamSid: this.streamSid,
          media: {payload: base64PCM},
        })
      );

      console.log (
        `${timestamp ()} 🔊 Audio sent to Twilio (Playback delay: ${playbackDelay} ms)`
      );

      await new Promise (resolve => setTimeout (resolve, chunkDuration + 200));
      this.isProcessingQuery = false;
      console.log (
        '======================================================================================================================='
      );
    } catch (error) {
      console.error (`${timestamp ()} ❌ Playback failed:`, error);
    }
  }

  resetRecording () {
    this.audioBuffer = [];
    this.isRecording = false;
    this.silenceCounter = 0;
    // Reset audio processing state
    this.lastSample = 0;
    this.previousSamples = [0, 0, 0];
    this.dcOffset = 0;
  }

  cleanup () {
    this.resetRecording ();
  }

  mulawToPcmSample (mulaw) {
    const MULAW_BIAS = 0x84;
    mulaw = ~mulaw & 0xff;
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0f;
    let sample = exponent === 0
      ? (mantissa << 1) + MULAW_BIAS
      : ((mantissa | 0x10) << (exponent + 3)) + MULAW_BIAS;
    return Math.max (-32768, Math.min (32767, sign ? -sample : sample));
  }
}

module.exports = AudioProcessor;
