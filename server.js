/**
 * CC Voice v2.0 — 后端服务
 * Express + WebSocket + SQLite + Owner/Observer 权限 + @Claude AI + 上下文蒸馏
 */

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

// ─── 配置 ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3456', 10);
const HOST = '0.0.0.0';
const CC_PROJECT = process.env.CC_PROJECT || 'main'; // 保留兼容，cli 模式下已不再使用
const BRIDGE_MODE = process.env.BRIDGE_MODE || 'mock';
const CC_API_BASE = process.env.CC_API_BASE || 'http://localhost:8080';
// Claude CLI 相关（cli 模式专用）
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet'; // 默认 sonnet（比 opus 便宜 ~5x）
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions'; // 远程自用放行工具调用
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd(); // Claude 执行时的工作目录

// ─── SQLite ─────────────────────────────────────────────
const Database = require('better-sqlite3');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'cc-voice.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- 用户 (v2: 新增 role 字段)
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL UNIQUE,
    avatar TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'observer' CHECK(role IN ('owner','observer')),
    invite_code TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    token_expires INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- 好友关系（双向）
  CREATE TABLE IF NOT EXISTS friends (
    user_id TEXT NOT NULL REFERENCES users(id),
    friend_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  );

  -- 会话（支持 1v1 和群聊）
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新对话',
    type TEXT NOT NULL DEFAULT 'ai' CHECK(type IN ('ai','dm','group')),
    owner_id TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0
  );

  -- 会话成员
  CREATE TABLE IF NOT EXISTS conv_members (
    conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (conv_id, user_id)
  );

  -- 消息 (v2: role 新增 suggestion)
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT REFERENCES users(id),
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system','suggestion')),
    content TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'done',
    starred INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_starred ON messages(starred) WHERE starred = 1;
  CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conv_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_users_invite ON users(invite_code);
  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);

  -- v2: schema migration for existing databases (add role column if missing)
  -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, handled in JS below
`);

// ─── v2 迁移: 已有库补 role 字段 ─────────────────────────
try {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'observer' CHECK(role IN ('owner','observer'))");
    // 第一个用户升级为 owner
    const first = db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get();
    if (first) db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(first.id);
    console.log('[migrate] users.role column added');
  }
  const msgCols = db.prepare("PRAGMA table_info(messages)").all();
  // messages.role CHECK 约束无法 ALTER, 但 SQLite 不强制 CHECK on existing rows
  // 新插入的 suggestion 消息会通过 JS 端控制
} catch (e) { console.error('[migrate]', e.message); }

// ─── 预编译 SQL ─────────────────────────────────────────
const stmts = {
  // 用户
  createUser: db.prepare('INSERT INTO users (id, nickname, avatar, role, invite_code, token, token_expires, created_at) VALUES (?,?,?,?,?,?,?,?)'),
  getUserByToken: db.prepare('SELECT * FROM users WHERE token = ? AND token_expires > ?'),
  refreshToken: db.prepare('UPDATE users SET token = ?, token_expires = ? WHERE id = ?'),
  invalidateToken: db.prepare('UPDATE users SET token_expires = 0 WHERE id = ?'),
  getUserByNickname: db.prepare('SELECT id FROM users WHERE nickname = ?'),
  getUserById: db.prepare('SELECT id, nickname, avatar, role, invite_code, created_at FROM users WHERE id = ?'),
  getUserByInvite: db.prepare('SELECT id, nickname, avatar, invite_code, created_at FROM users WHERE invite_code = ?'),
  updateUser: db.prepare('UPDATE users SET nickname = ?, avatar = ? WHERE id = ?'),
  // 好友
  addFriend: db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)'),
  removeFriend: db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?'),
  getFriends: db.prepare('SELECT u.id, u.nickname, u.avatar, u.invite_code FROM friends f JOIN users u ON f.friend_id = u.id WHERE f.user_id = ? ORDER BY u.nickname'),
  isFriend: db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?'),
  // 会话
  createConv: db.prepare('INSERT INTO conversations (id, title, type, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)'),
  updateConvTitle: db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?'),
  updateConvTime: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
  togglePin: db.prepare('UPDATE conversations SET pinned = CASE WHEN pinned=1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?'),
  deleteConv: db.prepare('DELETE FROM conversations WHERE id = ?'),
  getConv: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  // 获取用户的所有会话（通过 conv_members）
  listUserConvs: db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM messages WHERE conv_id = c.id) as msg_count
    FROM conversations c
    JOIN conv_members cm ON c.id = cm.conv_id
    WHERE cm.user_id = ?
    ORDER BY c.pinned DESC, c.updated_at DESC
  `),
  // 会话成员
  addMember: db.prepare('INSERT OR IGNORE INTO conv_members (conv_id, user_id, joined_at) VALUES (?,?,?)'),
  removeMember: db.prepare('DELETE FROM conv_members WHERE conv_id = ? AND user_id = ?'),
  getMembers: db.prepare('SELECT u.id, u.nickname, u.avatar FROM conv_members cm JOIN users u ON cm.user_id = u.id WHERE cm.conv_id = ?'),
  isMember: db.prepare('SELECT 1 FROM conv_members WHERE conv_id = ? AND user_id = ?'),
  // 查找两人之间的 DM 会话
  findDM: db.prepare(`
    SELECT c.id FROM conversations c
    WHERE c.type = 'dm'
    AND EXISTS (SELECT 1 FROM conv_members WHERE conv_id = c.id AND user_id = ?)
    AND EXISTS (SELECT 1 FROM conv_members WHERE conv_id = c.id AND user_id = ?)
    LIMIT 1
  `),
  // 消息
  insertMsg: db.prepare('INSERT INTO messages (conv_id, sender_id, role, content, status, created_at) VALUES (?,?,?,?,?,?)'),
  updateMsg: db.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?'),
  toggleStar: db.prepare('UPDATE messages SET starred = CASE WHEN starred=1 THEN 0 ELSE 1 END WHERE id = ?'),
  getMessages: db.prepare('SELECT m.*, u.nickname as sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.conv_id = ? ORDER BY m.created_at ASC'),
  getStarred: db.prepare('SELECT m.*, c.title as conv_title FROM messages m JOIN conversations c ON m.conv_id = c.id JOIN conv_members cm ON c.id = cm.conv_id WHERE m.starred = 1 AND cm.user_id = ? ORDER BY m.created_at DESC'),
  searchMessages: db.prepare("SELECT m.*, c.title as conv_title FROM messages m JOIN conversations c ON m.conv_id = c.id JOIN conv_members cm ON c.id = cm.conv_id WHERE m.content LIKE ? AND cm.user_id = ? ORDER BY m.created_at DESC LIMIT 50"),
};

function genId() { return Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function genInviteCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); } // 6 位
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

// 种子用户（第一个注册的人不需要邀请码）
function isFirstUser() { return db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt === 0; }

// ─── Express ────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 认证中间件（带 token 过期检查）
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  const user = stmts.getUserByToken.get(token, Date.now());
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

// ─── API: 用户 ──────────────────────────────────────────

// 注册：需要邀请码（第一个用户除外）
app.post('/api/register', (req, res) => {
  const { nickname, referral_code } = req.body;
  if (!nickname || nickname.trim().length < 1 || nickname.trim().length > 20) {
    return res.status(400).json({ error: 'Nickname required (1-20 chars)' });
  }
  const name = nickname.trim();

  // 昵称唯一性检查
  if (stmts.getUserByNickname.get(name)) {
    return res.status(409).json({ error: 'Nickname already taken' });
  }

  // 邀请码门槛：第一个用户免邀请码，后续必须有已有用户的邀请码
  if (!isFirstUser()) {
    if (!referral_code) return res.status(400).json({ error: 'Referral code required', need_referral: true });
    const referrer = stmts.getUserByInvite.get(referral_code.toUpperCase());
    if (!referrer) return res.status(400).json({ error: 'Invalid referral code' });
  }

  const id = genId();
  const token = genToken();
  const invite_code = genInviteCode();
  const now = Date.now();
  const expires = now + TOKEN_TTL;
  const role = isFirstUser() ? 'owner' : 'observer';

  stmts.createUser.run(id, name, '', role, invite_code, token, expires, now);
  res.json({ id, nickname: name, invite_code, token, token_expires: expires, role });
});

// 登录：已有用户通过昵称重新获取 token（简易登录）
app.post('/api/login', (req, res) => {
  const { nickname } = req.body;
  if (!nickname) return res.status(400).json({ error: 'Nickname required' });
  const existing = stmts.getUserByNickname.get(nickname.trim());
  if (!existing) return res.status(404).json({ error: 'User not found' });
  // 刷新 token
  const newToken = genToken();
  const expires = Date.now() + TOKEN_TTL;
  stmts.refreshToken.run(newToken, expires, existing.id);
  const user = stmts.getUserById.get(existing.id);
  res.json({ ...user, token: newToken, token_expires: expires });
});

// 登出
app.post('/api/logout', auth, (req, res) => {
  stmts.invalidateToken.run(req.user.id);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const { id, nickname, avatar, role, invite_code, created_at } = req.user;
  res.json({ id, nickname, avatar, role, invite_code, created_at });
});

app.patch('/api/me', auth, (req, res) => {
  const { nickname, avatar } = req.body;
  if (nickname && nickname.trim() !== req.user.nickname) {
    if (stmts.getUserByNickname.get(nickname.trim())) {
      return res.status(409).json({ error: 'Nickname already taken' });
    }
  }
  stmts.updateUser.run(nickname?.trim() || req.user.nickname, avatar || req.user.avatar, req.user.id);
  res.json({ ok: true });
});

// ─── API: 好友 ──────────────────────────────────────────
app.get('/api/friends', auth, (req, res) => {
  res.json(stmts.getFriends.all(req.user.id));
});

app.post('/api/friends/add', auth, (req, res) => {
  const { invite_code } = req.body;
  if (!invite_code) return res.status(400).json({ error: 'Invite code required' });
  const target = stmts.getUserByInvite.get(invite_code.toUpperCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
  const now = Date.now();
  // 双向添加
  stmts.addFriend.run(req.user.id, target.id, now);
  stmts.addFriend.run(target.id, req.user.id, now);
  res.json(target);
});

app.delete('/api/friends/:id', auth, (req, res) => {
  stmts.removeFriend.run(req.user.id, req.params.id);
  stmts.removeFriend.run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ─── API: 会话 ──────────────────────────────────────────
app.get('/api/conversations', auth, (req, res) => {
  res.json(stmts.listUserConvs.all(req.user.id));
});

app.post('/api/conversations', auth, (req, res) => {
  const id = genId();
  const now = Date.now();
  const title = req.body.title || '新对话';
  const type = req.body.type || 'ai'; // ai | dm | group
  const members = req.body.members || []; // 对方用户 id 列表

  stmts.createConv.run(id, title, type, req.user.id, now, now);
  stmts.addMember.run(id, req.user.id, now);

  for (const mid of members) {
    stmts.addMember.run(id, mid, now);
  }

  res.json({ ...stmts.getConv.get(id), members: stmts.getMembers.all(id) });
});

// 开始与好友的 DM（如果已有就返回已有会话）
app.post('/api/dm/:friendId', auth, (req, res) => {
  const friendId = req.params.friendId;
  // 检查是否是好友
  if (!stmts.isFriend.get(req.user.id, friendId)) {
    return res.status(403).json({ error: 'Not friends' });
  }
  // 查找已有 DM
  const existing = stmts.findDM.get(req.user.id, friendId);
  if (existing) {
    return res.json({ ...stmts.getConv.get(existing.id), members: stmts.getMembers.all(existing.id) });
  }
  // 创建新 DM
  const friend = stmts.getUserById.get(friendId);
  const id = genId();
  const now = Date.now();
  stmts.createConv.run(id, friend.nickname, 'dm', req.user.id, now, now);
  stmts.addMember.run(id, req.user.id, now);
  stmts.addMember.run(id, friendId, now);
  res.json({ ...stmts.getConv.get(id), members: stmts.getMembers.all(id) });
});

app.patch('/api/conversations/:id', auth, (req, res) => {
  const { id } = req.params;
  if (!stmts.isMember.get(id, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  if (req.body.title !== undefined) stmts.updateConvTitle.run(req.body.title, Date.now(), id);
  if (req.body.pinned !== undefined) stmts.togglePin.run(Date.now(), id);
  res.json(stmts.getConv.get(id));
});

app.delete('/api/conversations/:id', auth, (req, res) => {
  const conv = stmts.getConv.get(req.params.id);
  if (!conv || conv.owner_id !== req.user.id) return res.status(403).json({ error: 'Not owner' });
  stmts.deleteConv.run(req.params.id);
  res.json({ ok: true });
});

// ─── API: 消息 ──────────────────────────────────────────
app.get('/api/conversations/:id/messages', auth, (req, res) => {
  if (!stmts.isMember.get(req.params.id, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  res.json(stmts.getMessages.all(req.params.id));
});

app.patch('/api/messages/:id/star', auth, (req, res) => {
  stmts.toggleStar.run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/messages/starred', auth, (req, res) => {
  res.json(stmts.getStarred.all(req.user.id));
});

app.get('/api/messages/search', auth, (req, res) => {
  const q = req.query.q || '';
  if (q.length < 1) return res.json([]);
  res.json(stmts.searchMessages.all(`%${q}%`, req.user.id));
});

app.get('/api/conversations/:id/export', auth, (req, res) => {
  const conv = stmts.getConv.get(req.params.id);
  if (!conv) return res.status(404).send('Not found');
  const msgs = stmts.getMessages.all(req.params.id);
  let md = `# ${conv.title}\n\n_Exported ${new Date().toISOString()}_\n\n---\n\n`;
  for (const m of msgs) {
    const time = new Date(m.created_at).toLocaleString();
    const name = m.role === 'assistant' ? '**Claude**' : `**${m.sender_name || 'User'}**`;
    md += `${name} _${time}_\n\n${m.content}\n\n---\n\n`;
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${conv.title}.md"`);
  res.send(md);
});

// ─── API: 上下文蒸馏 (v2) ──────────────────────────────
// Owner 点"发指令"时调用: 把近 N 条群聊总结成 prompt 草稿
app.post('/api/distill', auth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owner can distill' });
  const { convId, limit } = req.body;
  if (!convId) return res.status(400).json({ error: 'convId required' });
  const n = Math.min(limit || 30, 100);
  const msgs = db.prepare(
    `SELECT m.*, u.nickname as sender_name FROM messages m
     LEFT JOIN users u ON m.sender_id = u.id
     WHERE m.conv_id = ? ORDER BY m.created_at DESC LIMIT ?`
  ).all(convId, n).reverse();

  if (msgs.length === 0) return res.json({ draft: '' });

  // 构建上下文给 haiku 蒸馏
  const context = msgs.map(m => {
    const tag = m.role === 'suggestion' ? '[建议]' : m.role === 'assistant' ? '[Claude]' : '';
    return `${m.sender_name || m.role}${tag}: ${m.content}`;
  }).join('\n');

  const distillPrompt = `你是一个 prompt 整合助手。以下是一段多人讨论记录，请提取其中的共识和关键指令，生成一段结构化的、可直接发给 Claude Code 执行的 prompt。

要求:
- 提取所有人都同意的方向
- 如有分歧，标注出来
- 输出格式是可执行的指令，不是聊天复述
- 特别注意 [建议] 标记的消息

讨论记录:
${context}

请输出整合后的 prompt 草稿:`;

  // 用本地 claude CLI + haiku 蒸馏
  const child = spawn(CLAUDE_BIN, [
    '-p', '--output-format', 'text',
    '--max-turns', '1',
    '--model', 'haiku',
    distillPrompt,
  ], { cwd: CLAUDE_CWD });

  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => console.error('[distill]', d.toString()));
  child.on('close', code => {
    if (code === 0) {
      res.json({ draft: output.trim() });
    } else {
      // fallback: 直接拼接最近的消息
      const fallback = msgs
        .filter(m => m.role === 'user' || m.role === 'suggestion')
        .map(m => m.content)
        .join('\n');
      res.json({ draft: fallback, fallback: true });
    }
  });
  child.on('error', () => {
    res.status(500).json({ error: 'Distill failed' });
  });
});

// Health & CA cert
app.get('/health', (req, res) => res.json({ status: 'ok', bridge: BRIDGE_MODE }));
app.get('/ca.pem', (req, res) => {
  try {
    const { execSync } = require('child_process');
    const caRoot = execSync('mkcert -CAROOT', { encoding: 'utf-8' }).trim();
    const caPath = path.join(caRoot, 'rootCA.pem');
    if (fs.existsSync(caPath)) { res.setHeader('Content-Type', 'application/x-pem-file'); res.sendFile(caPath); }
    else res.status(404).send('Not found');
  } catch { res.status(500).send('mkcert not available'); }
});

// ─── HTTPS / HTTP ───────────────────────────────────────
let server;
const certPath = path.join(__dirname, 'certs', 'server.pem');
const keyPath = path.join(__dirname, 'certs', 'server-key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
} else {
  server = http.createServer(app);
}

// ─── cc-connect 桥接层 ─────────────────────────────────
async function sendToCCConnect(text, onChunk, onStatus) {
  switch (BRIDGE_MODE) {
    case 'management-api': return bridgeManagementAPI(text, onChunk, onStatus);
    case 'cli': return bridgeCLI(text, onChunk, onStatus);
    default: return bridgeMock(text, onChunk, onStatus);
  }
}

async function bridgeManagementAPI(text, onChunk, onStatus) {
  onStatus('thinking');
  const url = `${CC_API_BASE}/api/v1/projects/${CC_PROJECT}/messages`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  onStatus('executing');
  const reader = res.body.getReader(); const dec = new TextDecoder(); let full = '';
  while (true) { const { done, value } = await reader.read(); if (done) break; const c = dec.decode(value, { stream: true }); full += c; onChunk(c); }
  onStatus('done'); return full;
}

// 从 claude stream-json 事件里抽取文本片段
// 支持两种事件形态:
//   1) stream_event / content_block_delta / text_delta (带 --include-partial-messages 时，真流式)
//   2) assistant / message.content[].text (不带 partial 时，整段一次性给出)
// 策略: 优先用 stream 增量; 一旦见过增量就忽略 assistant 整段避免重复
function makeStreamExtractor() {
  let streaming = false;
  return function extract(evt) {
    if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
      const d = evt.event.delta;
      if (d?.type === 'text_delta' && d.text) { streaming = true; return d.text; }
      return '';
    }
    if (evt.type === 'assistant' && !streaming && Array.isArray(evt.message?.content)) {
      return evt.message.content
        .filter(c => c.type === 'text')
        .map(c => c.text || '')
        .join('');
    }
    return '';
  };
}

function bridgeCLI(text, onChunk, onStatus) {
  return new Promise((resolve, reject) => {
    onStatus('thinking');
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--model', CLAUDE_MODEL,
      '--permission-mode', CLAUDE_PERMISSION_MODE,
      '-',  // 从 stdin 读取 prompt
    ];
    const child = spawn(CLAUDE_BIN, args, { cwd: CLAUDE_CWD });
    // 通过 stdin 传 prompt（避免参数过长）
    child.stdin.write(text);
    child.stdin.end();
    const extract = makeStreamExtractor();
    let full = '';
    let buf = '';
    let executingSent = false;

    child.stdout.on('data', d => {
      buf += d.toString();
      // stream-json 是 JSONL: 按换行切
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch (e) { continue; } // 非 JSON 行忽略
        // 状态转换
        if (evt.type === 'system' && evt.subtype === 'init' && !executingSent) {
          onStatus('executing'); executingSent = true;
        }
        if (evt.type === 'result' && evt.is_error) {
          onStatus('error');
          return reject(new Error(evt.api_error_status || 'claude returned error'));
        }
        // 文本抽取
        const chunk = extract(evt);
        if (chunk) {
          if (!executingSent) { onStatus('executing'); executingSent = true; }
          full += chunk;
          onChunk(chunk);
        }
      }
    });

    child.stderr.on('data', d => console.error('[claude]', d.toString()));
    child.on('close', code => {
      if (code === 0) { onStatus('done'); resolve(full); }
      else { onStatus('error'); reject(new Error(`claude exit ${code}`)); }
    });
    child.on('error', e => { onStatus('error'); reject(e); });
  });
}

function bridgeMock(text, onChunk, onStatus) {
  return new Promise(resolve => {
    onStatus('thinking');
    const isZh = /[\u4e00-\u9fa5]/.test(text);
    setTimeout(() => {
      onStatus('executing');
      const lines = isZh
        ? [`收到: "${text}"`, '', '分析并执行中...', '', '```', `// 命令: ${text}`, '```', '', '✅ 完成（Mock）']
        : [`Received: "${text}"`, '', 'Executing...', '', '```', `// Command: ${text}`, '```', '', '✅ Done (Mock)'];
      let full = '', i = 0;
      const iv = setInterval(() => {
        if (i >= lines.length) { clearInterval(iv); onStatus('done'); resolve(full); return; }
        const c = lines[i] + '\n'; full += c; onChunk(c); i++;
      }, 120);
    }, 600);
  });
}

// ─── WS RPC Handler (relay 模式) ────────────────────────
// 将 HTTP API 请求映射为函数调用，供 relay WS 透传
async function handleRPC(method, rpcPath, body, token) {
  // 鉴权
  let user = null;
  if (token) {
    user = stmts.getUserByToken.get(token, Date.now());
  }

  function requireAuth() {
    if (!user) throw { status: 401, message: 'Not authenticated' };
  }

  // 路由匹配
  const m = (mt, pattern) => {
    if (method !== mt) return null;
    const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    return rpcPath.match(regex);
  };

  let match;

  // ─── 用户 ──────────────────────
  if (m('POST', '/api/register')) {
    const { nickname, referral_code } = body || {};
    if (!nickname || nickname.trim().length < 1 || nickname.trim().length > 20) {
      throw { status: 400, message: 'Nickname required (1-20 chars)' };
    }
    const name = nickname.trim();
    if (stmts.getUserByNickname.get(name)) throw { status: 409, message: 'Nickname already taken' };

    if (!isFirstUser()) {
      if (!referral_code) throw { status: 400, message: 'Referral code required' };
      const referrer = stmts.getUserByInvite.get(referral_code.toUpperCase());
      if (!referrer) throw { status: 400, message: 'Invalid referral code' };
    }

    const id = genId(), newToken = genToken(), invite_code = genInviteCode();
    const now = Date.now(), expires = now + TOKEN_TTL;
    const role = isFirstUser() ? 'owner' : 'observer';
    stmts.createUser.run(id, name, '', role, invite_code, newToken, expires, now);
    return { body: { id, nickname: name, invite_code, token: newToken, token_expires: expires, role } };
  }

  if (m('POST', '/api/login')) {
    const { nickname } = body || {};
    if (!nickname) throw { status: 400, message: 'Nickname required' };
    const existing = stmts.getUserByNickname.get(nickname.trim());
    if (!existing) throw { status: 404, message: 'User not found' };
    const newToken = genToken(), expires = Date.now() + TOKEN_TTL;
    stmts.refreshToken.run(newToken, expires, existing.id);
    const u = stmts.getUserById.get(existing.id);
    return { body: { ...u, token: newToken, token_expires: expires } };
  }

  if (m('POST', '/api/logout')) {
    requireAuth();
    stmts.invalidateToken.run(user.id);
    return { body: { ok: true } };
  }

  if (m('GET', '/api/me')) {
    requireAuth();
    const { id, nickname, avatar, role, invite_code, created_at } = user;
    return { body: { id, nickname, avatar, role, invite_code, created_at } };
  }

  if (m('PATCH', '/api/me')) {
    requireAuth();
    const { nickname, avatar } = body || {};
    if (nickname && nickname.trim() !== user.nickname) {
      if (stmts.getUserByNickname.get(nickname.trim())) throw { status: 409, message: 'Nickname already taken' };
    }
    stmts.updateUser.run(nickname?.trim() || user.nickname, avatar || user.avatar, user.id);
    return { body: { ok: true } };
  }

  // ─── 好友 ──────────────────────
  if (m('GET', '/api/friends')) {
    requireAuth();
    return { body: stmts.getFriends.all(user.id) };
  }

  if (m('POST', '/api/friends/add')) {
    requireAuth();
    const { invite_code } = body || {};
    if (!invite_code) throw { status: 400, message: 'Invite code required' };
    const target = stmts.getUserByInvite.get(invite_code.toUpperCase());
    if (!target) throw { status: 404, message: 'User not found' };
    if (target.id === user.id) throw { status: 400, message: 'Cannot add yourself' };
    const now = Date.now();
    stmts.addFriend.run(user.id, target.id, now);
    stmts.addFriend.run(target.id, user.id, now);
    return { body: target };
  }

  if ((match = m('DELETE', '/api/friends/:id'))) {
    requireAuth();
    stmts.removeFriend.run(user.id, match.groups.id);
    stmts.removeFriend.run(match.groups.id, user.id);
    return { body: { ok: true } };
  }

  // ─── 会话 ──────────────────────
  if (m('GET', '/api/conversations')) {
    requireAuth();
    return { body: stmts.listUserConvs.all(user.id) };
  }

  if (m('POST', '/api/conversations')) {
    requireAuth();
    const id = genId(), now = Date.now();
    const title = body?.title || '新对话';
    const type = body?.type || 'ai';
    const members = body?.members || [];
    stmts.createConv.run(id, title, type, user.id, now, now);
    stmts.addMember.run(id, user.id, now);
    for (const mid of members) stmts.addMember.run(id, mid, now);
    return { body: { ...stmts.getConv.get(id), members: stmts.getMembers.all(id) } };
  }

  if ((match = m('POST', '/api/dm/:friendId'))) {
    requireAuth();
    const friendId = match.groups.friendId;
    if (!stmts.isFriend.get(user.id, friendId)) throw { status: 403, message: 'Not friends' };
    const existing = stmts.findDM.get(user.id, friendId);
    if (existing) return { body: { ...stmts.getConv.get(existing.id), members: stmts.getMembers.all(existing.id) } };
    const friend = stmts.getUserById.get(friendId);
    const id = genId(), now = Date.now();
    stmts.createConv.run(id, friend.nickname, 'dm', user.id, now, now);
    stmts.addMember.run(id, user.id, now);
    stmts.addMember.run(id, friendId, now);
    return { body: { ...stmts.getConv.get(id), members: stmts.getMembers.all(id) } };
  }

  if ((match = m('PATCH', '/api/conversations/:id'))) {
    requireAuth();
    const cid = match.groups.id;
    if (!stmts.isMember.get(cid, user.id)) throw { status: 403, message: 'Not a member' };
    if (body?.title !== undefined) stmts.updateConvTitle.run(body.title, Date.now(), cid);
    if (body?.pinned !== undefined) stmts.togglePin.run(Date.now(), cid);
    return { body: stmts.getConv.get(cid) };
  }

  if ((match = m('DELETE', '/api/conversations/:id'))) {
    requireAuth();
    const conv = stmts.getConv.get(match.groups.id);
    if (!conv || conv.owner_id !== user.id) throw { status: 403, message: 'Not owner' };
    stmts.deleteConv.run(match.groups.id);
    return { body: { ok: true } };
  }

  // ─── 消息 ──────────────────────
  if ((match = m('GET', '/api/conversations/:id/messages'))) {
    requireAuth();
    const cid = match.groups.id;
    if (!stmts.isMember.get(cid, user.id)) throw { status: 403, message: 'Not a member' };
    return { body: stmts.getMessages.all(cid) };
  }

  if ((match = m('PATCH', '/api/messages/:id/star'))) {
    requireAuth();
    stmts.toggleStar.run(match.groups.id);
    return { body: { ok: true } };
  }

  if (m('GET', '/api/messages/starred')) {
    requireAuth();
    return { body: stmts.getStarred.all(user.id) };
  }

  if (m('GET', '/api/messages/search')) {
    requireAuth();
    const q = rpcPath.includes('?q=') ? decodeURIComponent(rpcPath.split('?q=')[1]) : '';
    if (q.length < 1) return { body: [] };
    return { body: stmts.searchMessages.all(`%${q}%`, user.id) };
  }

  // ─── 蒸馏 ──────────────────────
  if (m('POST', '/api/distill')) {
    requireAuth();
    if (user.role !== 'owner') throw { status: 403, message: 'Only owner can distill' };
    const { convId, limit } = body || {};
    if (!convId) throw { status: 400, message: 'convId required' };
    const n = Math.min(limit || 30, 100);
    const msgs = db.prepare(
      'SELECT m.*, u.nickname as sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.conv_id = ? ORDER BY m.created_at DESC LIMIT ?'
    ).all(convId, n).reverse();
    if (msgs.length === 0) return { body: { draft: '' } };

    const context = msgs.map(msg => {
      const tag = msg.role === 'suggestion' ? '[建议]' : msg.role === 'assistant' ? '[Claude]' : '';
      return `${msg.sender_name || msg.role}${tag}: ${msg.content}`;
    }).join('\n');

    const distillPrompt = `你是一个 prompt 整合助手。以下是一段多人讨论记录，请提取其中的共识和关键指令，生成一段结构化的、可直接发给 Claude Code 执行的 prompt。\n\n要求:\n- 提取所有人都同意的方向\n- 如有分歧，标注出来\n- 输出格式是可执行的指令，不是聊天复述\n- 特别注意 [建议] 标记的消息\n\n讨论记录:\n${context}\n\n请输出整合后的 prompt 草稿:`;

    return new Promise((resolve) => {
      const child = require('child_process').spawn(CLAUDE_BIN, ['-p', '--output-format', 'text', '--max-turns', '1', '--model', 'haiku', distillPrompt], { cwd: CLAUDE_CWD });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => console.error('[distill]', d.toString()));
      child.on('close', code => {
        if (code === 0) {
          resolve({ body: { draft: output.trim() } });
        } else {
          const fallback = msgs.filter(msg => msg.role === 'user' || msg.role === 'suggestion').map(msg => msg.content).join('\n');
          resolve({ body: { draft: fallback, fallback: true } });
        }
      });
      child.on('error', () => resolve({ status: 500, body: { error: 'Distill failed' } }));
    });
  }

  throw { status: 404, message: `Unknown RPC: ${method} ${rpcPath}` };
}

// ─── WebSocket ──────────────────────────────────────────
const wss = new WebSocketServer({ server });

// 在线用户映射: userId -> Set<ws>
const onlineUsers = new Map();

function addOnline(userId, ws) {
  const wasOffline = !onlineUsers.has(userId);
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(ws);
  // 通知好友上线
  if (wasOffline) broadcastPresence(userId, true);
}
function removeOnline(userId, ws) {
  const set = onlineUsers.get(userId);
  if (set) { set.delete(ws); if (set.size === 0) { onlineUsers.delete(userId); broadcastPresence(userId, false); } }
}
function broadcastPresence(userId, online) {
  const friends = stmts.getFriends.all(userId);
  for (const f of friends) {
    sendToUser(f.id, { type: 'presence', userId, online });
  }
}
function getOnlineSet() { return new Set(onlineUsers.keys()); }
function sendToUser(userId, data) {
  const set = onlineUsers.get(userId);
  if (set) { const msg = JSON.stringify(data); set.forEach(ws => { if (ws.readyState === ws.OPEN) ws.send(msg); }); }
}
function sendToConvMembers(convId, data, excludeWs) {
  const members = stmts.getMembers.all(convId);
  const msg = JSON.stringify(data);
  for (const m of members) {
    const set = onlineUsers.get(m.id);
    if (set) set.forEach(ws => { if (ws !== excludeWs && ws.readyState === ws.OPEN) ws.send(msg); });
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.userId = null;
  ws.currentConvId = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // 认证（带过期检查）
    if (data.type === 'auth') {
      const user = stmts.getUserByToken.get(data.token, Date.now());
      if (user) {
        ws.userId = user.id;
        ws.userRole = user.role || 'observer'; // v2: 缓存 role 到 ws
        addOnline(user.id, ws);
        // 返回在线好友列表
        const friends = stmts.getFriends.all(user.id);
        const onlineSet = getOnlineSet();
        const onlineFriends = friends.filter(f => onlineSet.has(f.id)).map(f => f.id);
        ws.send(JSON.stringify({ type: 'auth_ok', user: { id: user.id, nickname: user.nickname, role: user.role, invite_code: user.invite_code }, onlineFriends }));
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail' }));
      }
      return;
    }

    if (!ws.userId && data.type !== 'rpc') { ws.send(JSON.stringify({ type: 'error', content: 'Not authenticated' })); return; }

    if (data.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    // ─── WS RPC: relay 模式下替代 HTTP API ─────────────
    if (data.type === 'rpc') {
      const { id, method, path: rpcPath, body, token: rpcToken } = data;
      try {
        const result = await handleRPC(method, rpcPath, body, rpcToken);
        ws.send(JSON.stringify({ type: 'rpc_response', id, status: result.status || 200, body: result.body }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'rpc_response', id, status: e.status || 500, body: { error: e.message } }));
      }
      return;
    }

    if (data.type === 'switch_conv') {
      ws.currentConvId = data.convId;
      ws.send(JSON.stringify({ type: 'conv_switched', convId: data.convId }));
      return;
    }

    // v2: Observer 发 suggestion, Owner 发 message 或 execute (经蒸馏后执行)
    if (data.type === 'suggestion' && data.text) {
      // Observer 提建议 — 存为 suggestion 消息，不触发 Claude
      let convId = ws.currentConvId;
      if (!convId || !stmts.isMember.get(convId, ws.userId)) return;
      const text = data.text;
      const uRes = stmts.insertMsg.run(convId, ws.userId, 'suggestion', text, 'pending', Date.now());
      stmts.updateConvTime.run(Date.now(), convId);
      const senderName = stmts.getUserById.get(ws.userId)?.nickname || 'User';
      const msgPayload = { id: uRes.lastInsertRowid, conv_id: convId, sender_id: ws.userId, sender_name: senderName, role: 'suggestion', content: text, status: 'pending', created_at: Date.now() };
      sendToConvMembers(convId, { type: 'new_message', convId, message: msgPayload }, null);
      return;
    }

    if (data.type === 'message' && data.text) {
      const text = data.text;
      let convId = ws.currentConvId;

      // 自动创建 AI 会话
      if (!convId) {
        const id = genId(); const now = Date.now();
        const title = text.length > 20 ? text.substring(0, 20) + '...' : text;
        stmts.createConv.run(id, title, 'ai', ws.userId, now, now);
        stmts.addMember.run(id, ws.userId, now);
        convId = id;
        ws.currentConvId = id;
        ws.send(JSON.stringify({ type: 'conv_created', conv: { ...stmts.getConv.get(id), members: stmts.getMembers.all(id) } }));
      }

      // 权限检查
      if (!stmts.isMember.get(convId, ws.userId)) return;

      const conv = stmts.getConv.get(convId);

      // v2: Observer 的消息强制存为 suggestion
      if (ws.userRole === 'observer') {
        const uRes = stmts.insertMsg.run(convId, ws.userId, 'suggestion', text, 'pending', Date.now());
        stmts.updateConvTime.run(Date.now(), convId);
        const senderName = stmts.getUserById.get(ws.userId)?.nickname || 'User';
        sendToConvMembers(convId, {
          type: 'new_message', convId,
          message: { id: uRes.lastInsertRowid, conv_id: convId, sender_id: ws.userId, sender_name: senderName, role: 'suggestion', content: text, status: 'pending', created_at: Date.now() },
        }, null);
        return;
      }

      // --- 以下只有 Owner 能执行 ---

      // 存储用户消息
      const uRes = stmts.insertMsg.run(convId, ws.userId, 'user', text, 'done', Date.now());
      stmts.updateConvTime.run(Date.now(), convId);
      ws.send(JSON.stringify({ type: 'msg_saved', msgId: uRes.lastInsertRowid, role: 'user' }));

      // 推送给会话其他成员（实时聊天）
      const senderName = stmts.getUserById.get(ws.userId)?.nickname || 'User';
      sendToConvMembers(convId, {
        type: 'new_message',
        convId,
        message: { id: uRes.lastInsertRowid, conv_id: convId, sender_id: ws.userId, sender_name: senderName, role: 'user', content: text, status: 'done', created_at: Date.now() },
      }, ws);

      // 判断是否需要调用 Claude
      const needClaude = conv.type === 'ai' || text.includes('@claude') || text.includes('@Claude');

      if (needClaude) {
        // 去掉 @claude 前缀
        const currentMsg = text.replace(/@[Cc]laude\s*/g, '').trim() || text;

        // 拼接历史上下文（最近 20 条 user/assistant 消息）
        const history = stmts.getMessages.all(convId)
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-20); // 最多 20 条

        let prompt;
        if (history.length > 1) {
          // 有历史：把对话记录 + 当前消息拼成一个带上下文的 prompt
          const ctx = history.slice(0, -1).map(m => {
            const role = m.role === 'assistant' ? 'Assistant' : 'Human';
            return `${role}: ${m.content}`;
          }).join('\n\n');
          prompt = `以下是之前的对话记录，请基于上下文继续：\n\n${ctx}\n\nHuman: ${currentMsg}\n\n请回答最新的问题。`;
        } else {
          prompt = currentMsg;
        }

        const aRes = stmts.insertMsg.run(convId, null, 'assistant', '', 'thinking', Date.now());
        const aMsgId = aRes.lastInsertRowid;

        // 通知所有会话成员 Claude 开始思考
        const statusMsg = (status) => ({ type: 'status', id: aMsgId, convId, status });
        sendToConvMembers(convId, statusMsg('thinking'), null);

        try {
          let fullContent = '';
          await sendToCCConnect(prompt,
            (chunk) => {
              fullContent += chunk;
              sendToConvMembers(convId, { type: 'chunk', id: aMsgId, convId, content: chunk }, null);
            },
            (status) => {
              if (status !== 'thinking') sendToConvMembers(convId, statusMsg(status), null);
            },
          );
          stmts.updateMsg.run(fullContent, 'done', aMsgId);
          stmts.updateConvTime.run(Date.now(), convId);
        } catch (err) {
          stmts.updateMsg.run(`Error: ${err.message}`, 'error', aMsgId);
          sendToConvMembers(convId, { type: 'error', convId, content: err.message }, null);
        }
      }
    }
  });

  ws.on('close', () => {
    if (ws.userId) removeOnline(ws.userId, ws);
  });

  ws.send(JSON.stringify({ type: 'welcome', bridge: BRIDGE_MODE }));
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

// ─── 启动 ───────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`\n  CC Voice v2.0 running at ${proto}://localhost:${PORT}`);
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) console.log(`  LAN: ${proto}://${net.address}:${PORT}`);
    }
  }
  console.log(`  Bridge: ${BRIDGE_MODE} | DB: ${DATA_DIR}`);
  if (BRIDGE_MODE === 'cli') {
    console.log(`  Claude: ${CLAUDE_BIN} | model=${CLAUDE_MODEL} | permission=${CLAUDE_PERMISSION_MODE}`);
    console.log(`  Claude cwd: ${CLAUDE_CWD}`);
  }
  console.log('');
  if (BRIDGE_MODE === 'mock') console.log('  Mock mode. Use BRIDGE_MODE=cli for real Claude Code.\n');
  console.log('  Run ./start-tunnel.sh for public access via Cloudflare.\n');
});
