import express from 'express';
import cors from 'cors';
import { execSync, exec } from 'child_process';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
const port = process.env.PORT || 3000;
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

// Helper function to validate YouTube URL
function isValidYoutubeUrl(url) {
    const regex = /(?:youtube\.com\/.*v=|youtu\.be\/|shorts\/)([^&\n?#]+)/;
                                                                  return regex.test(url);
                                                                }

                                                                // Helper function to extract video ID
                                                                function getVideoId(url) {
                                                                    const regex = /(?:youtube\.com\/.*v=|youtu\.be\/|shorts\/)([^&\n?#]+)/;
                                                                                                                                  const match = url.match(regex);
                                                                                                                                  return match ? match[1] : null;
                                                                                                                                }
                                                                                                                                
                                                                                                                                // Helper function to parse JSON3 format (YouTube captions format)
                                                                                                                                function parseJson3Captions(json3Text) {
                                                                                                                                    try {
                                                                                                                                          const json3 = JSON.parse(json3Text);
                                                                                                                                          if (!json3.events) return null;
                                                                                                                                          
                                                                                                                                          const segments = [];
                                                                                                                                          for (const event of json3.events) {
                                                                                                                                                  if (event.segs) {
                                                                                                                                                            let text = '';
                                                                                                                                                            for (const seg of event.segs) {
                                                                                                                                                                        text += seg.utf8 || '';
                                                                                                                                                                      }
                                                                                                                                                            if (text.trim()) {
                                                                                                                                                                        segments.push({
                                                                                                                                                                                      text: text.trim(),
                                                                                                                                                                                      start: (event.tStartMs || 0) / 1000,
                                                                                                                                                                                      duration: (event.dDurationMs || 0) / 1000
                                                                                                                                                                                    });
                                                                                                                                                                      }
                                                                                                                                                          }
                                                                                                                                                }
                                                                                                                                          return segments.length > 0 ? segments : null;
                                                                                                                                        } catch (e) {
                                                                                                                                          return null;
                                                                                                                                        }
                                                                                                                                  }
                                                                                                                                
                                                                                                                                // Helper function to generate SRT from segments
                                                                                                                                function generateSRT(segments) {
                                                                                                                                    if (!segments || segments.length === 0) return '';
                                                                                                                                    
                                                                                                                                    return segments.map((seg, idx) => {
                                                                                                                                          const start = seg.start;
                                                                                                                                          const end = seg.start + seg.duration;
                                                                                                                                          
                                                                                                                                          const formatTime = (seconds) => {
                                                                                                                                                  const hours = Math.floor(seconds / 3600);
                                                                                                                                                  const minutes = Math.floor((seconds % 3600) / 60);
                                                                                                                                                  const secs = Math.floor(seconds % 60);
                                                                                                                                                  const ms = Math.floor((seconds % 1) * 1000);
                                                                                                                                                  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
                                                                                                                                                };
                                                                                                                                          
                                                                                                                                          return `${idx + 1}\n${formatTime(start)} --> ${formatTime(end)}\n${seg.text}\n`;
                                                                                                                                        }).join('\n');
                                                                                                                                  }
                                                                                                                                
                                                                                                                                // Helper function to clean transcript using GPT
                                                                                                                                async function cleanTranscript(text) {
                                                                                                                                    try {
                                                                                                                                          const response = await openai.chat.completions.create({
                                                                                                                                                  model: 'gpt-4-mini',
                                                                                                                                                  messages: [
                                                                                                                                                            {
                                                                                                                                                                        role: 'system',
                                                                                                                                                                        content: 'You are a professional transcript editor. Clean up the provided transcript by: 1) Fixing obvious typos and grammar, 2) Removing filler words (um, uh, like), 3) Making it more readable while preserving exact meaning. Keep it concise and natural. Output only the cleaned transcript.'
                                                                                                                                                                      },
                                                                                                                                                            {
                                                                                                                                                                        role: 'user',
                                                                                                                                                                        content: text
                                                                                                                                                                      }
                                                                                                                                                          ],
                                                                                                                                                  temperature: 0.3,
                                                                                                                                                  max_tokens: 4000
                                                                                                                                                });
                                                                                                                                          
                                                                                                                                          return response.choices[0].message.content || text;
                                                                                                                                        } catch (e) {
                                                                                                                                          console.error('Cleaning error:', e.message);
                                                                                                                                          return text;
                                                                                                                                        }
                                                                                                                                  }
                                                                                                                                
                                                                                                                                // Helper function to get video duration using yt-dlp
                                                                                                                                async function getVideoDuration(videoId) {
                                                                                                                                    try {
                                                                                                                                          const output = execSync(`yt-dlp --dump-json --skip-download "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null | grep -o '"duration":[0-9]*' | grep -o '[0-9]*'`, {
                                                                                                                                                  encoding: 'utf-8',
                                                                                                                                                  maxBuffer: 10 * 1024 * 1024
                                                                                                                                                });
                                                                                                                                          return parseInt(output.trim()) || 0;
                                                                                                                                        } catch (e) {
                                                                                                                                          return 0;
                                                                                                                                        }
                                                                                                                                  }
                                                                                                                                
                                                                                                                                // Main transcript extraction endpoint
                                                                                                                                app.post('/api/youtube-transcript', async (req, res) => {
                                                                                                                                    try {
                                                                                                                                          const { url, clean } = req.body;
                                                                                                                                      
                                                                                                                                          if (!url || !isValidYoutubeUrl(url)) {
                                                                                                                                                  return res.status(400).json({
                                                                                                                                                            error: 'URL no válida. Ejemplo: youtu.be/XXX o youtube.com/watch?v=XXX'
                                                                                                                                                          });
                                                                                                                                                }
                                                                                                                                      
                                                                                                                                          const videoId = getVideoId(url);
                                                                                                                                          if (!videoId) {
                                                                                                                                                  return res.status(400).json({
                                                                                                                                                            error: 'No se pudo extraer el ID del video'
                                                                                                                                                          });
                                                                                                                                                }
                                                                                                                                      
                                                                                                                                          const duration = await getVideoDuration(videoId);
                                                                                                                                          const durationMinutes = Math.ceil(duration / 60);
                                                                                                                                          const isLongVideo = duration > 7200;
                                                                                                                                      
                                                                                                                                          let transcript = null;
                                                                                                                                          let segments = null;
                                                                                                                                          let source = 'youtube_captions';
                                                                                                                                          let language = 'en';
                                                                                                                                      
                                                                                                                                          try {
                                                                                                                                                  const captionsOutput = execSync(
                                                                                                                                                            `yt-dlp --dump-json --skip-download "${url}" 2>/dev/null`,
                                                                                                                                                            { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
                                                                                                                                                          );
                                                                                                                                                  
                                                                                                                                                  const videoData = JSON.parse(captionsOutput);
                                                                                                                                                  
                                                                                                                                                  if (videoData.subtitles && Object.keys(videoData.subtitles).length > 0) {
                                                                                                                                                            const languages = Object.keys(videoData.subtitles);
                                                                                                                                                            const lang = languages.find(l => l.startsWith('en')) || languages[0];
                                                                                                                                                            language = lang.split('-')[0];
                                                                                                                                                            
                                                                                                                                                            if (videoData.subtitles[lang] && videoData.subtitles[lang].length > 0) {
                                                                                                                                                                        const captionUrl = videoData.subtitles[lang][0].url;
                                                                                                                                                                        const captionData = execSync(`curl -s "${captionUrl}" 2>/dev/null`, {
                                                                                                                                                                                      encoding: 'utf-8',
                                                                                                                                                                                      maxBuffer: 50 * 1024 * 1024
                                                                                                                                                                                    });
                                                                                                                                                                        
                                                                                                                                                                        segments = parseJson3Captions(captionData);
                                                                                                                                                                        
                                                                                                                                                                        if (segments) {
                                                                                                                                                                                      transcript = segments.map(s => s.text).join(' ');
                                                                                                                                                                                    }
                                                                                                                                                                      }
                                                                                                                                                          }
                                                                                                                                                } catch (e) {
                                                                                                                                                  console.log('Caption extraction failed, will try fallback:', e.message);
                                                                                                                                                }
                                                                                                                                      
                                                                                                                                          if (!transcript) {
                                                                                                                                                  if (!process.env.OPENAI_API_KEY) {
                                                                                                                                                            return res.status(500).json({
                                                                                                                                                                        error: 'Este video no tiene transcript disponible y el servicio de transcripcion no esta configurado'
                                                                                                                                                                      });
                                                                                                                                                          }
                                                                                                                                            
                                                                                                                                                  try {
                                                                                                                                                            source = 'openai_fallback';
                                                                                                                                                            const tempDir = os.tmpdir();
                                                                                                                                                            const audioPath = path.join(tempDir, `audio_${videoId}.mp3`);
                                                                                                                                                    
                                                                                                                                                            execSync(`yt-dlp -x --audio-format mp3 -o "${audioPath}" "${url}" 2>/dev/null`, {
                                                                                                                                                                        timeout: 300000
                                                                                                                                                                      });
                                                                                                                                                    
                                                                                                                                                            const audioFile = fs.createReadStream(audioPath);
                                                                                                                                                            const transcriptResponse = await openai.audio.transcriptions.create({
                                                                                                                                                                        file: audioFile,
                                                                                                                                                                        model: 'whisper-1',
                                                                                                                                                                        language: 'en'
                                                                                                                                                                      });
                                                                                                                                                    
                                                                                                                                                            transcript = transcriptResponse.text;
                                                                                                                                                    
                                                                                                                                                            try {
                                                                                                                                                                        fs.unlinkSync(audioPath);
                                                                                                                                                                      } catch (e) {
                                                                                                                                                                        console.log('Could not delete temp audio file:', e.message);
                                                                                                                                                                      }
                                                                                                                                                          } catch (e) {
                                                                                                                                                            console.error('Whisper fallback error:', e.message);
                                                                                                                                                            
                                                                                                                                                            if (e.message.includes('Private')) {
                                                                                                                                                                        return res.status(403).json({
                                                                                                                                                                                      error: 'Este video es privado'
                                                                                                                                                                                    });
                                                                                                                                                                      }
                                                                                                                                                            
                                                                                                                                                            if (e.message.includes('Not Found') || e.message.includes('404')) {
                                                                                                                                                                        return res.status(404).json({
                                                                                                                                                                                      error: 'Video no encontrado. Verifica el enlace'
                                                                                                                                                                                    });
                                                                                                                                                                      }
                                                                                                                                                    
                                                                                                                                                            if (e.message.includes('429') || e.message.includes('Too Many')) {
                                                                                                                                                                        return res.status(429).json({
                                                                                                                                                                                      error: 'YouTube limito la extraccion. Intenta en unos minutos.'
                                                                                                                                                                                    });
                                                                                                                                                                      }
                                                                                                                                                    
                                                                                                                                                            return res.status(500).json({
                                                                                                                                                                        error: 'Error al procesar el video. Intenta de nuevo mas tarde.'
                                                                                                                                                                      });
                                                                                                                                                          }
                                                                                                                                                }
                                                                                                                                      
                                                                                                                                          if (!transcript) {
                                                                                                                                                  return res.status(404).json({
                                                                                                                                                            error: 'Este video no tiene transcript disponible'
                                                                                                                                                          });
                                                                                                                                                }
                                                                                                                                      
                                                                                                                                          let cleanedTranscript = transcript;
                                                                                                                                          if (clean) {
                                                                                                                                                  cleanedTranscript = await cleanTranscript(transcript);
                                                                                                                                                }
                                                                                                                                      
                                                                                                                                          if (!segments) {
                                                                                                                                                  segments = [];
                                                                                                                                                  const words = cleanedTranscript.split(/\s+/);
                                                                                                                                                  let currentTime = 0;
                                                                                                                                                  const wordDuration = duration / words.length;
                                                                                                                                                  
                                                                                                                                                  segments = words.map(word => {
                                                                                                                                                            const start = currentTime;
                                                                                                                                                            currentTime += wordDuration;
                                                                                                                                                            return {
                                                                                                                                                                        text: word,
                                                                                                                                                                        start: start,
                                                                                                                                                                        duration: wordDuration
                                                                                                                                                                      };
                                                                                                                                                          });
                                                                                                                                                }
                                                                                                                                      
                                                                                                                                          const srt = generateSRT(segments);
                                                                                                                                          const wordCount = transcript.split(/\s+/).length;
                                                                                                                                      
                                                                                                                                          res.json({
                                                                                                                                                  transcript,
                                                                                                                                                  cleanedTranscript,
                                                                                                                                                  segments,
                                                                                                                                                  srt,
                                                                                                                                                  language,
                                                                                                                                                  duration,
                                                                                                                                                  durationMinutes,
                                                                                                                                                  wordCount,
                                                                                                                                                  isLongVideo,
                                                                                                                                                  source
                                                                                                                                                });
                                                                                                                                      
                                                                                                                                        } catch (error) {
                                                                                                                                          console.error('Endpoint error:', error);
                                                                                                                                          res.status(500).json({
                                                                                                                                                  error: 'Error al procesar. Intenta de nuevo'
                                                                                                                                                });
                                                                                                                                        }
                                                                                                                                  });
                                                                                                                                
                                                                                                                                app.listen(port, () => {
                                                                                                                                    console.log(`YouTubeTranscriber API listening on port ${port}`);
                                                                                                                                  });
