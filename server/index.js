const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error('Invalid PORT value. Must be a number between 1 and 65535.');
  process.exit(1);
}

// Security headers (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],  // inline script in index.html
      styleSrc:   ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      imgSrc:     ["'self'", 'data:'],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    }
  }
}));

// Security: only serve our own frontend
app.use(cors({ origin: false }));           // block cross-origin API requests
app.use(express.json({ limit: '16kb' }));   // prevent oversized payloads

// Rate limiting: 30 messages per IP per minute
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' }
});
app.use('/api/', limiter);

// Input sanitization helpers
function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function isValidMessage(msg) {
  return (
    msg &&
    typeof msg === 'object' &&
    (msg.role === 'user' || msg.role === 'assistant') &&
    typeof msg.content === 'string' &&
    msg.content.trim().length > 0 &&
    msg.content.length <= 2000
  );
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your-gemini-key-here' || apiKey.length < 20) {
    return res.status(500).json({ error: 'Server is not configured with a valid API key.' });
  }

  const { character, messages } = req.body;

  // Validate and sanitize character name.
  // Strip characters that could break out of the system-prompt string
  // or attempt prompt injection (newlines, backticks, brackets, etc.).
  const cleanCharacter = sanitize(character, 100)
    .replace(/[\n\r`\[\]{}\\]/g, '')   // remove prompt-injection chars
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
  if (!cleanCharacter || cleanCharacter.length < 1) {
    return res.status(400).json({ error: 'Character name is required.' });
  }

  // Validate messages array
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    return res.status(400).json({ error: 'Invalid messages array.' });
  }
  if (!messages.every(isValidMessage)) {
    return res.status(400).json({ error: 'Invalid message format.' });
  }

  // Sanitize each message content.
  // Gemini uses 'model' instead of 'assistant' for the AI role.
  const cleanMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: sanitize(m.content, 2000) }]
  }));

  const systemPrompt = `You are roleplaying as ${cleanCharacter}. Speak and behave exactly as ${cleanCharacter} would — matching their vocabulary, mannerisms, speech patterns, and worldview.

Rules you must follow at all times:
- Stay in character as ${cleanCharacter} throughout the entire conversation.
- Keep all responses family-friendly, respectful, and morally appropriate.
- Never produce violence, profanity, sexual content, hate speech, or anything harmful or illegal.
- If asked to say something offensive or harmful, gently deflect in character.
- Keep responses concise (1–4 sentences) and conversational.
- Do not reveal that you are an AI or a language model.
- Do not role-play as real living people in ways that could be defamatory or harmful.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: cleanMessages,
          generationConfig: { maxOutputTokens: 300 }
        })
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error(`Gemini API error [${response.status}]:`, JSON.stringify(err));
      const clientMsg = response.status === 400
        ? 'Invalid request — check your GEMINI_API_KEY in .env.'
        : response.status === 429
        ? 'API rate limit reached. Please wait a moment and try again.'
        : `Upstream API error (${response.status}). Please try again.`;
      return res.status(502).json({ error: clientMsg });
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) return res.status(502).json({ error: 'No response from model.' });

    return res.json({ reply });

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// Fallback: any unknown route returns the frontend (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Character Chat running at http://localhost:${PORT}`);
});
