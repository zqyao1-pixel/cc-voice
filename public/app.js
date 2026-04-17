/**
 * CC Voice v2.0 — 前端
 * Owner/Observer 权限 + 上下文蒸馏 + @Claude + 多会话 + 搜索 + 收藏 + 通知
 */

// ─── 多语言 ─────────────────────────────────────────────
const LANG = {
  zh: {
    title: 'CC Voice', subtitle: '语音控制 Claude Code',
    holdToSpeak: '按住说话', listening: '正在聆听...', release: '松开发送',
    send: '发送', placeholder: '输入消息... @Claude 调用 AI',
    connected: '已连接', disconnected: '未连接', connecting: '连接中...',
    serverUrl: '服务器地址', save: '保存', cancel: '取消',
    thinking: 'Claude 思考中', executing: '正在执行', done: '完成', error: '出错',
    langSwitch: 'EN', you: '你', claude: 'Claude',
    welcome: '👋 已就绪！',
    // 登录
    loginTitle: '欢迎使用 CC Voice', loginSubtitle: '输入昵称开始',
    nickname: '你的昵称', login: '进入', loginHint: '首次使用自动创建账号',
    // 好友
    friends: '好友', addFriend: '添加好友', inviteCode: '邀请码',
    myCode: '我的邀请码', enterCode: '输入对方邀请码', add: '添加',
    noFriends: '暂无好友\n分享你的邀请码给朋友', chat: '聊天', remove: '移除',
    // 会话
    conversations: '对话', newConv: '+ AI 对话', noConv: '暂无对话',
    search: '搜索消息...', starred: '收藏', noStarred: '暂无收藏', noResults: '无结果',
    deleteConv: '删除', pinConv: '置顶', exportConv: '导出',
    taskDone: '✅ 任务完成', speechNotSupported: '浏览器不支持语音识别',
    // 会话类型
    aiChat: 'AI 对话', dmChat: '私聊', groupChat: '群聊',
    // v2: 权限与蒸馏
    suggest: '建议', execute: '发指令', distilling: '整合中...',
    editDraft: '编辑草稿', confirmSend: '确认发送', cancelDraft: '取消',
    observerHint: '你是观察者，消息将作为建议发送', ownerBadge: '主控',
    suggestion: '💡 建议',
  },
  en: {
    title: 'CC Voice', subtitle: 'Voice Control for Claude Code',
    holdToSpeak: 'Hold to Speak', listening: 'Listening...', release: 'Release to Send',
    send: 'Send', placeholder: 'Type a message... @Claude for AI',
    connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting...',
    serverUrl: 'Server URL', save: 'Save', cancel: 'Cancel',
    thinking: 'Claude is thinking', executing: 'Executing', done: 'Done', error: 'Error',
    langSwitch: '中', you: 'You', claude: 'Claude',
    welcome: '👋 Ready!',
    loginTitle: 'Welcome to CC Voice', loginSubtitle: 'Enter nickname to start',
    nickname: 'Your nickname', login: 'Enter', loginHint: 'Auto-creates account on first use',
    friends: 'Friends', addFriend: 'Add Friend', inviteCode: 'Invite Code',
    myCode: 'My Invite Code', enterCode: "Enter friend's code", add: 'Add',
    noFriends: 'No friends yet\nShare your invite code', chat: 'Chat', remove: 'Remove',
    conversations: 'Conversations', newConv: '+ AI Chat', noConv: 'No conversations',
    search: 'Search...', starred: 'Starred', noStarred: 'No starred messages', noResults: 'No results',
    deleteConv: 'Delete', pinConv: 'Pin', exportConv: 'Export',
    taskDone: '✅ Task complete', speechNotSupported: 'Speech not supported',
    aiChat: 'AI Chat', dmChat: 'DM', groupChat: 'Group',
    // v2
    suggest: 'Suggest', execute: 'Execute', distilling: 'Distilling...',
    editDraft: 'Edit Draft', confirmSend: 'Confirm & Send', cancelDraft: 'Cancel',
    observerHint: "You're an observer — messages sent as suggestions", ownerBadge: 'Owner',
    suggestion: '💡 Suggestion',
  },
};

// ─── Relay 模式检测 ─────────────────────────────────────
// 判断方式：URL hash 带 #pair=CODE，或者从非本地服务器加载
// 直连模式：从 localhost 或局域网 IP 加载
function detectMode() {
  const hash = location.hash;
  if (hash.startsWith('#pair=')) return 'relay';
  // 从 ccvoice.app 或其他公网加载 → relay 模式
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)) return 'direct';
  return 'relay';
}

const APP_MODE = detectMode();
let relayCode = location.hash.startsWith('#pair=') ? location.hash.slice(6).toUpperCase() : localStorage.getItem('cc-voice-relay-code') || '';

// ─── 状态 ───────────────────────────────────────────────
let state = {
  lang: localStorage.getItem('cc-voice-lang') || 'zh',
  user: null, token: localStorage.getItem('cc-voice-token') || null,
  messages: [], conversations: [], friends: [],
  onlineFriends: new Set(), unreadCounts: {},
  currentConvId: null, connectionStatus: 'disconnected',
  showSettings: false, showSidebar: false, showSearch: false,
  showStarred: false, showFriends: false, showAddFriend: false,
  serverUrl: localStorage.getItem('cc-voice-server') || '',
  ws: null, recognition: null, isHolding: false, isListening: false,
  reconnectTimer: null, bridgeMode: 'unknown',
  sidebarTab: 'convs', // 'convs' | 'friends'
  relayConnected: false, // relay 模式: upstream 是否已连接
};

function t() { return LANG[state.lang]; }

// ─── API ────────────────────────────────────────────────
function headers() { return { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) }; }

// WS RPC for relay mode: send API call over WebSocket, get response back
const pendingRPC = new Map();
let rpcCounter = 0;

function wsRPC(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket not connected'));
    }
    const id = `rpc_${++rpcCounter}`;
    const timeout = setTimeout(() => {
      pendingRPC.delete(id);
      reject(new Error('RPC timeout'));
    }, 30000);

    pendingRPC.set(id, { resolve, reject, timeout });
    state.ws.send(JSON.stringify({
      type: 'rpc',
      id,
      method,
      path,
      body,
      token: state.token,
    }));
  });
}

// Unified API: uses fetch in direct mode, WS RPC in relay mode
function apiCall(method, path, body) {
  if (APP_MODE === 'relay') {
    return wsRPC(method, path, body).then(r => {
      if (r.status >= 400) {
        const err = r.body || {};
        err._status = r.status;
        throw err;
      }
      return r.body;
    });
  }
  // Direct mode: regular fetch
  const opts = { method, headers: headers() };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  return fetch(path, opts).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { data._status = r.status; throw data; }
    return data;
  });
}

const api = {
  async register(nickname, referral_code) { return apiCall('POST', '/api/register', { nickname, referral_code }); },
  async login(nickname) { return apiCall('POST', '/api/login', { nickname }); },
  async logout() { return apiCall('POST', '/api/logout'); },
  async getMe() { try { return await apiCall('GET', '/api/me'); } catch { return null; } },
  async getFriends() { return apiCall('GET', '/api/friends'); },
  async addFriend(code) { return apiCall('POST', '/api/friends/add', { invite_code: code }); },
  async removeFriend(id) { return apiCall('DELETE', `/api/friends/${id}`); },
  async getConversations() { return apiCall('GET', '/api/conversations'); },
  async createConversation(title, type, members) { return apiCall('POST', '/api/conversations', { title, type, members }); },
  async startDM(friendId) { return apiCall('POST', `/api/dm/${friendId}`); },
  async updateConversation(id, data) { return apiCall('PATCH', `/api/conversations/${id}`, data); },
  async deleteConversation(id) { return apiCall('DELETE', `/api/conversations/${id}`); },
  async getMessages(convId) { return apiCall('GET', `/api/conversations/${convId}/messages`); },
  async toggleStar(id) { return apiCall('PATCH', `/api/messages/${id}/star`); },
  async getStarred() { return apiCall('GET', '/api/messages/starred'); },
  async searchMessages(q) { return apiCall('GET', `/api/messages/search?q=${encodeURIComponent(q)}`); },
};

// ─── DOM ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {};

function initDom() {
  ['title','subtitle','connBadge','connText','langBtn','settingsBtn','settingsPanel',
   'serverUrlLabel','serverUrlInput','settingsSaveBtn','settingsCancelBtn',
   'messages','textInput','sendBtn','voiceBtn','voiceLabel',
   'sidebar','sidebarOverlay','sidebarTitle','sidebarClose','menuBtn',
   'newConvBtn','convList','searchToggleBtn','searchBox','searchInput','searchResults',
   'starredBtn','starredPanel','starredList',
   'pairScreen','pairCodeInput','pairBtn','pairError',
   'loginScreen','loginNickname','loginReferral','loginError','loginBtn',
   'logoutBtn',
   'friendsTabBtn','convsTabBtn','friendsList','addFriendBtn','addFriendPanel',
   'addFriendInput','addFriendSubmit','myInviteCode',
   'mainApp'
  ].forEach(id => els[id] = $(id));
}

// ─── 渲染 ───────────────────────────────────────────────
function render() {
  const l = t();

  // 登录 / 主界面切换
  if (!state.user) {
    els.loginScreen.style.display = 'flex';
    els.mainApp.style.display = 'none';
    els.loginNickname.placeholder = l.nickname;
    els.loginBtn.textContent = l.login;
    return;
  }
  els.loginScreen.style.display = 'none';
  els.mainApp.style.display = 'flex';

  // Header
  els.title.textContent = l.title;
  const conv = state.conversations.find(c => c.id === state.currentConvId);
  els.subtitle.textContent = conv ? conv.title : l.subtitle;
  els.langBtn.textContent = l.langSwitch;
  els.textInput.placeholder = conv?.type === 'ai' ? l.placeholder.replace('@Claude 调用 AI', '').replace('@Claude for AI', '') : l.placeholder;
  els.sendBtn.textContent = l.send;

  els.connBadge.className = `conn-badge ${state.connectionStatus}`;
  els.connText.textContent = l[state.connectionStatus];

  // v2: 按角色调整发送按钮文字
  const isOwner = state.user?.role === 'owner';
  els.sendBtn.textContent = isOwner ? l.send : l.suggest;
  els.sendBtn.classList.toggle('active', els.textInput.value.trim().length > 0);

  // v2: Observer 提示条
  let hint = document.getElementById('roleHint');
  if (!isOwner) {
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'roleHint';
      hint.className = 'role-hint observer';
      document.querySelector('.input-bar')?.parentElement?.insertBefore(hint, document.querySelector('.input-bar'));
    }
    hint.textContent = l.observerHint;
    hint.style.display = 'block';
  } else if (hint) {
    hint.style.display = 'none';
  }

  // v2: Owner 的"发指令"按钮（蒸馏入口）
  let execBtn = document.getElementById('executeBtn');
  if (isOwner) {
    if (!execBtn) {
      execBtn = document.createElement('button');
      execBtn.id = 'executeBtn';
      execBtn.className = 'execute-btn';
      execBtn.onclick = distillAndExecute;
      document.querySelector('.input-bar')?.appendChild(execBtn);
    }
    execBtn.textContent = l.execute;
    execBtn.style.display = 'inline-block';
  } else if (execBtn) {
    execBtn.style.display = 'none';
  }
  els.settingsPanel.style.display = state.showSettings ? 'block' : 'none';
  els.serverUrlLabel.textContent = l.serverUrl;
  els.settingsSaveBtn.textContent = l.save;
  els.settingsCancelBtn.textContent = l.cancel;

  els.voiceBtn.classList.toggle('holding', state.isHolding);
  els.voiceLabel.textContent = state.isListening ? l.listening : state.isHolding ? l.release : l.holdToSpeak;

  // Sidebar
  els.sidebar.classList.toggle('open', state.showSidebar);
  els.sidebarOverlay.classList.toggle('visible', state.showSidebar);
  els.sidebarTitle.textContent = state.sidebarTab === 'friends' ? l.friends : l.conversations;
  els.newConvBtn.textContent = l.newConv;
  els.searchInput.placeholder = l.search;
  els.searchBox.style.display = state.showSearch ? 'block' : 'none';
  els.starredPanel.style.display = state.showStarred ? 'block' : 'none';

  // Tab highlight
  els.convsTabBtn.classList.toggle('tab-active', state.sidebarTab === 'convs');
  els.friendsTabBtn.classList.toggle('tab-active', state.sidebarTab === 'friends');

  // Show/hide lists based on tab
  els.convList.style.display = state.sidebarTab === 'convs' ? 'block' : 'none';
  els.friendsList.style.display = state.sidebarTab === 'friends' ? 'block' : 'none';
  els.newConvBtn.style.display = state.sidebarTab === 'convs' ? 'block' : 'none';
  els.addFriendBtn.style.display = state.sidebarTab === 'friends' ? 'block' : 'none';
  els.addFriendPanel.style.display = state.showAddFriend ? 'block' : 'none';

  // My invite code
  els.myInviteCode.textContent = state.user ? `${l.myCode}: ${state.user.invite_code}` : '';
  els.myInviteCode.style.display = state.sidebarTab === 'friends' ? 'block' : 'none';

  renderConvList();
  renderFriendsList();
  renderMessages();
}

function renderConvList() {
  const l = t();
  if (!state.conversations.length) { els.convList.innerHTML = `<div class="conv-empty">${l.noConv}</div>`; return; }
  els.convList.innerHTML = state.conversations.map(c => {
    const active = c.id === state.currentConvId ? ' active' : '';
    const pinned = c.pinned ? ' pinned' : '';
    const time = new Date(c.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const icon = c.type === 'dm' ? '💬' : c.type === 'group' ? '👥' : '🤖';
    const unread = state.unreadCounts[c.id] || 0;
    return `<div class="conv-item${active}${pinned}" data-id="${c.id}">
      <div class="conv-item-main" data-id="${c.id}">
        <span class="conv-icon">${icon}</span>
        ${c.pinned ? '<span class="conv-pin">📌</span>' : ''}
        <span class="conv-title-text">${escapeHTML(c.title)}</span>
        <span class="conv-meta">${c.msg_count || 0} · ${time}</span>
      </div>
      ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
      <div class="conv-item-actions">
        <button class="conv-action-btn" data-action="pin" data-id="${c.id}">📌</button>
        <button class="conv-action-btn" data-action="export" data-id="${c.id}">📤</button>
        <button class="conv-action-btn danger" data-action="delete" data-id="${c.id}">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function renderFriendsList() {
  const l = t();
  if (!state.friends.length) { els.friendsList.innerHTML = `<div class="conv-empty">${l.noFriends}</div>`; return; }
  els.friendsList.innerHTML = state.friends.map(f => {
    const online = state.onlineFriends.has(f.id);
    return `<div class="friend-item" data-id="${f.id}">
      <div class="friend-info">
        <span class="friend-avatar${online ? ' online' : ''}">${f.nickname.charAt(0).toUpperCase()}</span>
        <div>
          <div class="friend-name">${escapeHTML(f.nickname)}${online ? '<span class="online-dot"></span>' : ''}</div>
          <div class="friend-code">${f.invite_code}</div>
        </div>
      </div>
      <div class="friend-actions">
        <button class="friend-chat-btn" data-id="${f.id}">${l.chat}</button>
        <button class="friend-remove-btn" data-id="${f.id}">✕</button>
      </div>
    </div>`;
  }).join('');
}

function renderMessages() {
  const container = els.messages;
  const msgEls = container.querySelectorAll('.msg');
  if (msgEls.length !== state.messages.length) {
    container.innerHTML = state.messages.map((m, i) => msgHTML(m, i)).join('');
    scrollToBottom(); return;
  }
  if (state.messages.length > 0) {
    const last = state.messages[state.messages.length - 1];
    const lastEl = msgEls[state.messages.length - 1];
    if (lastEl) { const b = lastEl.querySelector('.msg-bubble'); if (b) b.innerHTML = msgBubbleInner(last); }
    scrollToBottom();
  }
}

function msgHTML(msg, i) {
  const l = t();
  const isUser = msg.role === 'user';
  const isSuggestion = msg.role === 'suggestion';
  const isSelf = msg.sender_id === state.user?.id;
  const roleClass = msg.role === 'assistant' ? 'assistant' : isSuggestion ? 'suggestion' : (isSelf ? 'user' : 'other-user');
  const name = msg.role === 'assistant' ? l.claude : isSuggestion ? `${msg.sender_name || l.you} ${l.suggestion}` : (msg.sender_name || l.you);
  const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const starClass = msg.starred ? ' starred' : '';
  return `<div class="msg ${roleClass}" data-index="${i}" data-msg-id="${msg.id || ''}">
    <div class="msg-meta">${name}${time ? `<span class="msg-time">${time}</span>` : ''}${msg.id ? `<button class="star-btn${starClass}" data-msg-id="${msg.id}">⭐</button>` : ''}</div>
    <div class="msg-bubble">${msgBubbleInner(msg)}</div>
  </div>`;
}

function msgBubbleInner(msg) {
  const l = t();
  let h = '';
  if (msg.status && msg.status !== 'done') h += `<div class="msg-status"><span class="status-dot ${msg.status}"></span>${l[msg.status] || msg.status}</div>`;
  h += escapeHTML(msg.content || '');
  return h;
}

function escapeHTML(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function scrollToBottom() { requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; }); }

// ─── 操作 ───────────────────────────────────────────────
async function login(nickname, referralCode) {
  if (!nickname.trim()) return;
  showLoginError('');

  // 先尝试登录已有账号
  try {
    const data = await api.login(nickname.trim());
    state.token = data.token;
    state.user = data;
    localStorage.setItem('cc-voice-token', data.token);
    // Relay 模式下 WS 已连接，发送 auth；Direct 模式下新建 WS
    if (APP_MODE === 'relay' && state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    } else {
      connectWS();
    }
    await loadData();
    render();
    return;
  } catch (e) {
    // 用户不存在，继续注册
    if (e.error !== 'User not found') { showLoginError(e.error || '登录失败'); return; }
  }

  // 注册新用户
  try {
    const data = await api.register(nickname.trim(), referralCode?.trim() || undefined);
    state.token = data.token;
    state.user = data;
    localStorage.setItem('cc-voice-token', data.token);
    if (APP_MODE === 'relay' && state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    } else {
      connectWS();
    }
    await loadData();
    render();
  } catch (e) {
    if (e.need_referral) showLoginError('需要邀请码才能注册');
    else if (e.error === 'Nickname already taken') showLoginError('昵称已被占用');
    else showLoginError(e.error || '注册失败');
  }
}

function showLoginError(msg) {
  if (els.loginError) { els.loginError.textContent = msg; els.loginError.style.display = msg ? 'block' : 'none'; }
}

async function logout() {
  try { await api.logout(); } catch {}
  state.user = null; state.token = null;
  localStorage.removeItem('cc-voice-token');
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.conversations = []; state.friends = []; state.messages = []; state.currentConvId = null;
  render();
}

async function restoreSession() {
  if (!state.token) return false;
  const me = await api.getMe();
  if (!me) { state.token = null; localStorage.removeItem('cc-voice-token'); return false; }
  state.user = me;
  return true;
}

async function loadData() {
  try {
    state.conversations = await api.getConversations();
    state.friends = await api.getFriends();
    if (state.conversations.length > 0 && !state.currentConvId) {
      state.currentConvId = state.conversations[0].id;
      state.messages = await api.getMessages(state.currentConvId);
    }
  } catch (e) { console.log('[loadData]', e); }
}

async function switchConv(convId) {
  state.currentConvId = convId;
  delete state.unreadCounts[convId]; // 清除未读
  state.messages = await api.getMessages(convId);
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'switch_conv', convId }));
  render();
}

async function createAIConv() {
  const conv = await api.createConversation(t().aiChat, 'ai', []);
  state.conversations.unshift(conv);
  await switchConv(conv.id);
  state.showSidebar = false;
  render();
}

async function startDM(friendId) {
  const conv = await api.startDM(friendId);
  // 如果不在列表中则添加
  if (!state.conversations.find(c => c.id === conv.id)) state.conversations.unshift(conv);
  await switchConv(conv.id);
  state.showSidebar = false;
  render();
}

async function deleteConv(id) {
  await api.deleteConversation(id);
  state.conversations = state.conversations.filter(c => c.id !== id);
  if (state.currentConvId === id) {
    state.currentConvId = state.conversations[0]?.id || null;
    state.messages = state.currentConvId ? await api.getMessages(state.currentConvId) : [];
  }
  render();
}

function addLocalMsg(role, content, status, id, senderId, senderName) {
  state.messages.push({ id, role, content, status: status || (role === 'assistant' ? 'done' : undefined), created_at: Date.now(), sender_id: senderId, sender_name: senderName });
  render();
}

function updateLastAssistant(updates) {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].role === 'assistant') { Object.assign(state.messages[i], updates); render(); return; }
  }
}

// ─── 搜索 & 收藏 ────────────────────────────────────────
let searchTimer = null;
async function doSearch(q) {
  if (!q.trim()) { els.searchResults.innerHTML = ''; return; }
  const results = await api.searchMessages(q);
  const l = t();
  els.searchResults.innerHTML = results.length === 0 ? `<div class="search-empty">${l.noResults}</div>` :
    results.map(r => `<div class="search-result-item" data-conv-id="${r.conv_id}">
      <div class="search-result-title">${escapeHTML(r.conv_title)}</div>
      <div class="search-result-snippet">${escapeHTML((r.content||'').substring(0, 60))}</div>
    </div>`).join('');
}

async function loadStarred() {
  const starred = await api.getStarred();
  const l = t();
  els.starredList.innerHTML = starred.length === 0 ? `<div class="search-empty">${l.noStarred}</div>` :
    starred.map(m => `<div class="search-result-item" data-conv-id="${m.conv_id}">
      <div class="search-result-title">⭐ ${escapeHTML(m.conv_title)}</div>
      <div class="search-result-snippet">${escapeHTML((m.content||'').substring(0, 80))}</div>
    </div>`).join('');
}

// ─── 通知 ───────────────────────────────────────────────
function requestNotif() { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }
function showNotif(title, body) { if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body, icon: '/icons/icon-192.png', tag: 'cc-voice' }); }

// ─── WebSocket ──────────────────────────────────────────
function getWsUrl() {
  if (APP_MODE === 'relay') {
    // Relay 模式：连接到 relay server
    const relayHost = location.host; // ccvoice.app
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${relayHost}/relay?code=${relayCode}&role=downstream`;
  }
  if (state.serverUrl) return state.serverUrl.replace(/^http/, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

function connectWS() {
  if (state.ws?.readyState <= 1) return;
  state.connectionStatus = 'connecting'; render();
  try { state.ws = new WebSocket(getWsUrl()); } catch { state.connectionStatus = 'disconnected'; render(); scheduleReconnect(); return; }

  state.ws.onopen = () => {
    state.connectionStatus = 'connected';
    state.relayConnected = true;
    clearTimeout(state.reconnectTimer);
    // 认证
    if (state.token) state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    if (state.currentConvId) state.ws.send(JSON.stringify({ type: 'switch_conv', convId: state.currentConvId }));
    render();
  };
  state.ws.onclose = () => { state.connectionStatus = 'disconnected'; state.relayConnected = false; render(); scheduleReconnect(); };
  state.ws.onerror = () => {};
  state.ws.onmessage = wsMessageHandler;
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    if (APP_MODE === 'relay') {
      // Relay 模式：用保存的配对码自动重连
      connectWSAsync().then(() => {
        if (state.token && state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
        }
      });
    } else {
      connectWS();
    }
  }, 3000);
}

function handleWS(data) {
  switch (data.type) {
    case 'welcome': state.bridgeMode = data.bridge; break;
    case 'auth_ok':
      if (data.onlineFriends) state.onlineFriends = new Set(data.onlineFriends);
      break;
    case 'auth_fail': state.user = null; state.token = null; localStorage.removeItem('cc-voice-token'); render(); break;

    case 'presence':
      if (data.online) state.onlineFriends.add(data.userId);
      else state.onlineFriends.delete(data.userId);
      render();
      break;

    case 'conv_created':
      state.currentConvId = data.conv.id;
      loadData().then(render);
      break;

    case 'msg_saved':
      if (data.role === 'user') {
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].role === 'user' && !state.messages[i].id) { state.messages[i].id = data.msgId; break; }
        }
      }
      break;

    case 'new_message':
      // 来自其他用户的实时消息
      if (data.convId === state.currentConvId) {
        state.messages.push(data.message);
        render();
      } else {
        // 未读计数
        state.unreadCounts[data.convId] = (state.unreadCounts[data.convId] || 0) + 1;
        render();
      }
      showNotif(data.message.sender_name || 'New message', (data.message.content || '').substring(0, 50));
      break;

    case 'status':
      if (data.status === 'thinking') addLocalMsg('assistant', '', 'thinking', data.id);
      else updateLastAssistant({ status: data.status });
      if (data.status === 'done') showNotif(t().taskDone, '');
      break;

    case 'chunk':
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].role === 'assistant') { state.messages[i].content += data.content; state.messages[i].id = data.id; render(); break; }
      }
      break;

    case 'error': addLocalMsg('assistant', `❌ ${data.content}`, 'error'); break;
    case 'pong': break;
  }
}

function sendMessage(text) {
  if (!text?.trim()) return;
  text = text.trim();
  const isOwner = state.user?.role === 'owner';

  if (!isOwner) {
    // Observer: 所有消息作为建议发送
    addLocalMsg('suggestion', text, 'pending', null, state.user?.id, state.user?.nickname);
    els.textInput.value = ''; render();
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'suggestion', text }));
    else addLocalMsg('system', '❌ 未连接', 'error');
    return;
  }

  // Owner: 正常发消息
  addLocalMsg('user', text, 'done', null, state.user?.id, state.user?.nickname);
  els.textInput.value = ''; render();
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'message', text }));
  else addLocalMsg('assistant', '❌ 未连接', 'error');
}

// v2: 上下文蒸馏 — Owner 点"发指令"时触发
async function distillAndExecute() {
  if (state.user?.role !== 'owner') return;
  if (!state.currentConvId) return;
  const l = t();

  // 显示蒸馏中状态
  showDistillPanel(l.distilling, true);

  try {
    const res = await fetch('/api/distill', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ convId: state.currentConvId, limit: 30 }),
    });
    const data = await res.json();
    if (data.draft) {
      showDistillPanel(data.draft, false);
    } else {
      hideDistillPanel();
    }
  } catch (e) {
    hideDistillPanel();
    console.error('[distill]', e);
  }
}

function showDistillPanel(content, loading) {
  let panel = document.getElementById('distillPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'distillPanel';
    panel.className = 'distill-panel';
    document.querySelector('.input-bar')?.parentElement?.insertBefore(panel, document.querySelector('.input-bar'));
  }
  const l = t();
  if (loading) {
    panel.innerHTML = `<div class="distill-loading">${content}</div>`;
  } else {
    panel.innerHTML = `
      <textarea class="distill-textarea" id="distillText">${escapeHTML(content)}</textarea>
      <div class="distill-actions">
        <button class="distill-btn cancel" id="distillCancel">${l.cancelDraft}</button>
        <button class="distill-btn confirm" id="distillConfirm">${l.confirmSend}</button>
      </div>`;
    document.getElementById('distillCancel').onclick = hideDistillPanel;
    document.getElementById('distillConfirm').onclick = () => {
      const text = document.getElementById('distillText').value;
      hideDistillPanel();
      if (text.trim()) {
        addLocalMsg('user', text, 'done', null, state.user?.id, state.user?.nickname);
        if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'message', text }));
      }
    };
  }
  panel.style.display = 'block';
}

function hideDistillPanel() {
  const panel = document.getElementById('distillPanel');
  if (panel) panel.style.display = 'none';
}

// ─── 语音 ───────────────────────────────────────────────
function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert(t().speechNotSupported); return; }
  const r = new SR(); r.continuous = true; r.interimResults = true; r.lang = state.lang === 'zh' ? 'zh-CN' : 'en-US';
  let final = '';
  r.onresult = e => { final = ''; for (let i = 0; i < e.results.length; i++) if (e.results[i].isFinal) final += e.results[i][0].transcript; };
  r.onerror = () => { state.isListening = false; render(); };
  r.onend = () => { state.isListening = false; if (final.trim()) sendMessage(final); render(); };
  r.start(); state.recognition = r; state.isListening = true; render();
}
function stopListening() { if (state.recognition) { state.recognition.stop(); state.recognition = null; } state.isListening = false; }

// ─── 事件 ───────────────────────────────────────────────
function bindEvents() {
  // 登录 / 注册
  const doLogin = () => login(els.loginNickname.value, els.loginReferral.value);
  els.loginBtn.addEventListener('click', doLogin);
  els.loginNickname.addEventListener('keydown', e => { if (e.key === 'Enter') { els.loginReferral.focus(); } });
  els.loginReferral.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // 登出
  els.logoutBtn.addEventListener('click', logout);

  // 侧边栏
  els.menuBtn.addEventListener('click', () => { state.showSidebar = true; loadData().then(render); });
  els.sidebarClose.addEventListener('click', () => { state.showSidebar = false; render(); });
  els.sidebarOverlay.addEventListener('click', () => { state.showSidebar = false; render(); });

  // 侧边栏 tab
  els.convsTabBtn.addEventListener('click', () => { state.sidebarTab = 'convs'; render(); });
  els.friendsTabBtn.addEventListener('click', () => { state.sidebarTab = 'friends'; state.showAddFriend = false; api.getFriends().then(f => { state.friends = f; render(); }); });

  // 新建 AI 会话
  els.newConvBtn.addEventListener('click', createAIConv);

  // 会话列表
  els.convList.addEventListener('click', async e => {
    const btn = e.target.closest('.conv-action-btn');
    if (btn) {
      const { id, action } = btn.dataset;
      if (action === 'delete') await deleteConv(id);
      else if (action === 'pin') { await api.updateConversation(id, { pinned: true }); await loadData(); render(); }
      else if (action === 'export') window.open(`/api/conversations/${id}/export?token=${state.token}`, '_blank');
      return;
    }
    const item = e.target.closest('.conv-item-main');
    if (item) { await switchConv(item.dataset.id); state.showSidebar = false; render(); }
  });

  // 好友列表
  els.friendsList.addEventListener('click', async e => {
    const chatBtn = e.target.closest('.friend-chat-btn');
    if (chatBtn) { await startDM(chatBtn.dataset.id); return; }
    const removeBtn = e.target.closest('.friend-remove-btn');
    if (removeBtn) { await api.removeFriend(removeBtn.dataset.id); state.friends = await api.getFriends(); render(); }
  });

  // 添加好友
  els.addFriendBtn.addEventListener('click', () => { state.showAddFriend = !state.showAddFriend; render(); });
  els.addFriendSubmit.addEventListener('click', async () => {
    const code = els.addFriendInput.value.trim();
    if (!code) return;
    try {
      await api.addFriend(code);
      state.friends = await api.getFriends();
      els.addFriendInput.value = '';
      state.showAddFriend = false;
      render();
    } catch (e) { alert('添加失败'); }
  });

  // 搜索
  els.searchToggleBtn.addEventListener('click', () => { state.showSearch = !state.showSearch; state.showStarred = false; render(); if (state.showSearch) els.searchInput.focus(); });
  els.searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(els.searchInput.value), 300); });
  els.searchResults.addEventListener('click', async e => { const item = e.target.closest('.search-result-item'); if (item) { await switchConv(item.dataset.convId); state.showSidebar = false; state.showSearch = false; render(); } });

  // 收藏
  els.starredBtn.addEventListener('click', async () => { state.showStarred = !state.showStarred; state.showSearch = false; if (state.showStarred) await loadStarred(); render(); });
  els.starredList.addEventListener('click', async e => { const item = e.target.closest('.search-result-item'); if (item) { await switchConv(item.dataset.convId); state.showSidebar = false; state.showStarred = false; render(); } });
  els.messages.addEventListener('click', async e => { const btn = e.target.closest('.star-btn'); if (btn?.dataset.msgId) { await api.toggleStar(btn.dataset.msgId); state.messages = await api.getMessages(state.currentConvId); render(); } });

  // 语言 & 设置
  els.langBtn.addEventListener('click', () => { state.lang = state.lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('cc-voice-lang', state.lang); render(); });
  els.settingsBtn.addEventListener('click', () => { state.showSettings = !state.showSettings; els.serverUrlInput.value = state.serverUrl; render(); });
  els.settingsSaveBtn.addEventListener('click', () => { state.serverUrl = els.serverUrlInput.value; localStorage.setItem('cc-voice-server', state.serverUrl); state.showSettings = false; if (state.ws) state.ws.close(); connectWS(); render(); });
  els.settingsCancelBtn.addEventListener('click', () => { state.showSettings = false; render(); });

  // 输入
  els.textInput.addEventListener('input', () => { els.sendBtn.classList.toggle('active', els.textInput.value.trim().length > 0); });
  els.textInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(els.textInput.value); } });
  els.sendBtn.addEventListener('click', () => sendMessage(els.textInput.value));

  // 语音
  let ht = null;
  els.voiceBtn.addEventListener('pointerdown', e => { e.preventDefault(); state.isHolding = true; render(); ht = setTimeout(startListening, 150); });
  const up = () => { state.isHolding = false; clearTimeout(ht); stopListening(); render(); };
  els.voiceBtn.addEventListener('pointerup', up);
  els.voiceBtn.addEventListener('pointerleave', up);
  els.voiceBtn.addEventListener('pointercancel', up);

  // 心跳
  setInterval(() => { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'ping' })); }, 25000);

  // 手势
  let sx = 0;
  document.addEventListener('touchstart', e => { sx = e.touches[0].clientX; });
  document.addEventListener('touchend', e => { const dx = e.changedTouches[0].clientX - sx; if (dx > 80 && sx < 30 && !state.showSidebar) { state.showSidebar = true; loadData().then(render); } else if (dx < -80 && state.showSidebar) { state.showSidebar = false; render(); } });
}

// ─── 配对 (relay mode) ─────────────────────────────────
function initPairing() {
  const pairScreen = $('pairScreen');
  const pairInput = $('pairCodeInput');
  const pairBtn = $('pairBtn');
  const pairError = $('pairError');

  // 如果 URL hash 带了配对码，自动连接
  if (relayCode) {
    pairInput.value = relayCode;
    doPair();
    return;
  }

  // 隐藏登录界面，显示配对界面
  $('loginScreen').style.display = 'none';
  $('mainApp').style.display = 'none';
  pairScreen.style.display = 'flex';

  pairBtn.addEventListener('click', doPair);
  pairInput.addEventListener('keydown', e => { if (e.key === 'Enter') doPair(); });

  async function doPair() {
    const code = pairInput.value.trim().toUpperCase();
    if (code.length < 4) {
      pairError.textContent = '请输入配对码';
      pairError.style.display = 'block';
      return;
    }

    pairBtn.textContent = '连接中...';
    pairBtn.disabled = true;
    pairError.style.display = 'none';

    try {
      // 检查房间是否有 upstream
      const res = await fetch(`/api/relay/status?code=${code}`);
      const status = await res.json();

      if (!status.hasUpstream) {
        pairError.textContent = '配对码无效或电脑未启动 — 请检查终端';
        pairError.style.display = 'block';
        pairBtn.textContent = '连接';
        pairBtn.disabled = false;
        return;
      }

      // 配对成功，保存 code 并进入主流程
      relayCode = code;
      localStorage.setItem('cc-voice-relay-code', code);
      location.hash = `pair=${code}`;
      pairScreen.style.display = 'none';

      // 连接 WS 并启动主流程
      await startApp();
    } catch (e) {
      pairError.textContent = '连接失败: ' + (e.message || '网络错误');
      pairError.style.display = 'block';
      pairBtn.textContent = '连接';
      pairBtn.disabled = false;
    }
  }
}

async function startApp() {
  if (APP_MODE === 'relay') {
    // Relay 模式：先连 WS，等连上后再恢复会话
    await connectWSAsync();
    const restored = await restoreSession();
    if (restored) { await loadData(); }
    render();
  } else {
    // Direct 模式：先恢复会话（HTTP），再连 WS
    const restored = await restoreSession();
    if (restored) { await loadData(); connectWS(); }
    render();
  }
}

// 返回 Promise，WS 连上后 resolve
function connectWSAsync() {
  return new Promise((resolve) => {
    if (state.ws?.readyState === WebSocket.OPEN) { resolve(); return; }
    state.connectionStatus = 'connecting'; render();
    try { state.ws = new WebSocket(getWsUrl()); } catch { state.connectionStatus = 'disconnected'; render(); resolve(); return; }

    state.ws.onopen = () => {
      state.connectionStatus = 'connected';
      state.relayConnected = true;
      clearTimeout(state.reconnectTimer);
      if (state.token) state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
      if (state.currentConvId) state.ws.send(JSON.stringify({ type: 'switch_conv', convId: state.currentConvId }));
      render();
      resolve();
    };
    state.ws.onclose = () => { state.connectionStatus = 'disconnected'; state.relayConnected = false; render(); scheduleReconnect(); };
    state.ws.onerror = () => {};
    state.ws.onmessage = wsMessageHandler;
  });
}

function wsMessageHandler(e) {
  try {
    const data = JSON.parse(e.data);
    if (data.type === 'rpc_response' && data.id) {
      const pending = pendingRPC.get(data.id);
      if (pending) { pendingRPC.delete(data.id); clearTimeout(pending.timeout); pending.resolve(data); }
      return;
    }
    if (data.type?.startsWith('relay:')) {
      if (data.type === 'relay:peer_disconnected' && data.role === 'upstream') { state.connectionStatus = 'disconnected'; render(); }
      return;
    }
    handleWS(data);
  } catch {}
}

// ─── 启动 ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initDom();
  bindEvents();
  requestNotif();

  if (APP_MODE === 'relay') {
    // Relay 模式：需要先配对
    if (relayCode) {
      // 已有配对码（从 hash 或 localStorage），直接尝试连接
      $('pairScreen').style.display = 'none';
      await startApp();
    } else {
      initPairing();
    }
  } else {
    // Direct 模式：直接启动
    await startApp();
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
