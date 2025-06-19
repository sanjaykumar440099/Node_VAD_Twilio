const express = require('express');
const twilio = require('twilio');
const twilioClient = require('../config/twilio');

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

// Handle incoming calls
router.post('/incoming-call', (req, res) => {
  const twiml = new VoiceResponse();
  // Greet the user
  twiml.say({voice: 'alice',language: 'en-US'}, 'Please ask me anything.');
  // Play a beep sound
  twiml.play({ digits: 'w' });
  
  // Start media stream
  const connect = twiml.connect();
  const stream = connect.stream({
    url: `wss://${req.get('host').replace('http://', '').replace('https://', '')}/`
  });
   twiml.pause({ length: 3600 });
  res.type('text/xml');
  res.send(twiml.toString());
});

// Make outbound call
router.post('/call', async (req, res) => {
  try {
    const to = req.body.toNumber;
    if (!to) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    const call = await twilioClient.calls.create({
      url: `${process.env.NGROK_URL}/incoming-call`,
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    
    res.json({ 
      success: true, 
      callSid: call.sid,
      message: 'Call initiated successfully'
    });
  } catch (error) {
    console.error('Error making call:', error);
    res.status(500).json({ error: 'Failed to make call' });
  }
});

module.exports = router;