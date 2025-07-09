// Enhanced audioProcessor.js with improved voice quality and loudness
const VADDetector = require ('../utils/vadDetector');
const {v4: uuidv4} = require ('uuid');
const TranscriptionService = require ('./transcriptionService');
const RAGService = require ('./ragService');
const TTSService = require ('./ttsService');
const fs = require ('fs');
const path = require ('path');
const {spawn} = require ('child_process');
const ffmpegPath = require ('@ffmpeg-installer/ffmpeg').path;

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
    this.silenceThreshold = 40; // Reduced for better responsiveness

    // Enhanced thresholds for better voice detection
    this.minRMSThreshold = 200; // Further lowered for quiet speech
    this.maxRMSThreshold = 40000; // Increased to allow louder speech
    this.volumeBoost = 3.0; // Increased boost significantly

    this.sentenceBuffer = '';
    this.ttsQueue = [];
    this.isTtsBusy = false;

    this.timings = {
      voiceDetected: 0,
      silenceDetected: 0,
      transcriptionDone: 0,
      llmFirstToken: 0,
      ttsAudioReceived: 0,
      audioPlayback: 0,
    };
    this.isProcessingQuery = false;

    // Audio quality parameters
    this.noiseFloor = 200; // Dynamic noise floor
    this.adaptiveGain = 1.0; // Adaptive gain control
    this.audioBufferFmpeg = [];
  }

  async processAudio (audioData, mulawString) {
    if (this.isProcessingQuery) return;
    try {
      const mulawBuffer = Buffer.from (mulawString, 'base64');
      this.audioBufferFmpeg.push (mulawBuffer);

      const pcmData = this.mulawToPcm (audioData);
      const hasVoice = this.vadDetector.detect (pcmData);

      if (hasVoice) {
        if (!this.isRecording) {
          this.timings.voiceDetected = Date.now ();
          console.log (`${timestamp ()} 🔴 Voice detected, starting recording`);
        }
        this.isRecording = true;
        this.silenceCounter = 0;
        const energy = this.calculateRMS (pcmData);

        // Adaptive gain adjustment based on input level
        this.adjustAdaptiveGain (energy);

        // console.log (
        //   `${timestamp ()} 📊 Energy = ${energy.toFixed (2)} RMS | Adaptive Gain: ${this.adaptiveGain.toFixed (2)}`
        // );

        // More lenient energy filtering with adaptive thresholds
        const dynamicMinThreshold = Math.max (
          this.minRMSThreshold,
          this.noiseFloor
        );
        if (energy >= dynamicMinThreshold && energy <= this.maxRMSThreshold) {
          this.audioBuffer.push (pcmData);
        } else {
          // console.log (`${timestamp ()} ⚠️ Energy level ${energy.toFixed (2)} filtered (range: ${dynamicMinThreshold}-${this.maxRMSThreshold})`);
        }
      } else if (this.isRecording) {
        this.silenceCounter++;
        if (this.silenceCounter >= this.silenceThreshold) {
          this.timings.silenceDetected = Date.now ();
          const recordTime = (this.timings.silenceDetected -
            this.timings.voiceDetected).toFixed (2);
          console.log (
            `${timestamp ()} ⏸ Silence detected, processing recording (Spoke for ${recordTime} ms)`
          );
          await this.processRecording (mulawString);
          this.resetRecording ();
        }
      }
    } catch (error) {
      console.error (`${timestamp ()} ❌ Audio processing error:`, error);
    }
  }

  adjustAdaptiveGain (currentEnergy) {
    // More aggressive gain adjustment for better transcription
    if (currentEnergy < 500) {
      this.adaptiveGain = Math.min (4.0, this.adaptiveGain + 0.2); // Faster, higher boost
    } else if (currentEnergy < 1000) {
      this.adaptiveGain = Math.min (3.0, this.adaptiveGain + 0.1);
    } else if (currentEnergy > 8000) {
      this.adaptiveGain = Math.max (1.0, this.adaptiveGain - 0.1);
    }

    // Log gain changes for debugging
    if (this.adaptiveGain !== this.volumeBoost) {
      //console.log ( `${timestamp ()} 📈 Adaptive gain: ${this.adaptiveGain.toFixed (2)} (energy: ${currentEnergy.toFixed (2)})`);
    }
  }

  async processRecording (mulawString) {
    if (this.audioBuffer.length === 0) return;
    const session = global.activeSessions.get (this.callSid);

    try {
      if (session) session.isProcessing = true;

      // Apply pre-processing before FFmpeg
      const combined = Buffer.concat (this.audioBufferFmpeg);
      const enhancedWav = await this.ffmpegMuLawToWav (combined);
     
     const getWavDuration = (buffer) => {
        const sampleRate = buffer.readUInt32LE(24); // Usually 44100 or 8000
        const dataChunkOffset = buffer.indexOf('data') + 8;
        const dataLength = buffer.length - dataChunkOffset;
        const bytesPerSample = 2; // Assuming 16-bit mono PCM
        const durationSeconds = dataLength / (sampleRate * bytesPerSample);
        return durationSeconds;
      };

      const duration = getWavDuration(enhancedWav);
      if (duration < 0.5) { // 500 ms
        console.log(`${timestamp()} 🛑 Skipping short audio (duration: ${duration}s).`);
        return;
      }

      const filename = `recording-${Date.now ()}.wav`;
      const filePath = path.join (__dirname, '../public', filename);
      fs.mkdirSync (path.dirname (filePath), {recursive: true});
      fs.writeFileSync (filePath, enhancedWav);

      const transcription = await this.transcriptionService.transcribe (enhancedWav);

      this.timings.transcriptionDone = Date.now ();
      const transcribeTime = (this.timings.transcriptionDone - this.timings.silenceDetected).toFixed (2);
      console.log (`${timestamp ()} ⏱️ Transcription: ${transcription}`);
      console.log (`${timestamp ()} 🕒 Time to transcribe: ${transcribeTime} ms`);

      if (transcription && transcription.trim ()) {
        this.ragService.getResponse (transcription);
        let lastToken = '';
        let CountToken = 0;

        this.ttsService.removeAllListeners ('token');
        this.ragService.on ('token', tokenRespose => {
          const TokenCount = CountToken++;
          if (TokenCount === 1) {
            this.timings.llmFirstToken = Date.now ();
            const llmDelay = (this.timings.llmFirstToken - this.timings.transcriptionDone).toFixed (2);
            console.log (`${timestamp ()} ⏱️ First sentence Received`);
            console.log (`${timestamp ()} 🕒 LLM delay: ${llmDelay} ms`);
          }
          let tokenSentence = JSON.parse(tokenRespose).sentence;
          if(tokenSentence != 'COMPLETED') {
            this.ttsService.synthesize (tokenSentence);
            console.log (`${timestamp ()} 💬 LLM ${TokenCount}  Sentence: "${tokenSentence}"`);
          }
          
          if (tokenSentence == 'COMPLETED') {
            this.ragService.removeAllListeners ('token');
            return;
          }

          // const needsSpace = lastToken && !/['.,!?]/.test (token) && !/^['']/.test (token);
          // if (needsSpace) this.sentenceBuffer += '';
          // this.sentenceBuffer += token;
          // lastToken = token;

          // const boundaries = [];
          // let inNumber = false;
          // for (let i = 0; i < this.sentenceBuffer.length; i++) {
          //   const char = this.sentenceBuffer[i];
          //   if (/\d/.test (char)) {
          //     inNumber = true;
          //     continue;
          //   }
          //   if (/[.!?]/.test (char)) {
          //     if (char === '.' && inNumber) continue;
          //     if (
          //       i === this.sentenceBuffer.length - 1 ||
          //       /\s/.test (this.sentenceBuffer[i + 1])
          //     ) {
          //       boundaries.push (i + 1);
          //     }
          //   }
          //   inNumber = false;
          // }

          // let lastIndex = 0;
          // for (const boundary of boundaries) {
          //   const sentence = this.sentenceBuffer
          //     .substring (lastIndex, boundary)
          //     .trim ();
          //   if (sentence) {
          //     this.ttsService.synthesize (sentence);
          //     console.log (`${timestamp ()} 💬 LLM First Sentence: "${sentence}"`);
          //   }
          //   lastIndex = boundary;
          // }

          // this.sentenceBuffer = this.sentenceBuffer.substring (lastIndex);
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

  ffmpegMuLawToWav (mulawBuffer) {
    return new Promise ((resolve, reject) => {
      const ffmpeg = spawn (ffmpegPath, [
        '-f',
        'mulaw',
        '-ar',
        '8000',
        '-ac',
        '1',
        '-i',
        'pipe:0',

        '-af',
        [
          'silenceremove=start_periods=1:start_duration=0.2:start_threshold=-40dB',
          'highpass=f=120',
          'lowpass=f=3800',
          'afftdn=nf=-25',
          'acompressor=threshold=-35dB:ratio=7:attack=10:release=800',
          'volume=25dB',
          'alimiter=limit=0.99',
        ].join (','),

        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        'wav',
        'pipe:1',
      ]);

      const chunks = [];
      ffmpeg.stdout.on ('data', chunk => chunks.push (chunk));
      ffmpeg.stderr.on ('data', err => console.error () );
      ffmpeg.on ('close', code => {
        if (code === 0) resolve (Buffer.concat (chunks));
        else reject (new Error (`FFmpeg exited with code ${code}`));
      });

      ffmpeg.stdin.write (mulawBuffer);
      ffmpeg.stdin.end ();
    });
  }

  resetRecording () {
    this.audioBufferFmpeg = [];
    this.isRecording = false;
    this.silenceCounter = 0;

    // Update noise floor based on recent audio
    this.updateNoiseFloor ();
  }

  updateNoiseFloor () {
    // Adaptive noise floor based on recent background levels
    const backgroundLevel = this.vadDetector.getBackgroundNoise ();
    this.noiseFloor = Math.max (150, Math.min (400, backgroundLevel * 1.5));
  }

  calculateRMS (buffer) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE (i);
      sum += sample * sample;
      count++;
    }
    return Math.sqrt (sum / count);
  }

  hasVoiceInWav (wavBuffer, threshold = 600) {
    // Lowered threshold
    const pcmData = wavBuffer.slice (44);
    if (pcmData.length < 2) return false;

    let sum = 0;
    let samples = 0;
    let zeroCrossings = 0;
    let prevSample = 0;
    let peakLevel = 0;

    for (let i = 0; i < pcmData.length; i += 2) {
      const sample = pcmData.readInt16LE (i);
      sum += sample * sample;
      samples++;

      peakLevel = Math.max (peakLevel, Math.abs (sample));

      if (sample * prevSample < 0) zeroCrossings++;
      prevSample = sample;
    }

    const rms = Math.sqrt (sum / samples);
    const zcr = zeroCrossings / (pcmData.length / 2);

    console.log (
      `[VoiceCheck] RMS: ${rms.toFixed (2)}, Peak: ${peakLevel}, ZCR: ${zcr.toFixed (4)}`
    );

    // Enhanced voice detection with multiple criteria
    const hasEnergy = rms > threshold;
    const hasVoiceZCR = zcr > 0.01 && zcr < 0.4; // Voice-like zero crossing rate
    const hasSignificantPeak = peakLevel > threshold * 2;

    return hasEnergy && (hasVoiceZCR || hasSignificantPeak);
  }

  mulawToPcm (mulawData) {
    const pcmData = Buffer.alloc (mulawData.length * 2);
    for (let i = 0; i < mulawData.length; i++) {
      const mulaw = mulawData[i];
      let pcm = this.mulawToPcmSample (mulaw);

      // Reduce noise gate threshold for better sensitivity
      if (Math.abs (pcm) < 200) pcm = 0;

      pcmData.writeInt16LE (pcm, i * 2);
    }
    return pcmData;
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

  // Method to manually adjust audio parameters
  adjustAudioParameters (options = {}) {
    if (options.minRMS) this.minRMSThreshold = options.minRMS;
    if (options.maxRMS) this.maxRMSThreshold = options.maxRMS;
    if (options.volumeBoost) this.volumeBoost = options.volumeBoost;
    if (options.noiseFloor) this.noiseFloor = options.noiseFloor;

    console.log (`${timestamp ()} 🎛️ Audio parameters adjusted:`, {
      minRMS: this.minRMSThreshold,
      maxRMS: this.maxRMSThreshold,
      volumeBoost: this.volumeBoost,
      noiseFloor: this.noiseFloor,
    });
  }
}

module.exports = AudioProcessor;
