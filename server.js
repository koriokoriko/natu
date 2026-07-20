const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'entries.csv');
const HEADERS = ['id', 'pin', 'nickname', 'youtube', 'youtubeUrl', 'sns', 'date', 'start', 'end', 'bio', 'color', 'createdAt'];

// http(s) から始まる正しいURLか
const isHttpUrl = (u) => /^https?:\/\//i.test(String(u || '').trim());

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- CSVログの読み書き ----------
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, stringify([], { header: true, columns: HEADERS }));
  }
}

function readEntries() {
  ensureDataFile();
  const content = fs.readFileSync(DATA_FILE, 'utf8');
  if (!content.trim()) return [];
  return parse(content, { columns: true, skip_empty_lines: true });
}

function writeEntries(list) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, stringify(list, { header: true, columns: HEADERS }));
}

// ---------- API ----------

// 一覧取得（タイムテーブル表示用。PINは含めない）
app.get('/api/entries', (req, res) => {
  const list = readEntries();
  const sanitized = list.map(({ pin, ...rest }) => rest);
  res.json(sanitized);
});

// 新規エントリー登録
app.post('/api/entries', (req, res) => {
  const { id, pin, nickname, youtube, youtubeUrl, sns, date, start, end, bio, color } = req.body;

  if (!id || !/^\d{4}$/.test(pin || '')) {
    return res.status(400).json({ error: 'IDとPIN（4桁の数字）は必須です。' });
  }
  if (!youtube || !String(youtube).trim()) {
    return res.status(400).json({ error: 'YouTubeチャンネル名は必須です。' });
  }
  if (!isHttpUrl(youtubeUrl)) {
    return res.status(400).json({ error: 'YouTube URLは https:// から始まる正しいURLを入力してください。' });
  }
  if (!bio || !String(bio).trim()) {
    return res.status(400).json({ error: '自己紹介・配信内容は必須です。' });
  }
  if (!date || !start || !end || start >= end) {
    return res.status(400).json({ error: '日時が正しくありません。' });
  }
  if (start < '08:00' || end > '20:00') {
    return res.status(400).json({ error: '配信時間は8:00〜20:00の範囲で入力してください。' });
  }

  const list = readEntries();
  if (list.some(e => e.id === id)) {
    return res.status(409).json({ error: 'そのIDはすでに使われています。' });
  }

  list.push({
    id, pin, nickname: nickname || '', youtube: youtube || '', youtubeUrl: youtubeUrl || '',
    sns: sns || '', date, start, end, bio: bio || '', color: color || '#e2542c', createdAt: String(Date.now())
  });
  writeEntries(list);
  res.json({ ok: true });
});

// ログイン確認（ID + PIN）
app.post('/api/login', (req, res) => {
  const { id, pin } = req.body;
  const list = readEntries();
  const entry = list.find(e => e.id === id && e.pin === pin);
  if (!entry) return res.status(401).json({ error: 'IDまたはPINが正しくありません。' });
  const { pin: _pin, ...rest } = entry;
  res.json(rest);
});

// エントリー更新（本人のみ・PINで認証）
app.put('/api/entries/:id', (req, res) => {
  const { id } = req.params;
  const { pin, ...updates } = req.body;
  const list = readEntries();
  const idx = list.findIndex(e => e.id === id && e.pin === pin);
  if (idx === -1) return res.status(401).json({ error: '認証に失敗しました。IDとPINを確認してください。' });

  if ('youtube' in updates && !String(updates.youtube || '').trim()) {
    return res.status(400).json({ error: 'YouTubeチャンネル名は必須です。' });
  }
  if ('youtubeUrl' in updates && !isHttpUrl(updates.youtubeUrl)) {
    return res.status(400).json({ error: 'YouTube URLは https:// から始まる正しいURLを入力してください。' });
  }
  if ('bio' in updates && !String(updates.bio || '').trim()) {
    return res.status(400).json({ error: '自己紹介・配信内容は必須です。' });
  }
  if (updates.start && updates.end && updates.start >= updates.end) {
    return res.status(400).json({ error: '終了時刻は開始時刻より後にしてください。' });
  }
  if (updates.start && updates.start < '08:00') {
    return res.status(400).json({ error: '配信時間は8:00〜20:00の範囲で入力してください。' });
  }
  if (updates.end && updates.end > '20:00') {
    return res.status(400).json({ error: '配信時間は8:00〜20:00の範囲で入力してください。' });
  }

  list[idx] = { ...list[idx], ...updates };
  writeEntries(list);
  res.json({ ok: true });
});

// エントリー削除（本人のみ・PINで認証）
app.delete('/api/entries/:id', (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;
  let list = readEntries();
  const before = list.length;
  list = list.filter(e => !(e.id === id && e.pin === pin));
  if (list.length === before) return res.status(401).json({ error: '認証に失敗しました。IDとPINを確認してください。' });
  writeEntries(list);
  res.json({ ok: true });
});

// ---------- YouTubeチャンネルアイコン取得（og:image抽出・SSRF対策あり） ----------
const ALLOWED_YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const thumbCache = new Map(); // href -> { thumb, ts }
const THUMB_TTL = 6 * 60 * 60 * 1000; // 6時間

app.get('/api/channel-thumb', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return res.status(400).json({ error: 'invalid url' }); }
  // SSRF対策: スキームとホストを厳格に制限
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'invalid scheme' });
  }
  if (!ALLOWED_YT_HOSTS.has(parsed.hostname)) {
    return res.status(400).json({ error: 'not a youtube url' });
  }

  const key = parsed.href;
  const hit = thumbCache.get(key);
  if (hit && Date.now() - hit.ts < THUMB_TTL) {
    return res.json({ thumb: hit.thumb });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(parsed.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'ja,en;q=0.8',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return res.status(502).json({ error: 'fetch failed' });
    const html = await r.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const thumb = m ? m[1] : null;
    if (!thumb || !/^https:\/\//i.test(thumb)) {
      return res.status(404).json({ error: 'no thumbnail' });
    }
    thumbCache.set(key, { thumb, ts: Date.now() });
    return res.json({ thumb });
  } catch (e) {
    return res.status(504).json({ error: 'timeout or fetch error' });
  }
});

app.listen(PORT, () => {
  console.log(`🏮 夏祭りサーバー起動中: http://localhost:${PORT}`);
  console.log(`ログファイル: ${DATA_FILE}`);
});
