const WebSocket = require('ws');

class WebSocketManager {
  constructor() {
    this.pendingConnections = new Map();
    this.activeConnections = new Map();
    this.wss = null;
  }

  initialize(server) {
     this.wss = new WebSocket.Server({
      noServer: true,
      clientTracking: true,
      perMessageDeflate: false, // Disable compression for Twilio compatibility
      maxPayload: 1024 * 1024 // 1MB payload limit
    });
   // this.wss = new WebSocket.Server({ noServer: true });

   
    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
      
      if (pathname !== '/stream') {
        socket.destroy();
        return;
      }

      // Store the entire request object
      this.pendingConnections.set(req.headers['sec-websocket-key'], {
        socket,
        head,
        req,
        timestamp: Date.now()
      });
      console.log(`Pending connection (Key: ${req.headers['sec-websocket-key']})`);
    });
  }

  // In websocketManager.js
async  completeUpgrade(callSid) {
  // Find any pending connection (Twilio may not send the same key)
  if (this.pendingConnections.size === 0) {
    console.log('No pending connections, but proceeding anyway');
  }

  // Get the first pending connection (modify as needed for your use case)
  const [key, conn] = this.pendingConnections.entries().next().value || [];
  
  if (conn) {
    this.pendingConnections.delete(key);
    console.log(`Processing pending connection for ${callSid}`);
  }

  return new Promise((resolve) => {
    // Create new WebSocket server if needed
    if (!this.wss) {
      this.wss = new WebSocket.Server({ noServer: true });
    }

    // Mock upgrade if no pending connection exists
    if (!conn) {
      console.log(`Creating new connection for ${callSid}`);
      const mockSocket = new WebSocket(`wss://${config.NGROK_URL}/stream`);
      mockSocket.callSid = callSid;
      this.activeConnections.set(callSid, mockSocket);
      return resolve(true);
    }

    this.wss.handleUpgrade(
      conn.req,
      conn.socket,
      conn.head,
      (ws) => {
        ws.callSid = callSid;
        this.activeConnections.set(callSid, ws);
        console.log(`Successfully upgraded connection for ${callSid}`);
        resolve(true);
      }
    );
  });
 }
}

module.exports = new WebSocketManager();