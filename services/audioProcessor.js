const VADDetector = require ('../utils/vadDetector');
const {v4: uuidv4} = require ('uuid');
const TranscriptionService = require ('./transcriptionService');
const RAGService = require ('./ragService');
const TTSService = require ('./ttsService');

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
    this.silenceThreshold = 30;

    this.sentenceBuffer = '';
    this.ttsQueue = [];
    this.isTtsBusy = false;

    // Time tracking
    this.timings = {
      voiceDetected: 0,
      silenceDetected: 0,
      transcriptionDone: 0,
      llmFirstToken: 0,
      ttsAudioReceived: 0,
      audioPlayback: 0,
    };
  }

 async processAudio(audioData) {
    try {
      const pcmData = this.mulawToPcm(audioData);
      const hasVoice = this.vadDetector.detect(pcmData);

      if (hasVoice) {
        if (!this.isRecording) {
          this.timings.voiceDetected = Date.now();
          console.log(`${timestamp()} 🔴 Voice detected, starting recording`);
        }
        this.isRecording = true;
        this.silenceCounter = 0;
        this.audioBuffer.push(pcmData);
      } else if (this.isRecording) {
        this.silenceCounter++;
        if (this.silenceCounter >= this.silenceThreshold) {
          this.timings.silenceDetected = Date.now();
          const recordTime = (this.timings.silenceDetected - this.timings.voiceDetected).toFixed(2);
          console.log(`${timestamp()} ⏸ Silence detected, processing recording (Spoke for ${recordTime} ms)`);
          await this.processRecording();
          this.resetRecording();
        }
      }
    } catch (error) {
      console.error(`${timestamp()} ❌ Audio processing error:`, error);
    }
  }

  async processRecording() {
    if (this.audioBuffer.length === 0) return;
    const session = global.activeSessions.get(this.callSid);

    try {
      if (session) session.isProcessing = true;

      const combinedBuffer = Buffer.concat(this.audioBuffer);
      const wavBuffer = this.createWavBuffer(combinedBuffer);

      const transcription = await this.transcriptionService.transcribe(wavBuffer);
      this.timings.transcriptionDone = Date.now();
      const transcribeTime = (this.timings.transcriptionDone - this.timings.silenceDetected).toFixed(2);

      console.log(`${timestamp()} ⏱️ Transcription: ${transcription}`);
      console.log(`${timestamp()} 🕒 Time to transcribe: ${transcribeTime} ms`);

      if (transcription && transcription.trim()) {
        this.ragService.getResponse(transcription);
        let lastToken = '';
        let CountToken = 0;

        this.ragService.on('token', token => {
          const TokenCount = CountToken++;
          if (TokenCount === 1) {
            this.timings.llmFirstToken = Date.now();
            const llmDelay = (this.timings.llmFirstToken - this.timings.transcriptionDone).toFixed(2);
            console.log(`${timestamp()} ⏱️ First Token Received`);
            console.log(`${timestamp()} 🕒 LLM delay: ${llmDelay} ms`);
          }

          if (token === '[COMPLETED]') {
            this.ragService.removeAllListeners('token');
            return;
          }

          const needsSpace = lastToken && !/['.,!?]/.test(token) && !/^['’]/.test(token);
          if (needsSpace) this.sentenceBuffer += ' ';
          this.sentenceBuffer += token;
          lastToken = token;

          const boundaries = [];
          let inNumber = false;
          for (let i = 0; i < this.sentenceBuffer.length; i++) {
            const char = this.sentenceBuffer[i];
            if (/\d/.test(char)) {
              inNumber = true;
              continue;
            }
            if (/[.!?]/.test(char)) {
              if (char === '.' && inNumber) continue;
              if (i === this.sentenceBuffer.length - 1 || /\s/.test(this.sentenceBuffer[i + 1])) {
                boundaries.push(i + 1);
              }
            }
            inNumber = false;
          }

          let lastIndex = 0;
          for (const boundary of boundaries) {
            const sentence = this.sentenceBuffer.substring(lastIndex, boundary).trim();
            if (sentence) {
              this.ttsService.synthesize(sentence);
              console.log(`${timestamp()} 💬 LLM First Sentence: "${sentence}"`);
            }
            lastIndex = boundary;
          }

          this.sentenceBuffer = this.sentenceBuffer.substring(lastIndex);
        });

        this.ttsService.removeAllListeners('buffer');

        this.ttsService.on('buffer', audioBuffer => {
          this.timings.ttsAudioReceived = Date.now();
          const ttsTime = (this.timings.ttsAudioReceived - this.timings.llmFirstToken).toFixed(2);
          console.log(`${timestamp()} 💬 TTS Audio Received, Length: ${audioBuffer.length} bytes`);
          console.log(`${timestamp()} 🕒 TTS delay: ${ttsTime} ms`);

          this.playAudioViaMessage(audioBuffer);
        });
      }
    } catch (error) {
      console.error(`${timestamp()} ❌ Recording processing error:`, error);
    } finally {
      if (session) session.isProcessing = false;
    }
  }

  
async playAudioViaMessage(base64PCM) {
  try {
    const now = Date.now();
    const playbackDelay = (now - this.timings.ttsAudioReceived).toFixed(2);
    const totalDelay = (now - this.timings.silenceDetected).toFixed(2); // ⏱️ Total processing time
    console.log(`${timestamp()} 🕒 ⏱️ Time from silence Detected to First playback: ${totalDelay} ms`); // <-- key log
    this.ws.send(JSON.stringify({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: base64PCM },
    }));

    console.log(`${timestamp()} 🔊 Audio sent to Twilio (Playback delay: ${playbackDelay} ms)`);
   
    this.sentenceBuffer = '';
  } catch (error) {
    console.error(`${timestamp()} ❌ Playback failed:`, error);
  }
}

  resetRecording () {
    this.audioBuffer = [];
    this.isRecording = false;
    this.silenceCounter = 0;
  }

  cleanup () {
    this.resetRecording ();
  }

  mulawToPcm (mulawData) {
    const pcmData = Buffer.alloc (mulawData.length * 2);
    for (let i = 0; i < mulawData.length; i++) {
      const mulaw = mulawData[i];
      const pcm = this.mulawToPcmSample (mulaw);
      pcmData.writeInt16LE (pcm, i * 2);
    }
    return pcmData;
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

  createWavBuffer (pcmData, sampleRate = 8000) {
    const length = pcmData.length;
    const buffer = Buffer.alloc (44 + length);
    buffer.write ('RIFF', 0);
    buffer.writeUInt32LE (36 + length, 4);
    buffer.write ('WAVE', 8);
    buffer.write ('fmt ', 12);
    buffer.writeUInt32LE (16, 16);
    buffer.writeUInt16LE (1, 20);
    buffer.writeUInt16LE (1, 22);
    buffer.writeUInt32LE (sampleRate, 24);
    buffer.writeUInt32LE (sampleRate * 2, 28);
    buffer.writeUInt16LE (2, 32);
    buffer.writeUInt16LE (16, 34);
    buffer.write ('data', 36);
    buffer.writeUInt32LE (length, 40);
    pcmData.copy (buffer, 44);
    return buffer;
  }
}

module.exports = AudioProcessor;
