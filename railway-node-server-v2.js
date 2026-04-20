import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import os from "os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai";

const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.includes("youtube.com") || u.hostname.includes("m.youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
    }
    return null;
  } catch { return null; }
}

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return String(hours).padStart(2,"0")+":"+String(minutes).padStart(2,"0")+":"+String(secs).padStart(2,"0")+","+String(millis).padStart(3,"0");
}

function segmentsToSrt(segments) {
  return segments.map((seg, i) => {
    const start = formatSrtTime(seg.start);
    const end = formatSrtTime(seg.start + seg.duration);
    return (i+1)+"\n"+start+" --> "+end+"\n"+seg.text+"\n";
  }).join("\n");
}

function wordCount(text) { return text.trim() ? text.trim().split(/\s+/).length : 0; }

function normalizeText(text) {
  return text.replace(/\s+/g," ").replace(/\s([,.!?;:])/g,"$1").trim();
}

function parseJson3CaptionTrack(json3) {
  const events = Array.isArray(json3?.events) ? json3.events : [];
  const segments = [];
  for (const event of events) {
    const startMs = typeof event.tStartMs === "number" ? event.tStartMs : null;
    const durMs = typeof event.dDurationMs === "number" ? event.dDurationMs : null;
    const segs = Array.isArray(event.segs) ? event.segs : null;
    if (startMs === null || !segs?.length) continue;
    const text = segs.map((s) => (typeof s.utf8 === "string" ? s.utf8 : "")).join("").replace(/\n/g," ").trim();
    if (!text) continue;
    segments.push({ text: normalizeText(text), start: startMs/1000, duration: durMs ? durMs/1000 : 2 });
  }
  const transcript = normalizeText(segments.map((s) => s.text).join(" "));
  return { transcript, segments };
}

async function runYtDlpJson(url) {
  const { stdout } = await execFileAsync("yt-dlp", ["--dump-single-json","--skip-download","--no-warnings","--no-playlist",url], { maxBuffer: 20*1024*1024 });
  return JSON.parse(stdout);
}

function pickSubtitleUrl(info) {
  for (const group of [info?.subtitles||{}, info?.automatic_captions||{}]) {
    for (const lang of Object.keys(group)) {
      const tracks = group[lang];
      if (!Array.isArray(tracks)) continue;
      const json3 = tracks.find((t) => t.ext==="json3" && t.url) || tracks.find((t) => t.url);
      if (json3?.url) return { url: json3.url, language: lang };
    }
  }
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Subtitle fetch failed: "+res.status);
  return await res.json();
}

async function cleanTranscriptWithOpenAI(transcript) {
  if (!openai || !transcript) return transcript;
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Limpia este transcript sin cambiar el significado. Corrige puntuación, separa en párrafos legibles y elimina repeticiones o muletillas obvias. Devuelve solo el texto final." },
      { role: "user", content: transcript },
    ],
    temperature: 0.2,
  });
  return response.choices?.[0]?.message?.content?.trim() || transcript;
}

async function transcribeAudioWithOpenAI(filePath) {
  if (!openai) throw new Error("OPENAI_API_KEY no configurada para fallback");
  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: "whisper-1",
    response_format: "verbose_json",
  });
  const segments = Array.isArray(transcription.segments)
    ? transcription.segments.map((s) => ({ text: normalizeText(s.text||""), start: Number(s.start||0), duration: Math.max(0.1, Number(s.end||0)-Number(s.start||0)) }))
    : [];
  return { transcript: normalizeText(transcription.text||""), segments, language: transcription.language||null, duration: typeof transcription.duration==="number" ? transcription.duration : null };
}

async function fallbackDownloadAudio(url, filePathNoExt) {
  await execFileAsync("yt-dlp", ["--no-playlist","-f","bestaudio/best","-x","--audio-format","mp3","-o",filePathNoExt+".%(ext)s",url], { maxBuffer: 20*1024*1024 });
  return filePathNoExt+".mp3";
}

app.get("/health", (_req, res) => { res.json({ ok: true }); });

app.post("/api/youtube-transcript", async (req, res) => {
  const { url, clean = true } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "URL requerida" });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "URL no válida. Ejemplo: youtu.be/XXX o youtube.com/watch?v=XXX" });

  let tempBase = null;
  try {
    const info = await runYtDlpJson(url);
    if (!info?.id) return res.status(404).json({ error: "Video no encontrado" });
    if (info?.availability === "private" || info?.is_private) return res.status(403).json({ error: "Video privado" });

    const subtitleTrack = pickSubtitleUrl(info);
    let transcript = "", cleanedTranscript = "", segments = [];
    let language = subtitleTrack?.language || info.language || null;
    let duration = typeof info.duration === "number" ? info.duration : null;
    let source = "youtube_captions";

    if (subtitleTrack?.url) {
      const json3 = await fetchJson(subtitleTrack.url);
      const parsed = parseJson3CaptionTrack(json3);
      transcript = parsed.transcript;
      segments = parsed.segments;
    } else {
      tempBase = path.join(os.tmpdir(), "yt-"+videoId+"-"+Date.now());
      const audioPath = await fallbackDownloadAudio(url, tempBase);
      const fallback = await transcribeAudioWithOpenAI(audioPath);
      transcript = fallback.transcript;
      segments = fallback.segments;
      language = fallback.language || language;
      duration = fallback.duration || duration;
      source = "openai_fallback";
    }

    if (!transcript) return res.status(404).json({ error: "Este video no tiene transcript disponible" });

    cleanedTranscript = clean ? await cleanTranscriptWithOpenAI(transcript) : transcript;
    const srt = segments.length ? segmentsToSrt(segments) : "";
    const totalWords = wordCount(cleanedTranscript || transcript);
    const durationMinutes = duration ? Math.round((duration/60)*100)/100 : null;
    const isLongVideo = duration ? duration > 7200 : false;

    return res.json({ transcript, cleanedTranscript, segments, srt, language, duration, durationMinutes, isLongVideo, wordCount: totalWords, source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error al procesar";
    if (message.includes("Video unavailable")) return res.status(404).json({ error: "Video no encontrado" });
    if (message.includes("Private video")) return res.status(403).json({ error: "Video privado" });
    if (message.includes("429")) return res.status(429).json({ error: "YouTube limitó temporalmente la extracción. Intenta de nuevo en unos minutos." });
    return res.status(500).json({ error: "Error al procesar. Intenta de nuevo", details: message });
  } finally {
    if (tempBase) {
      try {
        const dir = path.dirname(tempBase);
        const base = path.basename(tempBase);
        const files = await fs.readdir(dir);
        await Promise.all(files.filter((f) => f.startsWith(base)).map((f) => fs.unlink(path.join(dir,f)).catch(()=>null)));
      } catch {}
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("YouTubeTranscriber API listening on port "+(process.env.PORT||3000));
});
