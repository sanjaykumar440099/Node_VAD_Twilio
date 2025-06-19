const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
require('dotenv').config();

const voiceRoutes = require('./routes/voice');
const AudioProcessor = require('./services/audioProcessor');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/', voiceRoutes);

// Store active call sessions
global.activeSessions = new Map();

// WebSocket connection for Twilio Media Streams

// Serve static files with proper headers
app.use('/temp', express.static(path.join(__dirname, 'public', 'temp'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.wav')) {
      res.set('Content-Type', 'audio/wav');
    }
  }
}));

// WebSocket connection for Twilio Media Streams
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  
  let callSid = null;
  let streamSid = null;
  let audioProcessor = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.event) {
        case 'connected':
          console.log('Connected to Twilio Media Stream');
          break;
          
        case 'start':
          callSid = data.start.callSid;
          streamSid = data.start.streamSid;
          console.log(`Starting stream for call ${callSid}`);
          
          // Initialize audio processor for this call
          audioProcessor = new AudioProcessor(callSid, ws, streamSid);
          global.activeSessions.set(callSid, {
            ws: ws,
            processor: audioProcessor,
            isProcessing: false
          });
          break;
          
        case 'media':
          if (audioProcessor && !global.activeSessions.get(callSid)?.isProcessing) {
            const audioData = Buffer.from(data.media.payload, 'base64');
            await audioProcessor.processAudio(audioData);
          }
          break;
          
        case 'stop':
          console.log(`Stream stopped for call ${callSid}`);
          if (audioProcessor) {
            audioProcessor.cleanup();
          }
          global.activeSessions.delete(callSid);
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    if (callSid) {
      global.activeSessions.delete(callSid);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Ngrok URL: ${process.env.NGROK_URL}`);
});