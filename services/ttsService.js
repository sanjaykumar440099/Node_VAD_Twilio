const WebSocket = require('ws');
const EventEmitter = require('events');

class TTSService extends EventEmitter {
  constructor() {
    super();
    this.wsUrl = 'ws://164.52.194.17:8250/TranscribeStreaming';
  }

  synthesize(sentence) {
    const ws = new WebSocket(this.wsUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify(sentence));
    });

    ws.on('message', (data) => {
      try {
        const audioChunk = JSON.parse(data.toString());
        if (audioChunk && audioChunk.ulaw) {
         this.emit('buffer', audioChunk.ulaw);
         ws.close();
        }
      } catch (error) {
        console.error('TTS message parsing error:', error);
      }
    });

    ws.on('close', () => {
     
    });

    ws.on('error', (error) => {
      console.error('TTS WebSocket error:', error);
    });
  }
}

module.exports = TTSService;
