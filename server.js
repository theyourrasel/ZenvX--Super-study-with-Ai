require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const server = http.createServer(app);

// Real-Time Socket.io Server (Messenger Chat + Audio/Video WebRTC Signaling)
// This project serves its frontend and API from one origin. Socket.IO is retained
// for the existing signaling prototype, but the frontend calling client is not complete.
const socketOptions = { maxHttpBufferSize: 5e7 }; // 50MB max payload for chat media
if (process.env.ALLOWED_ORIGIN) {
  socketOptions.cors = { origin: process.env.ALLOWED_ORIGIN.split(',').map(value => value.trim()).filter(Boolean), methods: ['GET', 'POST'] };
}
const io = new Server(server, socketOptions);

// The frontend and API are served from this same origin, so permissive CORS is unnecessary.
app.disable('x-powered-by');
// Render terminates TLS at its proxy; trust one proxy hop for correct client IPs.
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Small in-memory rate limit for public AI endpoints. For multi-instance production,
// replace with a shared store (e.g. Redis). No user data is persisted by this limiter.
const requestBuckets = new Map();
function limitRequests({ windowMs, max, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || req.socket.remoteAddress}:${req.path}`;
    let bucket = requestBuckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) bucket = { start: now, count: 0 };
    bucket.count += 1; requestBuckets.set(key, bucket);
    if (bucket.count > max) return res.status(429).json({ success: false, error: message });
    if (requestBuckets.size > 5000) {
      for (const [k, v] of requestBuckets) if (now - v.start > windowMs) requestBuckets.delete(k);
    }
    next();
  };
}

// TURN credentials are optional. They are delivered to browsers because WebRTC needs them;
// use short-lived credentials from your TURN provider for production deployments.
app.get('/api/config/rtc', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const configured = process.env.ICE_SERVERS_JSON ? JSON.parse(process.env.ICE_SERVERS_JSON) : null;
    const iceServers = Array.isArray(configured) && configured.length ? configured : [{ urls: 'stun:stun.l.google.com:19302' }];
    if (iceServers.some(server => !server || !(typeof server.urls === 'string' || Array.isArray(server.urls)))) throw new Error('Invalid ICE server config');
    res.json({ iceServers });
  } catch (_) {
    res.status(500).json({ error: 'Invalid ICE_SERVERS_JSON configuration.' });
  }
});

// Render health check: confirms the single web service process is responding.
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'zenvx-study',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY)
  });
});

// Temporary upload directory for large PDFs, Docs, and high-res images
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB file limit
});

// Initialize Google Gemini AI
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

/************************************************************************
 * 1. ZenvXai AUTO-PROMPT ENGINEERING & LARGE FILE / CAMERA SCANNER API
 ************************************************************************/
const ZENVX_STYD_SYSTEM_PROMPT = `
You are "ZenvXai", the official AI Academic Professor inside the "ZenvX Study" super app.
Whenever a student sends a messy question, a scanned math/physics photo from the calculator, or a large document, always organize your answer into this clean structure:

1. **মূল ধারণা (Core Concept):** Clear academic summary.
2. **প্রয়োজনীয় সূত্র ও LaTeX সমীকরণ (Formulas):** Use clean LaTeX ($...$ or $$...$$) for all equations.
3. **ধাপে ধাপে সমাধান (Step-by-Step Solution):** Complete derivation or numerical calculation with SI units.
4. **ক্যালকুলেটর ও শর্টকাট টিপস (991EX / Exam Tip):** Show how to verify the answer quickly on the ZenvX 991EX calculator.
`;

app.post('/api/zenvxai/ask', limitRequests({ windowMs: 60_000, max: 12, message: 'অনেক বেশি অনুরোধ হয়েছে। এক মিনিট পর আবার চেষ্টা করুন।' }), upload.single('file'), async (req, res) => {
  let tempPath;
  try {
    const { prompt, imageBase64 } = req.body || {};
    const uploadedFile = req.file;
    tempPath = uploadedFile?.path;
    if (!ai) return res.status(503).json({ success: false, error: 'AI is not configured. Set GEMINI_API_KEY on the server.' });
    if ((!prompt || !String(prompt).trim()) && !imageBase64 && !uploadedFile) {
      return res.status(400).json({ success: false, error: 'প্রশ্ন লিখুন অথবা একটি ছবি/ফাইল যোগ করুন।' });
    }
    const contents = [];
    if (imageBase64) {
      const imageMatch = String(imageBase64).match(/^data:(image\/(?:jpeg|png|webp));base64,/i);
      const mimeType = imageMatch ? imageMatch[1].toLowerCase() : 'image/jpeg';
      const cleanBase64 = String(imageBase64).replace(/^data:[^,]+,/, '');
      if (cleanBase64.length > 12 * 1024 * 1024) return res.status(413).json({ success: false, error: 'ছবিটি অনেক বড়। ছোট ছবি ব্যবহার করুন।' });
      contents.push({ inlineData: { mimeType, data: cleanBase64 } });
    }
    if (uploadedFile) {
      const allowed = new Set(['image/jpeg','image/png','image/webp','application/pdf','text/plain']);
      if (!allowed.has(uploadedFile.mimetype)) return res.status(415).json({ success: false, error: 'এই ফাইল ফরম্যাট সমর্থিত নয়। JPG, PNG, WebP, PDF বা TXT ব্যবহার করুন।' });
      const fileBuffer = fs.readFileSync(uploadedFile.path);
      contents.push({ inlineData: { mimeType: uploadedFile.mimetype, data: fileBuffer.toString('base64') } });
    }
    contents.push(String(prompt || 'এই ছবি বা ফাইলটি ব্যাখ্যা করে ধাপে ধাপে সমাধান দাও।').slice(0, 20000));
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents,
      config: { systemInstruction: ZENVX_STYD_SYSTEM_PROMPT, temperature: 0.25 }
    });
    const reply = response?.text;
    if (!reply) return res.status(502).json({ success: false, error: 'AI থেকে খালি উত্তর এসেছে। আবার চেষ্টা করুন।' });
    res.json({ success: true, reply });
  } catch (error) {
    console.error('ZenvXai request failed:', { name: error?.name, status: error?.status || error?.statusCode });
    const status = error?.status === 429 ? 429 : 502;
    res.status(status).json({ success: false, error: status === 429 ? 'AI ব্যবহারের সীমা পূর্ণ হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।' : 'AI সার্ভারে সংযোগ করা যায়নি। কনফিগারেশন ও নেটওয়ার্ক পরীক্ষা করে আবার চেষ্টা করুন।' });
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
  }
});

/************************************************************************
 * 2. CALCULATOR OCR PHOTO SCANNER ENDPOINT (Direct LaTeX Extraction)
 ************************************************************************/
app.post('/api/calculator/scan', limitRequests({ windowMs: 60_000, max: 12, message: 'অনেক বেশি স্ক্যান অনুরোধ হয়েছে। পরে আবার চেষ্টা করুন।' }), async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!ai || !imageBase64) {
      return res.status(400).json({ success: false, error: "Image or API Key missing" });
    }

    const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: [
        { inlineData: { mimeType: "image/jpeg", data: cleanBase64 } },
        "Extract the mathematical expression from this image and return a JSON object with keys: 'expr' (calculator evaluable string like '1/(pi^2)'), 'latex' (LaTeX string), and 'solution' (final numeric answer)."
      ]
    });

    res.json({ success: true, data: response.text });
  } catch (err) {
    console.error('Calculator scan failed:', { name: err?.name, status: err?.status || err?.statusCode });
    res.status(502).json({ success: false, error: 'স্ক্যান করা যায়নি। API key, image ও network পরীক্ষা করে আবার চেষ্টা করুন।' });
  }
});

/************************************************************************
 * 3. EDUTUBE API PROXY (YouTube Videos & Vertical Shorts)
 ************************************************************************/
app.get('/api/edutube/feed', limitRequests({ windowMs: 60_000, max: 60, message: 'YouTube search rate limit reached. Try again shortly.' }), async (req, res) => {
  try {
    const query = String(req.query.q || 'HSC Physics Calculus Bangla').trim().slice(0, 200);
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return res.status(503).json({ success: false, error: 'YouTube API is not configured on the server.' });
    const isShortsMode = String(req.query.mode || '') === 'shorts';
    const params = new URLSearchParams({
      part: 'snippet', maxResults: '10', q: query, type: 'video', safeSearch: 'strict', key: apiKey,
      regionCode: 'BD', relevanceLanguage: 'bn'
    });
    // YouTube Data API has no dedicated Shorts-only search endpoint. Short duration is the closest supported API filter.
    if (isShortsMode) params.set('videoDuration', 'short');
    if (req.query.pageToken) params.set('pageToken', String(req.query.pageToken).slice(0, 200));
    const ytRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
    const data = await ytRes.json();
    if (!ytRes.ok) {
      console.error('YouTube API request failed:', data?.error?.code || ytRes.status);
      return res.status(502).json({ success: false, error: 'YouTube search failed. Check API key, quota, and API enablement.' });
    }
    res.json({ success: true, items: data.items || [], nextPageToken: data.nextPageToken || null });
  } catch (err) {
    console.error('EduTube request failed:', err?.name || 'Error');
    res.status(502).json({ success: false, error: 'YouTube search is temporarily unavailable.' });
  }
});

/************************************************************************
 * 4. SOCKET.IO MESSENGER & WEBRTC AUDIO/VIDEO CALL SIGNALING
 ************************************************************************/
const activeUsers = new Map();
const socketToUser = new Map();
const activeCalls = new Map();

io.on('connection', (socket) => {
  socket.on('register-user', (user = {}) => {
    const userId = String(user.userId || '').trim();
    if (!userId) {
      socket.emit('signaling-error', { message: 'User ID is required before using messaging/calls.' });
      return;
    }
    // This identifies a client but is NOT authentication. Deploy behind verified auth middleware.
    socketToUser.set(socket.id, userId);
    activeUsers.set(socket.id, { socketId: socket.id, userId, name: String(user.name || 'Student').slice(0, 80), role: String(user.role || 'student').slice(0, 30), avatar: String(user.avatar || '').slice(0, 500) });
    io.emit('online-users', Array.from(activeUsers.values()));
  });

  socket.on('send-message', (payload = {}) => {
    if (!socketToUser.has(socket.id) || typeof payload.text !== 'string') return;
    const msg = { id: Date.now(), senderId: socketToUser.get(socket.id), senderName: String(payload.senderName || 'Student').slice(0,80), senderAvatar: String(payload.senderAvatar || '').slice(0,500), text: payload.text.slice(0,5000), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    io.emit('receive-message', msg);
  });

  socket.on('call-user', (data = {}) => {
    const target = String(data.to || '');
    const caller = activeUsers.get(socket.id);
    const recipient = activeUsers.get(target);
    if (!caller || !recipient || target === socket.id || !['audio','video'].includes(data.callType) || !data.offer) {
      socket.emit('signaling-error', { message: 'Call could not be started. Check the selected online user and call details.' });
      return;
    }
    const callId = `${socket.id}:${target}:${Date.now()}`;
    activeCalls.set(callId, { caller: socket.id, recipient: target, status: 'ringing' });
    io.to(target).emit('incoming-call', { callId, from: socket.id, callerName: caller.name, callerAvatar: caller.avatar, callType: data.callType, offer: data.offer });
    socket.emit('call-ringing', { callId, to: target });
  });
  socket.on('answer-call', (data = {}) => {
    const call = activeCalls.get(String(data.callId || ''));
    if (!call || call.recipient !== socket.id || !data.answer) return;
    call.status = 'connected';
    io.to(call.caller).emit('call-answered', { callId: data.callId, from: socket.id, answer: data.answer });
  });
  socket.on('ice-candidate', (data = {}) => {
    const call = activeCalls.get(String(data.callId || ''));
    if (!call || !data.candidate || ![call.caller, call.recipient].includes(socket.id)) return;
    const target = socket.id === call.caller ? call.recipient : call.caller;
    io.to(target).emit('ice-candidate', { callId: data.callId, from: socket.id, candidate: data.candidate });
  });
  socket.on('decline-call', (data = {}) => {
    const call = activeCalls.get(String(data.callId || ''));
    if (!call || ![call.caller, call.recipient].includes(socket.id)) return;
    const target = socket.id === call.caller ? call.recipient : call.caller;
    io.to(target).emit('call-declined', { callId: data.callId, from: socket.id });
    activeCalls.delete(String(data.callId));
  });
  socket.on('end-call', (data = {}) => {
    const callId = String(data.callId || '');
    const call = activeCalls.get(callId);
    if (!call || ![call.caller, call.recipient].includes(socket.id)) return;
    const target = socket.id === call.caller ? call.recipient : call.caller;
    io.to(target).emit('call-ended', { callId, from: socket.id });
    activeCalls.delete(callId);
  });
  socket.on('disconnect', () => {
    activeUsers.delete(socket.id);
    socketToUser.delete(socket.id);
    for (const [callId, call] of activeCalls.entries()) {
      if (call.caller === socket.id || call.recipient === socket.id) {
        const target = call.caller === socket.id ? call.recipient : call.caller;
        io.to(target).emit('call-ended', { callId, reason: 'peer-disconnected' });
        activeCalls.delete(callId);
      }
    }
    io.emit('online-users', Array.from(activeUsers.values()));
  });
});

// Fallback route to serve the Single-Page App
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ZenvX Study Full-Stack Server running at http://localhost:${PORT}`);
});