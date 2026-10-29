# ZenvX Study — GitHub + one Render Web Service

A single-origin Node.js/Express educational web app. The same Render Web Service serves the frontend, Gemini AI proxy, YouTube Data API proxy, Socket.IO messaging, and WebRTC signaling. No separate frontend/backend services are required.

## Features

- **ZenvX AI tutor:** Gemini API integration through the server; supports text, camera images, and supported file attachments.
- **EduTube:** Official YouTube Data API v3 search proxy, clean edge-to-edge thumbnail feed, search, next-page results, and embedded YouTube players.
- **Shorts-style feed:** Full-screen vertical snap scrolling with lazy player loading and auto-pause for off-screen videos. The official YouTube Data API does not expose a dedicated Shorts-only search endpoint, so the feed uses short-duration search results; not every result is guaranteed to be a YouTube Short.
- **Scientific calculator:** MathLive structured math input (one native cursor, numerator/denominator vertical navigation, square roots, fractions, powers, and delete/edit commands), scientific evaluation, history, and camera scan flow. KaTeX is retained for formatted AI responses.
- **Voice input:** Uses browser SpeechRecognition where supported; if unsupported, use the device keyboard's voice typing.
- **Camera scanner:** Explicit permission/error messages and a dedicated scanner stream. Camera access requires HTTPS (Render provides HTTPS) or localhost.
- **Realtime prototype:** Socket.IO chat and WebRTC audio/video signaling. STUN is included; TURN is recommended for calls across restrictive mobile/carrier networks.
- **Deployment health check:** `/healthz`.

## Deploy to GitHub and Render

1. Download and extract this ZIP. Upload the **contents of the extracted folder** to the root of a new GitHub repository (so `package.json`, `server.js`, `public/`, and `render.yaml` are at repository root).
2. In Render, choose **New → Blueprint** and connect the repository. Alternatively create a **Web Service** with:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/healthz`
3. In Render → your service → **Environment**, add the following keys:

   | Key | Required? | Where to get it |
   |---|---|---|
   | `GEMINI_API_KEY` | Required for AI | [Google AI Studio API keys](https://aistudio.google.com/apikey) |
   | `YOUTUBE_API_KEY` | Required for EduTube search | [Google Cloud Credentials](https://console.cloud.google.com/apis/credentials) after enabling [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) |
   | `GEMINI_MODEL` | Optional | Defaults to `gemini-2.5-flash` |
   | `ICE_SERVERS_JSON` | Optional, recommended for reliable calls | JSON array of STUN/TURN servers from your WebRTC/TURN provider |

4. Deploy, then open `https://YOUR-SERVICE.onrender.com/healthz`. It should return JSON. `geminiConfigured` and `youtubeConfigured` are `true` only when the corresponding keys are configured.
5. Test AI text questions, EduTube search, camera permission, voice input, and calls on HTTPS. For calls, use two separate devices/browser profiles signed into the page at the same time and select the other online user.

## API key setup — important

- **Do not paste API keys into `public/index.html`, commit a populated `.env`, or share keys in screenshots.** Add them only in Render Environment settings. The frontend calls this app's `/api/...` endpoints; the server calls Google APIs.
- For YouTube, ensure the correct Google Cloud project has **YouTube Data API v3 enabled**, billing/quota configuration as required by Google, and a valid API key. Restrict the key to the YouTube Data API where possible.
- Gemini quotas and model availability depend on the Google account/project. If AI fails, inspect Render logs and confirm the key/model are valid. Never share the key to debug.
- `ICE_SERVERS_JSON` is optional. STUN-only calls can fail on some mobile networks. TURN credentials must be provided by a TURN service; use short-lived credentials when possible. The browser necessarily receives the ICE server configuration, so do not put long-lived privileged secrets in it.

## Local development

```bash
cp .env.example .env
# Edit .env and add your own keys locally; never commit it.
npm install
npm test
npm start
```

Open `http://localhost:3000`. `npm test` checks server JavaScript syntax and the inline browser script syntax. It does **not** replace real browser/device testing or live API tests.

## What was changed in v4

- Removed the extra manually drawn calculator caret. MathLive is now the only editable math field, so the browser does not render a second fake cursor.
- Calculator arrow buttons use MathLive horizontal/vertical navigation commands; Up/Down now move through structured math instead of browsing calculation history. Use the History button for history.
- Replaced the thick video cards with a cleaner YouTube-like feed and added an edge-to-edge vertical snap Shorts-style view.
- Added automatic loading of additional YouTube search pages near the end of the feed.

## Current limitations / production notes

- Socket.IO identity is a display identity, not secure account authentication. The chat/call feature is a prototype and should not be used for private conversations until real authentication, authorization, abuse prevention, and message persistence are added.
- In-memory rate limits reset when the service restarts and are per instance; use a shared store for a scaled production deployment.
- Browser speech recognition varies by browser and language availability. Android Chrome and keyboard voice typing may work better for Bangla.
- Camera/microphone use requires user permission and a secure context. A successful code syntax check cannot guarantee device permission or network-level WebRTC connectivity.
- The app loads Tailwind, icons, fonts, and MathLive, KaTeX, Tailwind, icons, and fonts from third-party CDNs, so a network connection is required for those assets.
