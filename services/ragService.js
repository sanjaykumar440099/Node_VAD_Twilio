const WebSocket = require('ws');
const EventEmitter = require('events');

class RAGService extends EventEmitter {
  constructor() {
    super();
    this.wsUrl = process.env.RAG_WEBSOCKET_URL;
  }

  getResponse(query) {
    const ws = new WebSocket(this.wsUrl);
    const payload = { prompt: query };

    ws.on('open', () => {
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (data) => {
      try {
        const token = data.toString().trim();
        this.emit('token', token);
      } catch (error) {
        console.error('RAG message parsing error:', error);
        this.emit('error', error);
      }
    });

    ws.on('error', (error) => {
      console.error('RAG WebSocket error:', error);
      this.emit('error', error);
    });

    ws.on('close', () => {
      // optional: this.emit('closed');
    });
  }
}

module.exports = RAGService;
