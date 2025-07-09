// services/sessionManager.js

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Initialize session map if not already done
if (!global.activeSessions) {
  global.activeSessions = new Map();
}

// Create a new session
function createSession(callSid, streamSid, ws, processor) {
  const session = {
    callSid,
    streamSid,
    ws,
    processor,
    isProcessing: false,
    createdAt: Date.now(),
  };

  global.activeSessions.set(callSid, session);
  console.log(`[📞] Session created: ${callSid}`);
  return session;
}

// Get an existing session
function getSession(callSid) {
  return global.activeSessions.get(callSid);
}

// Check if a session exists
function hasSession(callSid) {
  return global.activeSessions.has(callSid);
}

// Delete a session
function deleteSession(callSid) {
  const session = global.activeSessions.get(callSid);
  if (session) {
    session.processor?.cleanup?.();
    global.activeSessions.delete(callSid);
    console.log(`[🧹] Session deleted: ${callSid}`);
  }
}

// Automatically clean up old sessions
function startAutoCleanup(intervalMs = 60000) {
  setInterval(() => {
    const now = Date.now();
    for (const [callSid, session] of global.activeSessions.entries()) {
      if (now - session.createdAt > SESSION_TIMEOUT_MS) {
        console.log(`[⏱️] Auto-expiring session: ${callSid}`);
        deleteSession(callSid);
      }
    }
  }, intervalMs);
}

module.exports = {
  createSession,
  getSession,
  hasSession,
  deleteSession,
  startAutoCleanup,
};
