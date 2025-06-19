// ============ services/audioProcessor.js ============
const VADDetector = require('../utils/vadDetector');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const twilioClient = require('../config/twilio');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const TranscriptionService = require('./transcriptionService');
const RAGService = require('./ragService');
const TTSService = require('./ttsService');

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
          const startTime = performance.now(); // Start timing
          await this.processRecording();
          const endTime = performance.now(); // End timing
          const processTime = (endTime - startTime) / 1000; // Calculate response time
          console.log('Total Process Time: ' + processTime)
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
      const startTime = performance.now(); // Start timing
      const combinedBuffer = Buffer.concat(this.audioBuffer);
      const wavBuffer = this.createWavBuffer(combinedBuffer);
      const endTime = performance.now(); // End timing
      const processTime = (endTime - startTime) / 1000; // Calculate response time
      console.log('Total Process Time to create wave buffer: ' + processTime)
    

      fs.writeFileSync('response.wav', wavBuffer);
      // Transcribe audio
      const startTimeTrans = performance.now(); // Start timing
      const transcription = await this.transcriptionService.transcribe(wavBuffer);
      const endTimeTrans = performance.now(); // End timing
      const processTimeTrans = (endTimeTrans - startTimeTrans) / 1000; // Calculate response time
      console.log('Total Process Time ASR: ' + processTimeTrans)

    
      
      if (transcription && transcription.trim()) {
        console.log('Transcription:', transcription);
        
        // Get RAG response
         const startTimeRag = performance.now(); // Start timing
         const ragResponse = await this.ragService.getResponse(transcription);
         const endTimeRag = performance.now(); // End timing
         const processTimeRag = (endTimeRag - startTimeRag) / 1000; // Calculate response time
         console.log('Total Process Time RAG: ' + processTimeRag)
        
        // Convert to speech and play
        const startTimeTts = performance.now(); // Start timing
        const audioResponse = await this.ttsService.synthesize(ragResponse);
        const endTimeTts = performance.now(); // End timing
        const processTimeTts = (endTimeTts - startTimeTts) / 1000; // Calculate response time
        console.log('Total Process Time TTS: ' + processTimeTts)
        await this.playAudioViaMessage(audioResponse);
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

  async playAudioViaMessage(audioBuffer) {
    try {
      const startTimePlayAudio = performance.now(); // Start timing
    
      // Ensure temp directory exists
      const tempDir = path.join(__dirname, '../public/temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Create unique filename
      const audioId = uuidv4();
      const audioPath = path.join(tempDir, `${audioId}.wav`);
      
      // Save audio buffer to file
      fs.writeFileSync(audioPath, audioBuffer);
      console.log(`Audio saved to: ${audioPath}`);
      
      // Use Twilio REST API to redirect the call to play audio
     
      
      // Create TwiML to play the audio
      const twiml = new VoiceResponse();
      twiml.play(`${process.env.NGROK_URL}/temp/${audioId}.wav`);
      
      // Pause to allow user to ask next question
      twiml.pause({ length: 1 });
      
      // Continue listening for more audio
      const connect = twiml.connect();
      connect.stream({
        url: `wss://${process.env.NGROK_URL.replace('https://', '').replace('http://', '')}/`
      });
      
      // Update the call with new TwiML
      await twilioClient.calls(this.callSid).update({
        twiml: twiml.toString()
      });

      // Clean up file after delay
      setTimeout(() => {
        try {
          if (fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
            console.log(`Cleaned up audio file: ${audioId}.wav`);
          }
        } catch (error) {
          console.error('Error cleaning up audio file:', error);
        }
      }, 60000); // 60 seconds delay
      
    } catch (error) {
      console.error('Audio playback via message error:', error);
    }
  }

  extractPcmFromWav(wavBuffer) {
    // WAV header is typically 44 bytes, extract PCM data after header
    if (wavBuffer.length <= 44) {
      throw new Error('Invalid WAV buffer size');
    }
    
    // Find the data chunk
    let dataOffset = 44; // Standard WAV header size
    
    // Look for 'data' chunk identifier in case header is non-standard
    for (let i = 12; i < wavBuffer.length - 4; i++) {
      if (wavBuffer.slice(i, i + 4).toString() === 'data') {
        dataOffset = i + 8; // Skip 'data' + size (4 bytes each)
        break;
      }
    }
    
    return wavBuffer.slice(dataOffset);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  mulawToPcm(mulawData) {
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
    // Invert all bits (standard mu-law decoding step)
    mulaw = ~mulaw & 0xFF;
    // Extract components
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    // Reconstruct the linear sample
    let sample;
    if (exponent === 0) {
        // Special case for exponent 0
        sample = (mantissa << 1) + MULAW_BIAS;
    } else {
        // Standard case
        sample = ((mantissa | 0x10) << (exponent + 3)) + MULAW_BIAS;
    }
    // Apply sign and ensure 16-bit range
    const result = sign ? -sample : sample;
    // Clamp to 16-bit signed integer range
    return Math.max(-32768, Math.min(32767, result));
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

  createWavBuffer(pcmData, sampleRate = 8000) {
    const length = pcmData.length;
    const buffer = Buffer.alloc(44 + length);
    
    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + length, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(1, 22); // Mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(length, 40);
    
    // Copy PCM data
    pcmData.copy(buffer, 44);
    
    return buffer;
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