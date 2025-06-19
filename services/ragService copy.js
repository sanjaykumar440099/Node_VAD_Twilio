const WebSocket = require('ws');

class RAGService {
  constructor() {
    this.wsUrl = process.env.RAG_WEBSOCKET_URL;
  }

  async getResponse(query) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      let sentenceBuffer = '';
      let finalSentences = [];
      let lastToken = '';

      const payload = {question: query, email: 'xyz@gmail.com'}
      ws.on('open', () => {
        ws.send(JSON.stringify(payload));
      });

      ws.on('message', (data) => {
        try {
           const token = data.toString().trim();
          if (token != '[COMPLETED]') { 
              const needsSpace = lastToken && !/['.,!?]/.test(token) && !/^['’]/.test(token);
              if (needsSpace) sentenceBuffer += ' ';
              sentenceBuffer += token;
              lastToken = token;

              const boundaries = [];
              let inNumber = false;
              for (let i = 0; i < sentenceBuffer.length; i++) {
                const char = sentenceBuffer[i];
                if (/\d/.test(char)) {
                  inNumber = true;
                  continue;
                }
                if (/[.!?]/.test(char)) {
                  if (char === '.' && inNumber) continue;
                  if (i === sentenceBuffer.length - 1 || /\s/.test(sentenceBuffer[i + 1])) {
                    boundaries.push(i + 1);
                  }
                }
                inNumber = false;
              }

              let lastIndex = 0;
              for (const boundary of boundaries) {
                const sentence = sentenceBuffer.substring(lastIndex, boundary).trim();
                if (sentence) finalSentences.push(sentence);
                lastIndex = boundary;
              }

              sentenceBuffer = sentenceBuffer.substring(lastIndex);
            }else {
            ws.close();
          }
          
        } catch (error) {
          console.error('RAG message parsing error:', error);
        }
      });

       ws.on('close', () => {
        if (finalSentences) {
          resolve(finalSentences.join(' '));
        } else {
          resolve('I apologize, but I could not process your request.');
        }
      });

      ws.on('error', (error) => {
        console.error('RAG WebSocket error:', error);
        reject(error);
      });
    });
  }
}

module.exports = RAGService;