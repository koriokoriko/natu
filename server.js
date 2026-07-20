// server.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const fetch = global.fetch;

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'entries.csv');

const CSV_HEADERS = [
  'id',
  'pin',
  'nickname',
  'youtube',
  'youtubeUrl',
  'sns',
  'date',
  'start',
  'end',
  'bio',
  'color',
  'createdAt'
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- CSV helpers -------------------------------------------------

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    const headerLine = CSV_HEADERS.join(',') + '\n';
    fs.writeFileSync(DATA_FILE, headerLine, 'utf8');
  }
}

function readEntries() {
  ensureDataFile();
  const content = fs.readFileSync(DATA_FILE, 'utf8');
  if (!content.trim()) return [];
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true
  });
  return records;
}

function writeEntries(entries) {
  ensureDataFile();
  const csv = stringify(entries, {
    header: true,
    columns: CSV_HEADERS
  });
  fs.writeFileSync(DATA_FILE, csv, 'utf8');
}

function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || '').trim());
}

// ---- API: /api/entries -------------------------------------------

// GET /api/entries
app.get('/api/entries', (req, res) => {
  try {
    const entries = readEntries();
    const sanitized = entries.map(e => {
      const { pin, ...rest } = e;
      return rest;
    });
    res.json(sanitized);
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/entries
app.post('/api/entries', (req, res) => {
  try {
    const {
      id,
      pin,
      nickname,
      youtube,
      youtubeUrl,
      sns,
      date,
      start,
      end,
      bio,
      color
    } = req.body || {};

    const entries = readEntries();

    if (!id || !/^\d{4}$/.test(String(pin || ''))) {
      return res
        .status(400)
        .json({ error: 'IDとPIN（4桁の数字）は必須です。' });
    }

    if (!youtube || String(youtube).trim() === '') {
      return res
        .status(400)
        .json({ error: 'YouTubeチャンネル名は必須です。' });
    }

    if (!isHttpUrl(youtubeUrl)) {
      return res.status(400).json({
        error:
          'YouTube URLは https:// から始まる正しいURLを入力してください。'
      });
    }

    if (!bio || String(bio).trim() === '') {
      return res
        .status(400)
        .json({ error: '自己紹介・配信内容は必須です。' });
    }

    if (!date || !start || !end || start >= end) {
      return res
        .status(400)
        .json({ error: '日時が正しくありません。' });
    }

    if (start < '08:00' || end > '20:00') {
      return res.status(400).json({
        error: '配信時間は8:00〜20:00の範囲で入力してください。'
      });
    }

    if (entries.some(e => String(e.id) === String(id))) {
      return res
        .status(409)
        .json({ error: 'そのIDはすでに使われています。' });
    }

    const newEntry = {
      id: String(id),
      pin: String(pin),
      nickname: nickname || '',
      youtube: youtube || '',
      youtubeUrl: youtubeUrl || '',
      sns: sns || '',
      date: date || '',
      start: start || '',
      end: end || '',
      bio: bio || '',
      color: color || '#e2542c',
      createdAt: String(Date.now())
    };

    entries.push(newEntry);
    writeEntries(entries);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---- API: /api/login ---------------------------------------------

app.post('/api/login', (req, res) => {
  try {
    const { id, pin } = req.body || {};
    const entries = readEntries();

    const found = entries.find(
      e => String(e.id) === String(id) && String(e.pin) === String(pin)
    );

    if (!found) {
      return res
        .status(401)
        .json({ error: 'IDまたはPINが正しくありません。' });
    }

    const { pin: _pin, ...rest } = found;
    res.json(rest);
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---- API: PUT /api/entries/:id -----------------------------------

app.put('/api/entries/:id', (req, res) => {
  try {
    const id = req.params.id;
    const { pin, updates = {} } = req.body || {};

    const entries = readEntries();
    const idx = entries.findIndex(
      e => String(e.id) === String(id) && String(e.pin) === String(pin)
    );

    if (idx === -1) {
      return res.status(401).json({
        error: '認証に失敗しました。IDとPINを確認してください。'
      });
    }

    const current = entries[idx];

    const next = { ...current, ...updates };

    if ('youtube' in updates) {
      if (!next.youtube || String(next.youtube).trim() === '') {
        return res
          .status(400)
          .json({ error: 'YouTubeチャンネル名は必須です。' });
      }
    }

    if ('youtubeUrl' in updates) {
      if (!isHttpUrl(next.youtubeUrl)) {
        return res.status(400).json({
          error:
            'YouTube URLは https:// から始まる正しいURLを入力してください。'
        });
      }
    }

    if ('bio' in updates) {
      if (!next.bio || String(next.bio).trim() === '') {
        return res
          .status(400)
          .json({ error: '自己紹介・配信内容は必須です。' });
      }
    }

    const start = next.start;
    const end = next.end;

    if (start && end) {
      if (start >= end) {
        return res
          .status(400)
          .json({ error: '終了時刻は開始時刻より後にしてください。' });
      }
      if (start < '08:00' || end > '20:00') {
        return res.status(400).json({
          error: '配信時間は8:00〜20:00の範囲で入力してください。'
        });
      }
    }

    entries[idx] = next;
    writeEntries(entries);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---- API: DELETE /api/entries/:id --------------------------------

app.delete('/api/entries/:id', (req, res) => {
  try {
    const id = req.params.id;
    const { pin } = req.body || {};

    const entries = readEntries();
    const beforeLen = entries.length;

    const filtered = entries.filter(
      e => !(String(e.id) === String(id) && String(e.pin) === String(pin))
    );

    if (filtered.length === beforeLen) {
      return res.status(401).json({
        error: '認証に失敗しました。IDとPINを確認してください。'
      });
    }

    writeEntries(filtered);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---- API: /api/channel-thumb -------------------------------------

const thumbCache = new Map();
const THUMB_TTL_MS = 6 * 60 * 60 * 1000;

function setThumbCache(url, value) {
  thumbCache.set(url, { value, expiresAt: Date.now() + THUMB_TTL_MS });
}

function getThumbCache(url) {
  const entry = thumbCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    thumbCache.delete(url);
    return null;
  }
  return entry.value;
}

const YT_HOST_WHITELIST = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be'
]);

app.get('/api/channel-thumb', async (req, res) => {
  const url = req.query.url;

  try {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Invalid protocol' });
    }

    if (!YT_HOST_WHITELIST.has(parsed.hostname)) {
      return res.status(400).json({ error: 'Invalid host' });
    }

    const cached = getThumbCache(url);
    if (cached) {
      return res.json({ thumb: cached });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let resp;
    try {
      resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'ja,en;q=0.8'
        }
      });
    } catch (e) {
      clearTimeout(timeout);
      return res.status(504).json({ error: 'Gateway Timeout' });
    }

    clearTimeout(timeout);

    if (!resp.ok) {
      return res.status(502).json({ error: 'Bad Gateway' });
    }

    const html = await resp.text();

    const metaRegex1 =
      /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i;
    const metaRegex2 =
      /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i;

    let match = html.match(metaRegex1);
    if (!match) {
      match = html.match(metaRegex2);
    }

    if (!match || !match[1] || !/^https:\/\//i.test(match[1])) {
      return res.status(404).json({ error: 'Not Found' });
    }

    const thumbUrl = match[1];
    setThumbCache(url, thumbUrl);

    res.json({ thumb: thumbUrl });
  } catch (err) {
    res.status(504).json({ error: 'Gateway Timeout' });
  }
});

// ---- startup -----------------------------------------------------

ensureDataFile();
console.log(
  `🏮 夏祭りサーバー起動中: http://localhost:${PORT} (CSV: ${DATA_FILE})`
);

app.listen(PORT);
