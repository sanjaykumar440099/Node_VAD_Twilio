const axios = require('axios');
const FormData = require('form-data');

class TranscriptionService {
  constructor() {
    this.apiUrl = process.env.TRANSCRIBE_API_URL;
  }

  async transcribe(wavBuffer) {
    try {
     const formData = new FormData ();
    formData.append ('file', wavBuffer, {filename: 'converted-audio.wav',contentType: 'audio/wav'});
    const uploadResponse = await axios.post (this.apiUrl, formData,{
        headers: formData.getHeaders (),
      });
      return uploadResponse.data.transcription || 'Soory! I did not receive any input, please try again';
    } catch (error) {
      console.error('Transcription error:', error.message);
      return null;
    }
  }
}

module.exports = TranscriptionService;