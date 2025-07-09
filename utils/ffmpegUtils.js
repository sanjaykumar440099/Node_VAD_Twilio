// File: utils/ffmpegUtils.js
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');

async function saveMuLawToFile(buffer, filename = 'input.ulaw') {
  const filePath = path.join(__dirname, '../temp', filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function convertMuLawToWavBuffer(muLawBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-f', 'wav',
      'pipe:1'
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`FFmpeg failed with code ${code}`));
    });

    ffmpeg.on('error', reject);
    ffmpeg.stderr.on('data', data => console.log(data.toString()));
    
    // Write the mu-law buffer to FFmpeg's stdin
    ffmpeg.stdin.write(muLawBuffer);
    ffmpeg.stdin.end();
  });
}

async function convertMuLawToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
     const ffmpeg = spawn(ffmpegPath,  [
      '-y',
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      '-i', inputPath,
      outputPath
    ]);

    ffmpeg.stderr.on('data', data => console.log(data.toString()));
    ffmpeg.on('close', code => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`FFmpeg failed with code ${code}`));
    });

    ffmpeg.on('error', reject);
  });
}

async function isSilenceDetected(wavPath, minDuration = 1) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-i', wavPath,
      '-af', `silencedetect=noise=-30dB:d=${minDuration}`,
      '-f', 'null',
      '-'
    ]);

    let output = '';
    ffmpeg.stderr.on('data', data => output += data.toString());

    ffmpeg.on('close', () => {
      const silenceFound = output.includes('silence_start');
      resolve(silenceFound);
    });

    ffmpeg.on('error', reject);
  });
}

module.exports = {
  saveMuLawToFile,
  convertMuLawToWav,
  convertMuLawToWavBuffer,
  isSilenceDetected
};