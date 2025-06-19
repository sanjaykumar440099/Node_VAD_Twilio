const VADDetector = require('../utils/vadDetector');
const TranscriptionService = require('../services/transcriptionService');
const RAGService = require('../services/ragService');
const TTSService = require('../services/ttsService');
const { createWavBuffer } = require('../utils/audioUtils');

class AudioProcessor {
  constructor(callSid, ws) {
    this.callSid = callSid;
    this.ws = ws;
    this.vadDetector = new VADDetector();
    this.transcriptionService = new TranscriptionService();
    this.ragService = new RAGService();
    this.ttsService = new TTSService();
    this.audioBuffer = [];
    this.isRecording = false;
    this.silenceCounter = 0;
    this.silenceThreshold = 50; // ~1 second of silence (20ms chunks)
  }

  async processAudio(audioData) {
    try {
      // Convert mulaw to PCM
      const pcmData = this.mulawToPcm(audioData);
      
      // Detect voice activity
      const hasVoice = this.vadDetector.detect(pcmData);
      
      if (hasVoice) {
        this.isRecording = true;
        this.silenceCounter = 0;
        this.audioBuffer.push(pcmData);
      } else if (this.isRecording) {
        this.silenceCounter++;
        
        if (this.silenceCounter >= this.silenceThreshold) {
          // End of speech detected
          await this.processRecording();
          this.resetRecording();
        }
      }
    } catch (error) {
      console.error('Audio processing error:', error);
    }
  }

  async processRecording() {
    if (this.audioBuffer.length === 0) return;
    
    try {
      // Set session as processing
      const session = global.activeSessions.get(this.callSid);
      if (session) {
        session.isProcessing = true;
      }
      
      // Combine audio buffers and create WAV
      const combinedBuffer = Buffer.concat(this.audioBuffer);
      const wavBuffer = createWavBuffer(combinedBuffer);
      
      // Transcribe audio
      const transcription = await this.transcriptionService.transcribe(wavBuffer);
      
      if (transcription && transcription.trim()) {
        console.log('Transcription:', transcription);
        
        // Get RAG response
        const ragResponse = await this.ragService.getResponse(transcription);
        
        // Convert to speech and play
        const audioResponse = await this.ttsService.synthesize(ragResponse);
        await this.playAudio(audioResponse);
      }
      
      // Release processing lock
      if (session) {
        session.isProcessing = false;
      }
      
    } catch (error) {
      console.error('Recording processing error:', error);
      
      // Release processing lock on error
      const session = global.activeSessions.get(this.callSid);
      if (session) {
        session.isProcessing = false;
      }
    }
  }

  async playAudio(audioBuffer) {
    try {
      // Convert WAV to mulaw for Twilio
      const mulawData = this.pcmToMulaw(audioBuffer);
      const base64Audio = mulawData.toString('base64');
      
      // Send audio to Twilio
      const message = {
        event: 'media',
        streamSid: this.callSid,
        media: {
          payload: base64Audio
        }
      };
      
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Audio playback error:', error);
    }
  }

  mulawToPcm(mulawData) {
    // Simplified mulaw to PCM conversion
    const pcmData = Buffer.alloc(mulawData.length * 2);
    
    for (let i = 0; i < mulawData.length; i++) {
      const mulaw = mulawData[i];
      const pcm = this.mulawToPcmSample(mulaw);
      pcmData.writeInt16LE(pcm, i * 2);
    }
    
    return pcmData;
  }

  pcmToMulaw(pcmData) {
    const mulawData = Buffer.alloc(pcmData.length / 2);
    
    for (let i = 0; i < pcmData.length; i += 2) {
      const pcm = pcmData.readInt16LE(i);
      const mulaw = this.pcmToMulawSample(pcm);
      mulawData[i / 2] = mulaw;
    }
    
    return mulawData;
  }

  mulawToPcmSample(mulaw) {
    const MULAW_BIAS = 0x84;
    const MULAW_MAX = 0x1FFF;
    
    mulaw = ~mulaw;
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    
    let sample = mantissa << (exponent + 3);
    sample += MULAW_BIAS;
    
    return sign ? -sample : sample;
  }

  pcmToMulawSample(pcm) {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 0x84;
    
    const sign = pcm < 0 ? 0x80 : 0;
    if (pcm < 0) pcm = -pcm;
    
    pcm += MULAW_BIAS;
    if (pcm > MULAW_MAX) pcm = MULAW_MAX;
    
    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
      if (pcm <= (0x1F << (exp + 3))) {
        exponent = exp;
        break;
      }
    }
    
    const mantissa = (pcm >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa);
  }

  resetRecording() {
    this.audioBuffer = [];
    this.isRecording = false;
    this.silenceCounter = 0;
  }

  cleanup() {
    this.resetRecording();
  }
}

module.exports = AudioProcessor;