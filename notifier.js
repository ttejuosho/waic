const express = require("express");
const http = require("http");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
// 62539723477174 / 2348037361123
// 184219854721155 / 13167493992

// ─── Config ──────────────────────────────────────────────────────────────────
const NOTIFICATION_NUMBER = "13126476896@c.us";
const PREFIX = "818ai";
const PREFIX1 = "818";
const TEXT_MODEL = "openai/gpt-oss-120b";
const MAX_MAP_SIZE = 5;
const MAX_MEMORY_TURNS = 20;
const STARTUP_TIMEOUT_MS = 45000;
const SESSION_LOAD_TIMEOUT_MS = 180000;
const PORT = process.env.PORT || 3003;
const numbersAllowed = [
  "62539723477174",
  "184219854721155",
  "13167493992",
  "2348037361123",
];

// ─── State ───────────────────────────────────────────────────────────────────
const replyMap = new Map();
const conversationHistory = new Map();
let qrDataUrl = null;
let connectionStatus = "starting"; // starting | disconnected | awaiting_scan | connected | error
let statusMessage = "Starting up...";
let connectedNumber = null;
let intentionalDisconnect = false;
let isReconnecting = false;
let isConnecting = false;
let startupTimer = null;
let isShuttingDown = false;

function clearStartupTimeout() {
  if (!startupTimer) return;
  clearTimeout(startupTimer);
  startupTimer = null;
}

function beginStartupTimeout(timeoutMessage, timeoutMs = STARTUP_TIMEOUT_MS) {
  clearStartupTimeout();
  startupTimer = setTimeout(() => {
    if (
      connectionStatus === "connected" ||
      connectionStatus === "awaiting_scan"
    ) {
      return;
    }
    isConnecting = false;
    isReconnecting = false;
    connectionStatus = "error";
    statusMessage = timeoutMessage;
  }, timeoutMs);
}

function getErrorMessage(err) {
  return err?.message || String(err);
}

function isBrowserProfileLockedError(err) {
  return getErrorMessage(err).includes("browser is already running");
}

function getConnectStatusMessage(err) {
  if (isBrowserProfileLockedError(err)) {
    return "WhatsApp browser session is still locked. Stop the old app/browser process, then use Connect again.";
  }
  return "Connect failed";
}

// ─── History helpers ─────────────────────────────────────────────────────────
function getHistory(chatId) {
  if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
  return conversationHistory.get(chatId);
}

function appendToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_MEMORY_TURNS * 2) {
    history.splice(0, history.length - MAX_MEMORY_TURNS * 2);
  }
}

// ─── Reply map ───────────────────────────────────────────────────────────────
function pruneReplyMap() {
  while (replyMap.size >= MAX_MAP_SIZE) {
    replyMap.delete(replyMap.keys().next().value);
  }
}

// ─── Groq ─────────────────────────────────────────────────────────────────────
function readGroqApiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  try {
    const envRaw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    const keyLine = envRaw
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith("GROQ_API_KEY="));
    if (!keyLine) return "";
    return keyLine.split("=").slice(1).join("=").trim();
  } catch {
    return "";
  }
}

const GROQ_API_KEY = readGroqApiKey();

const WA_FORMATTING_RULES = `Text formatting rules:
- Italic: _text_
- Bold: *text*
- Strikethrough: ~text~
- Monospace: \`\`\`text\`\`\`
- Bulleted list: * text or - text
- Numbered list: 1. text
- Quote: > text
- Inline code: \`text\`

Use only these formatting options. Do not use markdown headings (#), tables, or any other markdown not listed above. If formatting is not needed, return plain text.`;

async function callGroq(chatId, prompt) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");
  const history = getHistory(chatId);
  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GROQ_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [
          { role: "system", content: WA_FORMATTING_RULES },
          ...history,
          { role: "user", content: prompt },
        ],
      }),
    },
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }
  const data = await response.json();
  const replyText =
    data?.choices?.[0]?.message?.content?.trim() || "No response from model.";
  appendToHistory(chatId, "user", prompt);
  appendToHistory(chatId, "assistant", replyText);
  return replyText;
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Status API — polled by the UI
app.get("/api/status", (req, res) => {
  const payload = {
    status: connectionStatus,
    message: statusMessage,
    number: connectedNumber,
    hasQr: Boolean(qrDataUrl),
    canConnect:
      (connectionStatus === "disconnected" || connectionStatus === "error") &&
      !isConnecting &&
      !isReconnecting,
    shouldPoll:
      connectionStatus === "starting" ||
      connectionStatus === "awaiting_scan" ||
      isConnecting ||
      isReconnecting,
  };
  res.json(payload);
});

// QR image endpoint
app.get("/api/qr", (req, res) => {
  if (!qrDataUrl) {
    return res.status(404).json({ error: "No QR code available" });
  }
  // Strip the data URL prefix and send as PNG
  const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, "");
  const buf = Buffer.from(base64, "base64");
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "no-store");
  res.send(buf);
});

app.post("/api/disconnect", async (req, res) => {
  intentionalDisconnect = true;
  clearStartupTimeout();
  connectionStatus = "disconnected";
  statusMessage = "Disconnecting...";
  qrDataUrl = null;
  connectedNumber = null;

  try {
    await client.logout();
    isConnecting = false;
    isReconnecting = false;
    statusMessage = "Disconnected. Use Connect to link WhatsApp again.";
    res.json({ ok: true });
  } catch (err) {
    console.error("Disconnect error:", err.message);
    intentionalDisconnect = false;
    statusMessage = "Disconnect failed";
    res.status(500).json({ ok: false, error: "Disconnect failed" });
  }
});

app.post("/api/connect", async (req, res) => {
  if (connectionStatus === "connected" || isConnecting || isReconnecting) {
    return res.json({ ok: true, status: connectionStatus });
  }

  intentionalDisconnect = false;
  isConnecting = true;
  connectionStatus = "starting";
  statusMessage = "Connecting...";
  qrDataUrl = null;
  connectedNumber = null;
  beginStartupTimeout("Connection timed out. Use Connect to try again.");

  try {
    const initializePromise = client.initialize();
    res.json({ ok: true });
    initializePromise
      .catch((err) => {
        console.error("Connect error:", getErrorMessage(err));
        clearStartupTimeout();
        connectionStatus = "error";
        statusMessage = getConnectStatusMessage(err);
      })
      .finally(() => {
        isConnecting = false;
      });
  } catch (err) {
    console.error("Connect error:", getErrorMessage(err));
    clearStartupTimeout();
    isConnecting = false;
    connectionStatus = "error";
    statusMessage = getConnectStatusMessage(err);
    res.status(500).json({ ok: false, error: "Connect failed" });
  }
});

// Main UI
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>818 Notifier</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0a;
      --surface: #111111;
      --border: #1e1e1e;
      --border-bright: #2a2a2a;
      --text: #e8e8e8;
      --muted: #555;
      --accent: #c8f566;
      --accent-dim: rgba(200, 245, 102, 0.12);
      --accent-glow: rgba(200, 245, 102, 0.04);
      --red: #ff5c5c;
      --yellow: #ffd166;
      --font-display: 'Syne', sans-serif;
      --font-mono: 'DM Mono', monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-display);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      position: relative;
      overflow: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 60% 40% at 80% 10%, rgba(200,245,102,0.04) 0%, transparent 60%),
        radial-gradient(ellipse 40% 60% at 10% 80%, rgba(200,245,102,0.025) 0%, transparent 60%);
      pointer-events: none;
    }

    .card {
      width: 100%;
      max-width: 460px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      position: relative;
    }

    .card-header {
      padding: 28px 32px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .brand {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .brand-name {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--text);
    }

    .brand-name span {
      color: var(--accent);
    }

    .brand-sub {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 12px;
      border-radius: 100px;
      border: 1px solid var(--border-bright);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      white-space: nowrap;
      transition: all 0.3s ease;
    }

    .status-pill.disconnected { color: var(--muted); }
    .status-pill.starting { color: var(--yellow); border-color: rgba(255,209,102,0.3); background: rgba(255,209,102,0.06); }
    .status-pill.awaiting_scan { color: var(--yellow); border-color: rgba(255,209,102,0.3); background: rgba(255,209,102,0.06); }
    .status-pill.connected { color: var(--accent); border-color: rgba(200,245,102,0.3); background: var(--accent-dim); }
    .status-pill.error { color: var(--red); border-color: rgba(255,92,92,0.35); background: rgba(255,92,92,0.08); }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
    }

    .status-pill.connected .dot { animation: pulse 2s ease-in-out infinite; }
    .status-pill.starting .dot { animation: pulse 1s ease-in-out infinite; }
    .status-pill.awaiting_scan .dot { animation: pulse 1s ease-in-out infinite; }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }

    .card-body {
      padding: 32px;
      min-height: 340px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
    }

    /* QR panel */
    .qr-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      width: 100%;
      animation: fadeIn 0.4s ease;
    }

    .qr-frame {
      position: relative;
      padding: 14px;
      background: #fff;
      border-radius: 12px;
      line-height: 0;
    }

    .qr-frame img {
      width: 220px;
      height: 220px;
      display: block;
      border-radius: 4px;
    }

    .qr-frame::before,
    .qr-frame::after {
      content: '';
      position: absolute;
      width: 20px;
      height: 20px;
      border-color: var(--accent);
      border-style: solid;
      border-radius: 3px;
    }
    .qr-frame::before { top: -2px; left: -2px; border-width: 2px 0 0 2px; }
    .qr-frame::after  { bottom: -2px; right: -2px; border-width: 0 2px 2px 0; }

    .qr-instructions {
      text-align: center;
    }

    .qr-instructions p {
      font-size: 13px;
      color: var(--muted);
      line-height: 1.6;
      max-width: 280px;
    }

    .qr-instructions strong {
      color: var(--text);
      font-weight: 600;
    }

    .qr-timer {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      margin-top: 6px;
      letter-spacing: 0.05em;
    }

    .qr-timer span {
      color: var(--yellow);
    }

    /* Connected panel */
    .connected-panel {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      animation: fadeIn 0.4s ease;
      text-align: center;
    }

    .checkmark {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: var(--accent-dim);
      border: 1px solid rgba(200,245,102,0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
    }

    .connected-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: -0.3px;
    }

    .connected-number {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--muted);
      padding: 6px 14px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 100px;
    }

    .connected-desc {
      font-size: 13px;
      color: var(--muted);
      line-height: 1.6;
      max-width: 280px;
    }

    /* Waiting panel */
    .waiting-panel {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      animation: fadeIn 0.4s ease;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 2px solid var(--border-bright);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .waiting-text {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--muted);
      letter-spacing: 0.06em;
    }

    /* Footer */
    .card-footer {
      padding: 16px 32px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .footer-msg {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.04em;
    }

    .footer-msg.error { color: var(--red); }

    .refresh-btn {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      background: none;
      border: 1px solid var(--border-bright);
      border-radius: 6px;
      padding: 5px 10px;
      cursor: pointer;
      letter-spacing: 0.04em;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .refresh-btn:hover {
      color: var(--accent);
      border-color: rgba(200,245,102,0.3);
      background: var(--accent-glow);
    }

    .disconnect-btn {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--red);
      background: none;
      border: 1px solid rgba(255,92,92,0.35);
      border-radius: 6px;
      padding: 5px 10px;
      cursor: pointer;
      letter-spacing: 0.04em;
      transition: all 0.2s;
      white-space: nowrap;
      display: none;
    }

    .disconnect-btn:hover {
      background: rgba(255,92,92,0.08);
      border-color: rgba(255,92,92,0.55);
    }

    .connect-btn {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--accent);
      background: var(--accent-dim);
      border: 1px solid rgba(200,245,102,0.35);
      border-radius: 6px;
      padding: 5px 10px;
      cursor: pointer;
      letter-spacing: 0.04em;
      transition: all 0.2s;
      white-space: nowrap;
      display: none;
    }

    .connect-btn:hover {
      background: rgba(200,245,102,0.16);
      border-color: rgba(200,245,102,0.55);
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <div class="brand">
        <div class="brand-name"><span>818AI</span> ChatBoT</div>
        <div class="brand-sub">WhatsApp Gateway</div>
      </div>
      <div class="status-pill disconnected" id="statusPill">
        <div class="dot"></div>
        <span id="statusLabel">Starting</span>
      </div>
    </div>

    <div class="card-body" id="cardBody">
      <div class="waiting-panel">
        <div class="spinner"></div>
        <div class="waiting-text">Initialising...</div>
      </div>
    </div>

    <div class="card-footer">
      <div class="footer-msg" id="footerMsg">Waiting for WhatsApp client</div>
      <button class="connect-btn" id="connectBtn" onclick="connectWhatsApp()">Connect</button>
      <button class="disconnect-btn" id="disconnectBtn" onclick="disconnectWhatsApp()">Disconnect</button>
      <button class="refresh-btn" onclick="forceRefresh()">↻ Refresh</button>
    </div>
  </div>

  <script>
    let isConnected = false;
    let shouldPoll = true;
    let countdown = 28;
    let countdownTimer = null;

    function forceRefresh() {
      isConnected = false;
      shouldPoll = true;
      poll();
    }

    async function disconnectWhatsApp() {
      if (!confirm("Disconnect and unlink this WhatsApp account?")) return;
      const button = document.getElementById("disconnectBtn");
      button.disabled = true;
      button.textContent = "Disconnecting";
      try {
        await fetch("/api/disconnect", { method: "POST" });
      } catch (e) {
        document.getElementById("footerMsg").textContent = "Disconnect request failed";
        document.getElementById("footerMsg").className = "footer-msg error";
      } finally {
        isConnected = false;
        shouldPoll = true;
        button.disabled = false;
        button.textContent = "Disconnect";
        poll();
      }
    }

    async function connectWhatsApp() {
      const button = document.getElementById("connectBtn");
      button.disabled = true;
      button.textContent = "Connecting";
      try {
        await fetch("/api/connect", { method: "POST" });
      } catch (e) {
        document.getElementById("footerMsg").textContent = "Connect request failed";
        document.getElementById("footerMsg").className = "footer-msg error";
      } finally {
        isConnected = false;
        shouldPoll = true;
        button.disabled = false;
        button.textContent = "Connect";
        poll();
      }
    }

    function startQrCountdown() {
      countdown = 28;
      clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        countdown--;
        const el = document.getElementById("qrCountdown");
        if (el) el.textContent = countdown + "s";
        if (countdown <= 0) {
          clearInterval(countdownTimer);
          poll();
        }
      }, 1000);
    }

    function renderQr(imgSrc) {
      startQrCountdown();
      return \`
        <div class="qr-wrap">
          <div class="qr-frame">
            <img src="\${imgSrc}" alt="WhatsApp QR Code" />
          </div>
          <div class="qr-instructions">
            <p>Open <strong>WhatsApp</strong> on your phone, go to <strong>Settings → Linked Devices</strong>, and scan this code.</p>
            <div class="qr-timer">Refreshes in <span id="qrCountdown">28s</span></div>
          </div>
        </div>
      \`;
    }

    function renderConnected(number) {
      clearInterval(countdownTimer);
      return \`
        <div class="connected-panel">
          <div class="checkmark">✓</div>
          <div class="connected-title">Connected</div>
          \${number ? \`<div class="connected-number">+\${number.replace("@c.us","")}</div>\` : ""}
          <p class="connected-desc">The notifier is active and listening for messages. You can close this tab.</p>
        </div>
      \`;
    }

    function renderWaiting(msg) {
      return \`
        <div class="waiting-panel">
          <div class="spinner"></div>
          <div class="waiting-text">\${msg || "Waiting..."}</div>
        </div>
      \`;
    }

    async function poll() {
      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        shouldPoll = Boolean(data.shouldPoll);
        isConnected = data.status === "connected";

        const pill = document.getElementById("statusPill");
        const label = document.getElementById("statusLabel");
        const body = document.getElementById("cardBody");
        const footer = document.getElementById("footerMsg");
        const connectBtn = document.getElementById("connectBtn");
        const disconnectBtn = document.getElementById("disconnectBtn");

        pill.className = "status-pill " + data.status;
        connectBtn.style.display = data.canConnect ? "inline-block" : "none";
        disconnectBtn.style.display = data.status === "connected" ? "inline-block" : "none";

        const labels = {
          starting: "Starting",
          disconnected: "Offline",
          awaiting_scan: "Scan QR",
          connected: "Live",
          error: "Error",
        };
        label.textContent = labels[data.status] || data.status;

        if (data.status === "connected") {
          body.innerHTML = renderConnected(data.number);
          footer.textContent = "Session active";
          footer.className = "footer-msg";
        } else if (data.status === "awaiting_scan" && data.hasQr) {
          body.innerHTML = renderQr("/api/qr?" + Date.now());
          footer.textContent = "Waiting for scan";
          footer.className = "footer-msg";
          startQrCountdown();
        } else {
          body.innerHTML = renderWaiting(data.message || "Initialising...");
          footer.textContent = data.message || "Starting up";
          footer.className = data.status === "error" ? "footer-msg error" : "footer-msg";
        }
      } catch (e) {
        document.getElementById("footerMsg").textContent = "Could not reach server";
        document.getElementById("footerMsg").className = "footer-msg error";
      }
    }

    poll();
    const pollInterval = setInterval(() => {
      if (shouldPoll) poll();
    }, 3003);
  </script>
</body>
</html>`);
});

// ─── WhatsApp client ──────────────────────────────────────────────────────────
const client = new Client({ authStrategy: new LocalAuth() });

client.on("qr", async (qr) => {
  console.log("QR received — open http://localhost:" + PORT + " to scan");
  //qrcode.generate(qr, { small: true }); // keep terminal fallback
  try {
    intentionalDisconnect = false;
    isConnecting = false;
    clearStartupTimeout();
    qrDataUrl = await QRCode.toDataURL(qr, {
      errorCorrectionLevel: "L",
      margin: 4,
      scale: 8,
    });
    connectionStatus = "awaiting_scan";
    statusMessage = "Scan the QR code";
  } catch (err) {
    console.error("QR generation error:", err.message);
    isConnecting = false;
    connectionStatus = "error";
    statusMessage = "QR generation failed. Use Connect to try again.";
  }
});

client.on("authenticated", () => {
  isConnecting = true;
  connectionStatus = "starting";
  statusMessage = "Authenticated, loading session...";
  qrDataUrl = null;
  beginStartupTimeout(
    "Session loading timed out. Use Connect to try again.",
    SESSION_LOAD_TIMEOUT_MS,
  );
});

client.on("ready", async () => {
  intentionalDisconnect = false;
  isConnecting = false;
  isReconnecting = false;
  clearStartupTimeout();
  connectionStatus = "connected";
  statusMessage = "Connected";
  qrDataUrl = null;
  try {
    const info = client.info;
    connectedNumber = info?.wid?.user || null;
  } catch (_) {}
  console.log("WhatsApp notifier running");
});

client.on("auth_failure", () => {
  clearStartupTimeout();
  isConnecting = false;
  isReconnecting = false;
  connectionStatus = "error";
  statusMessage = "Authentication failed. Use Connect to try again.";
  console.error("Auth failure");
});

// ─── Incoming messages ────────────────────────────────────────────────────────
client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;
    if (msg.from === NOTIFICATION_NUMBER) return;

    const contact = await msg.getContact();
    const senderNumber = contact.id.user || contact.number;

    const body = (msg.body || "").trim();
    const lowerBody = body.toLowerCase();

    if (lowerBody.startsWith(PREFIX) || lowerBody.startsWith(PREFIX1)) {
      const prompt = body.slice(PREFIX.length).trim();
      if (!prompt) {
        await msg.reply("Please add a prompt after 818ai.");
        return;
      }
      try {
        const aiReply = await callGroq(msg.from, prompt);
        await msg.reply(aiReply);
      } catch (err) {
        console.error("Groq error:", err.message);
        await msg.reply(
          "The AI service is temporarily unavailable. Please try again shortly.",
        );
      }
      return;
    }

    if (numbersAllowed.includes(senderNumber)) {
      let notificationMsg;
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        notificationMsg = await client.sendMessage(NOTIFICATION_NUMBER, media, {
          caption: msg.body || "",
        });
      } else {
        notificationMsg = await client.sendMessage(
          NOTIFICATION_NUMBER,
          msg.body,
        );
      }
      pruneReplyMap();
      replyMap.set(notificationMsg.id.user, msg.from);
      console.log("Notification sent");
    }
  } catch (err) {
    console.error("Notification error:", err);
  }
});

// ─── Outgoing replies ─────────────────────────────────────────────────────────
client.on("message_create", async (msg) => {
  try {
    if (!msg.hasQuotedMsg) return;
    const quoted = await msg.getQuotedMessage();
    const entry = replyMap.get(quoted.id.user);
    if (!entry) return;

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      await client.sendMessage(entry, media, { caption: msg.body || "" });
    } else {
      await client.sendMessage(entry, msg.body);
      console.log("Reply forwarded to:", entry);
    }
  } catch (err) {
    console.error("Reply error:", err);
  }
});

// ─── Reconnect ────────────────────────────────────────────────────────────────
client.on("disconnected", (reason) => {
  connectionStatus = "disconnected";
  statusMessage = "Disconnected — reconnecting...";
  connectedNumber = null;
  console.log("Disconnected:", reason);
  qrDataUrl = null;
  clearStartupTimeout();
  isConnecting = false;

  if (intentionalDisconnect) {
    statusMessage = "Disconnected. Use Connect to link WhatsApp again.";
    return;
  }

  if (isReconnecting) return;
  isReconnecting = true;
  connectionStatus = "starting";
  statusMessage = "Disconnected - reconnecting...";
  setTimeout(async () => {
    console.log("Reconnecting...");
    beginStartupTimeout("Reconnect timed out. Use Connect to try again.");
    try {
      await client.destroy();
      await client.initialize();
    } catch (err) {
      console.error("Reconnect error:", getErrorMessage(err));
      clearStartupTimeout();
      connectionStatus = "error";
      statusMessage = getConnectStatusMessage(err);
    } finally {
      isReconnecting = false;
    }
  }, 5000);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = http.createServer(app);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`UI available at http://localhost:${PORT}`);
});

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received, closing WhatsApp client...`);
  clearStartupTimeout();
  try {
    await client.destroy();
  } catch (_) {}
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGHUP", () => shutdown("SIGHUP"));

isConnecting = true;
connectionStatus = "starting";
statusMessage = "Starting up...";
beginStartupTimeout("Startup timed out. Use Connect to try again.");
client
  .initialize()
  .catch((err) => {
    console.error("Initial connect error:", getErrorMessage(err));
    clearStartupTimeout();
    connectionStatus = "error";
    statusMessage = getConnectStatusMessage(err);
  })
  .finally(() => {
    isConnecting = false;
  });
