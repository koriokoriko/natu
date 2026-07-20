const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'entries.csv');
const HEADERS = ['id', 'pin', 'role', 'nickname', 'platform', 'streamUrl', 'xUrl', 'startAt', 'endAt', 'bio', 'color', 'createdAt'];

// 招待制：登録に必要なコード（環境変数で変更可）
const INVITE_CODE = process.env.INVITE_CODE || 'TouRoku2026!';
// 管理者コード：これを入れると全エントリーを削除できる（環境変数で変更可）
const ADMIN_CODE = process.env.ADMIN_CODE || 'XaYh6fx8';

// 開催期間（8/29 19:00 〜 8/30 11:00）
const FEST_MIN = '2026-08-29T19:00';
const FEST_MAX = '2026-08-30T11:00';

// ---------- バリデーション用ヘルパ ----------
const isHttpUrl = (u) => /^https?:\/\//i.test(String(u || '').trim());
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (_) { return ''; } }
const isYouTube = (u) => /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(hostOf(u));
const isTwitch = (u) => /(^|\.)twitch\.tv$/.test(hostOf(u));
const isX = (u) => /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(hostOf(u));
const inWindow = (s) => typeof s === 'string' && /^2026-08-\d{2}T\d{2}:\d{2}$/.test(s) && s >= FEST_MIN && s <= FEST_MAX;

// 基本セキュリティヘッダ（依存追加なし）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- レート制限（総当たり対策・メモリ内） ----------
// key単位で失敗回数を数え、上限でロック。id単位/グローバルで使い分ける（IP単位ロックは同一回線を巻き添えにするため不採用）
const guard = new Map(); // key -> { fails, lockUntil }
function isThrottled(key) { const g = guard.get(key); return !!(g && g.lockUntil > Date.now()); }
function retrySec(key) { const g = guard.get(key); return g ? Math.max(0, Math.ceil((g.lockUntil - Date.now()) / 1000)) : 0; }
function noteFail(key, max, lockMs) {
  const now = Date.now();
  let g = guard.get(key);
  if (!g || (g.lockUntil && g.lockUntil <= now)) g = { fails: 0, lockUntil: 0 };
  g.fails += 1;
  if (g.fails >= max) { g.lockUntil = now + lockMs; g.fails = 0; }
  guard.set(key, g);
}
function noteSuccess(key) { guard.delete(key); }
function lockMsg(key) { return `試行回数が上限に達しました。約${Math.ceil(retrySec(key) / 60)}分後に再度お試しください。`; }
const LOGIN_MAX = 10, LOGIN_LOCK = 15 * 60 * 1000; // id単位: 10回/15分ロック
const ADMIN_MAX = 15, ADMIN_LOCK = 10 * 60 * 1000; // 管理者: 全体で15回/10分ロック

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

// 送信データを役割ごとに正規化する（不要フィールドは空に）
function normalize(role, src) {
  return {
    role,
    nickname: String(src.nickname || '').trim(),
    platform: role === 'streamer' ? (src.platform || '') : '',
    streamUrl: role === 'streamer' ? String(src.streamUrl || '').trim() : '',
    xUrl: role === 'supporter' ? String(src.xUrl || '').trim() : '',
    startAt: role === 'streamer' ? String(src.startAt || '') : '',
    endAt: role === 'streamer' ? String(src.endAt || '') : '',
    bio: String(src.bio || '').trim(),
    color: role === 'streamer' ? (/^#[0-9a-fA-F]{3,8}$/.test(String(src.color || '')) ? src.color : '#7C3AED') : '',
  };
}

// 役割ごとの入力検証。問題があればエラーメッセージ文字列を返す（無ければ null）
function validateEntry(role, src) {
  if (!src.nickname || !String(src.nickname).trim()) return 'ニックネームは必須です。';
  if (role === 'streamer') {
    if (src.platform !== 'youtube' && src.platform !== 'twitch') return '配信プラットフォームを選択してください。';
    if (!isHttpUrl(src.streamUrl)) return '配信URLは https:// から始まる正しいURLを入力してください。';
    if (src.platform === 'youtube' && !isYouTube(src.streamUrl)) return 'YouTubeのURL（youtube.com / youtu.be）を入力してください。';
    if (src.platform === 'twitch' && !isTwitch(src.streamUrl)) return 'TwitchのURL（twitch.tv）を入力してください。';
    if (!inWindow(src.startAt) || !inWindow(src.endAt)) return '配信日時は 8/29 19:00 〜 8/30 11:00 の期間内で入力してください。';
    if (src.startAt >= src.endAt) return '終了日時は開始日時より後にしてください。';
    if (!src.bio || !String(src.bio).trim()) return '自己紹介・配信内容は必須です。';
  } else if (role === 'supporter') {
    if (!isHttpUrl(src.xUrl) || !isX(src.xUrl)) return 'X（x.com / twitter.com）のURLを入力してください。';
  } else {
    return '参加タイプが不正です。';
  }
  return null;
}

// ---------- API ----------

// コード判定ゲート（招待コード / 管理者コード / 不一致）
// ※ロックはブラウザ単位でクライアント側が管理する（IP単位ロックだと同一回線の全員を巻き添えにするため不採用）
app.get('/api/gate', (req, res) => {
  const code = String(req.query.code || '');
  if (code === INVITE_CODE) return res.json({ result: 'invite' });
  if (code === ADMIN_CODE) return res.json({ result: 'admin' });
  return res.json({ result: 'none' });
});

// 一覧取得（PINは含めない）
app.get('/api/entries', (req, res) => {
  const list = readEntries();
  const sanitized = list.map(({ pin, ...rest }) => rest);
  res.json(sanitized);
});

// 新規エントリー登録（招待制）
app.post('/api/entries', (req, res) => {
  const { invite, id, pin, role } = req.body;

  if (String(invite || '') !== INVITE_CODE) {
    return res.status(403).json({ error: '招待コードが正しくありません。登録は招待制です。' });
  }
  if (!id || !/^\d{4}$/.test(pin || '')) {
    return res.status(400).json({ error: 'IDとPIN（4桁の数字）は必須です。' });
  }
  if (role !== 'streamer' && role !== 'supporter') {
    return res.status(400).json({ error: '参加タイプが不正です。' });
  }
  const err = validateEntry(role, req.body);
  if (err) return res.status(400).json({ error: err });

  const list = readEntries();
  if (list.some(e => e.id === id)) {
    return res.status(409).json({ error: 'そのIDはすでに使われています。' });
  }

  list.push({ id, pin, ...normalize(role, req.body), createdAt: String(Date.now()) });
  writeEntries(list);
  res.json({ ok: true });
});

// ログイン確認（ID + PIN）
app.post('/api/login', (req, res) => {
  const { id, pin } = req.body;
  const key = 'auth:' + String(id || '');
  if (isThrottled(key)) return res.status(429).json({ error: lockMsg(key) });
  const list = readEntries();
  const entry = list.find(e => e.id === id && e.pin === pin);
  if (!entry) { noteFail(key, LOGIN_MAX, LOGIN_LOCK); return res.status(401).json({ error: 'IDまたはPINが正しくありません。' }); }
  noteSuccess(key);
  const { pin: _pin, ...rest } = entry;
  res.json(rest);
});

// エントリー更新（本人のみ・PINで認証）
app.put('/api/entries/:id', (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;
  const key = 'auth:' + String(id || '');
  if (isThrottled(key)) return res.status(429).json({ error: lockMsg(key) });
  const list = readEntries();
  const idx = list.findIndex(e => e.id === id && e.pin === pin);
  if (idx === -1) { noteFail(key, LOGIN_MAX, LOGIN_LOCK); return res.status(401).json({ error: '認証に失敗しました。IDとPINを確認してください。' }); }
  noteSuccess(key);

  const role = req.body.role || list[idx].role;
  if (role !== 'streamer' && role !== 'supporter') {
    return res.status(400).json({ error: '参加タイプが不正です。' });
  }
  const err = validateEntry(role, req.body);
  if (err) return res.status(400).json({ error: err });

  list[idx] = { id: list[idx].id, pin: list[idx].pin, ...normalize(role, req.body), createdAt: list[idx].createdAt };
  writeEntries(list);
  res.json({ ok: true });
});

// 管理者による更新（PIN不要・管理者コードで認証）
app.post('/api/admin/update', (req, res) => {
  const { code, id } = req.body;
  if (isThrottled('admin')) return res.status(429).json({ error: lockMsg('admin') });
  if (String(code || '') !== ADMIN_CODE) {
    noteFail('admin', ADMIN_MAX, ADMIN_LOCK);
    return res.status(403).json({ error: '管理者コードが正しくありません。' });
  }
  noteSuccess('admin');
  const list = readEntries();
  const idx = list.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: '対象のエントリーが見つかりません。' });

  const role = req.body.role || list[idx].role;
  if (role !== 'streamer' && role !== 'supporter') {
    return res.status(400).json({ error: '参加タイプが不正です。' });
  }
  const err = validateEntry(role, req.body);
  if (err) return res.status(400).json({ error: err });

  list[idx] = { id: list[idx].id, pin: list[idx].pin, ...normalize(role, req.body), createdAt: list[idx].createdAt };
  writeEntries(list);
  res.json({ ok: true });
});

// 管理者による削除（PIN不要・管理者コードで認証）
app.post('/api/admin/delete', (req, res) => {
  const { code, id } = req.body;
  if (isThrottled('admin')) return res.status(429).json({ error: lockMsg('admin') });
  if (String(code || '') !== ADMIN_CODE) {
    noteFail('admin', ADMIN_MAX, ADMIN_LOCK);
    return res.status(403).json({ error: '管理者コードが正しくありません。' });
  }
  noteSuccess('admin');
  let list = readEntries();
  const before = list.length;
  list = list.filter(e => e.id !== id);
  if (list.length === before) return res.status(404).json({ error: '対象のエントリーが見つかりません。' });
  writeEntries(list);
  res.json({ ok: true });
});

// エントリー削除（本人のみ・PINで認証）
app.delete('/api/entries/:id', (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;
  const key = 'auth:' + String(id || '');
  if (isThrottled(key)) return res.status(429).json({ error: lockMsg(key) });
  let list = readEntries();
  const before = list.length;
  list = list.filter(e => !(e.id === id && e.pin === pin));
  if (list.length === before) { noteFail(key, LOGIN_MAX, LOGIN_LOCK); return res.status(401).json({ error: '認証に失敗しました。IDとPINを確認してください。' }); }
  noteSuccess(key);
  writeEntries(list);
  res.json({ ok: true });
});

// ---------- YouTube/Twitchチャンネルアイコン取得（og:image抽出・SSRF対策あり） ----------
const ALLOWED_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  'twitch.tv', 'www.twitch.tv', 'm.twitch.tv',
]);
const thumbCache = new Map(); // href -> { thumb, ts }
const THUMB_TTL = 6 * 60 * 60 * 1000; // 6時間

app.get('/api/channel-thumb', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return res.status(400).json({ error: 'invalid url' }); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'invalid scheme' });
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return res.status(400).json({ error: 'not an allowed url' });
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
  console.log(`🏮 NGS夏フェス！2026 サーバー起動中: http://localhost:${PORT}`);
  console.log(`ログファイル: ${DATA_FILE}`);
  console.log(`招待コード: ${INVITE_CODE}`);
  console.log(`管理者コード: ${ADMIN_CODE}`);
});
