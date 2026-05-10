/**
 * ccvoice v3 — Web 前端 (E2E 加密 + 终端渲染)
 *
 * 配对 → ECDH 密钥交换 → AES-256-GCM 加密通信 → 终端事件流渲染
 */

const $ = (id) => document.getElementById(id);

// ─── E2E 加密 (Web Crypto API) ─────────────────────────
const E2E = {
  async generateKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'X25519' },
      true, // extractable
      ['deriveBits']
    );
    const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    return { keyPair, publicKeyRaw: new Uint8Array(pubRaw) };
  },

  async deriveSharedSecret(privateKey, peerPublicKeyRaw) {
    // X25519 spec: public keys MUST be imported with empty usages.
    // Only the private key gets the 'deriveBits' / 'deriveKey' usage.
    // Chrome started enforcing this strictly — passing ['deriveBits'] here
    // throws "Cannot create a key using the specified key usages." (M120+).
    const peerPubKey = await crypto.subtle.importKey(
      'raw', peerPublicKeyRaw,
      { name: 'X25519' },
      false, []
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: peerPubKey },
      privateKey,
      256
    );
    return new Uint8Array(bits);
  },

  async deriveAESKey(sharedSecret) {
    const hash = await crypto.subtle.digest('SHA-256', sharedSecret);
    return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  },

  async encrypt(plaintext, aesKey) {
    const encoder = new TextEncoder();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      encoder.encode(plaintext)
    );
    return {
      nonce: btoa(String.fromCharCode(...nonce)),
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    };
  },

  async decrypt(encrypted, aesKey) {
    const nonce = Uint8Array.from(atob(encrypted.nonce), c => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  },
};

// ─── 状态 ──────────────────────────────────────────────
const state = {
  ws: null,
  relayCode: null,
  relayUrl: null,
  peerId: crypto.randomUUID().slice(0, 8),
  role: 'owner',        // 由 CLI 在 ack 中权威分配
  nickname: localStorage.getItem('ccvoice-nickname') || '',
  keyPair: null,
  aesKey: null,          // 与 CLI 的共享密钥
  groupKey: null,        // 多人场景下的群组密钥
  inviteCode: null,      // owner 配对成功后 CLI 发来的邀请码
  connected: false,
  encrypted: false,
  claudeStatus: 'idle',  // idle | thinking | executing | done | error
  events: [],            // 终端事件历史
  participants: [],
  reconnectTimer: null,
  reconnectRetry: 0,
};

// ─── 配对 ──────────────────────────────────────────────
function initPairScreen() {
  // 回填昵称
  const savedNick = localStorage.getItem('ccvoice-nickname');
  if (savedNick && $('nicknameInput')) $('nicknameInput').value = savedNick;

  // URL hash 自动填配对码
  const hash = location.hash;
  if (hash.startsWith('#pair=')) {
    const code = hash.slice(6).toUpperCase();
    $('pairInput').value = code;
    // 如果昵称已存在,自动连;否则让用户先填昵称
    if (savedNick) {
      setTimeout(() => startPairing(code), 300);
    }
  }

  const saved = localStorage.getItem('ccvoice-code');
  if (saved && !$('pairInput').value) {
    $('pairInput').value = saved;
  }

  $('pairBtn').onclick = () => startPairing($('pairInput').value.trim().toUpperCase());
  $('pairInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('pairBtn').click();
  });
  // 配对码自动大写;昵称不强制
  $('pairInput').addEventListener('input', () => {
    $('pairInput').value = $('pairInput').value.toUpperCase();
  });
  if ($('nicknameInput')) {
    $('nicknameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('pairBtn').click();
    });
  }
}

async function startPairing(code) {
  if (!code || code.length < 4) {
    $('pairError').textContent = '请输入有效配对码或邀请码';
    return;
  }
  const nicknameInput = $('nicknameInput');
  const nickname = (nicknameInput?.value || '').trim();
  if (!nickname) {
    $('pairError').textContent = '请输入昵称';
    nicknameInput?.focus();
    return;
  }
  state.nickname = nickname;
  localStorage.setItem('ccvoice-nickname', nickname);

  $('pairBtn').disabled = true;
  $('pairBtn').textContent = '连接中...';
  $('pairError').textContent = '';

  const relayUrl = detectRelay();
  state.relayUrl = relayUrl;
  state.relayCode = code;

  try {
    // 检查房间是否存在
    const res = await fetch(`${relayUrl}/api/relay/status?code=${code}`);
    if (!res.ok) throw new Error('配对码无效或已过期');
    const data = await res.json();
    if (!data.hasUpstream) throw new Error('电脑端未连接，请先在终端运行 ccvoice');

    // 保存配对码
    localStorage.setItem('ccvoice-code', code);

    // 生成密钥对
    state.keyPair = await E2E.generateKeyPair();

    // 连接 WebSocket
    await connectRelay(code);

  } catch (e) {
    $('pairError').textContent = e.message;
    $('pairBtn').disabled = false;
    $('pairBtn').textContent = '连接';
  }
}

function detectRelay() {
  // 如果在 ccvoice.app 上访问，relay 就是自己
  if (location.hostname === 'ccvoice.app' || location.hostname.endsWith('.ccvoice.app')) {
    return location.origin;
  }
  return 'https://ccvoice.app';
}

// ─── Relay WebSocket ───────────────────────────────────
async function connectRelay(code) {
  return new Promise((resolve, reject) => {
    const wsUrl = state.relayUrl.replace(/^http/, 'ws');
    const url = `${wsUrl}/relay?code=${code}&role=downstream&peerId=${state.peerId}`;

    state.ws = new WebSocket(url);

    state.ws.onopen = () => {
      state.connected = true;
      state.reconnectRetry = 0;
      console.log('[relay] connected');

      // 发送配对握手（包含公钥 + 昵称）
      const pubKeyBase64 = btoa(String.fromCharCode(...state.keyPair.publicKeyRaw));
      state.ws.send(JSON.stringify({
        type: 'pair_handshake',
        publicKey: pubKeyBase64,
        peerId: state.peerId,
        role: state.role,
        nickname: state.nickname,
      }));

      resolve();
    };

    state.ws.onmessage = (e) => handleRelayMessage(e.data);

    state.ws.onclose = () => {
      state.connected = false;
      updateStatusUI();
      scheduleReconnect();
    };

    state.ws.onerror = () => {
      reject(new Error('WebSocket 连接失败'));
    };
  });
}

async function handleRelayMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  // Relay 控制消息
  if (msg.type?.startsWith('relay:')) {
    // Phase 4 静音 — 参与者列表已在 header 渲染,peer 连接事件不再写入终端流。
    if (msg.type === 'relay:upstream_gone') {
      addSystemEvent('⚠️ 电脑端已断开，等待重连...');
      state.claudeStatus = 'idle';
      updateStatusUI();
    }
    return;
  }

  // 配对握手响应：收到 CLI 的公钥
  if (msg.type === 'pair_handshake_ack') {
    try {
      const peerPubKeyRaw = Uint8Array.from(atob(msg.publicKey), c => c.charCodeAt(0));
      const sharedSecret = await E2E.deriveSharedSecret(state.keyPair.keyPair.privateKey, peerPubKeyRaw);
      state.aesKey = await E2E.deriveAESKey(sharedSecret);
      state.encrypted = true;

      // CLI 权威分配的角色 + 邀请码 (owner 配对成功后自动生成)
      if (msg.role) state.role = msg.role;
      if (msg.inviteCode) state.inviteCode = msg.inviteCode;

      // 切换到主界面
      $('pairScreen').style.display = 'none';
      $('mainScreen').style.display = 'flex';
      updateStatusUI();
      addSystemEvent('🔐 端到端加密已建立');

      if (state.role === 'observer') {
        const input = $('textInput');
        if (input) input.placeholder = '输入建议… (Owner 审批后由 Claude 执行)';
        addSystemEvent('👁 你是 Observer,输入将作为建议发给 Owner 审批');
      } else {
        addSystemEvent('👑 你是 Owner,输入直接交给 Claude 执行');
        if (state.inviteCode) {
          addSystemEvent(`🎟️ 邀请码: ${state.inviteCode} (分享给其他设备加入)`);
        }
      }

      $('textInput').focus();
    } catch (e) {
      console.error('Handshake failed:', e);
      $('pairError').textContent = '加密握手失败: ' + e.message;
    }
    return;
  }

  // 群组密钥
  if (msg.type === 'group_key' && msg.peerId === state.peerId) {
    try {
      const decrypted = await E2E.decrypt(msg.payload, state.aesKey);
      const gkBytes = Uint8Array.from(atob(decrypted), c => c.charCodeAt(0));
      state.groupKey = await crypto.subtle.importKey('raw', gkBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      // Silent on success.
    } catch (e) {
      console.error('Group key error:', e);
    }
    return;
  }

  // 加密消息：解密后处理
  if (msg.type === 'encrypted' && msg.payload) {
    try {
      const key = state.groupKey || state.aesKey;
      if (!key) { console.warn('No decryption key'); return; }
      const decrypted = await E2E.decrypt(msg.payload, key);
      const innerMsg = JSON.parse(decrypted);
      handleDecryptedMessage(innerMsg);
    } catch (e) {
      console.error('Decrypt error:', e);
    }
    return;
  }
}

function handleDecryptedMessage(msg) {
  switch (msg.type) {
    case 'terminal_event':
      renderTerminalEvent(msg.event);
      break;
    case 'terminal_raw':
      addRawEvent(msg.data);
      break;
    case 'status':
      state.claudeStatus = msg.status;
      updateStatusUI();
      if (msg.status === 'done') scrollToBottom();
      break;
    case 'session_info':
      $('headerMeta').textContent = `${msg.model || ''} · ${shortenPath(msg.cwd || '')}`;
      break;
    case 'user_input':
      // Owner 的输入由 CLI 广播回来 (relay 已不做 D2D 直发,统一走 CLI)。
      // 自己发的不重复显示 — 本地 sendMessage 已经 addUserEvent。
      if (msg.from === state.peerId) break;
      addUserEvent(`${msg.nickname || (msg.from || '').substring(0, 4).toUpperCase()}: ${msg.text}`, 'owner');
      break;
    case 'suggestion':
      // legacy raw suggestion echo — 已不通过 relay D2D 直发,基本不会到。
      // 留个 fallback 用 nickname 显示。
      addSuggestionEvent(msg.nickname || msg.from, msg.text);
      break;
    case 'suggestion_broadcast':
      renderSuggestionBroadcast(msg);
      break;
    case 'invite_code':
      state.inviteCode = msg.inviteCode;
      addSystemEvent(`🎟️ 邀请码: ${msg.inviteCode}`);
      break;
    case 'participants':
      state.participants = msg.participants || [];
      renderParticipants();
      break;
    case 'local_input':
      addUserEvent(`[本地] ${msg.text}`, 'local');
      break;
    case 'mode_change':
      addSystemEvent(msg.localMode ? '已切换到本地键盘模式' : '已切换到远程控制模式');
      break;
    case 'session_end':
      addSystemEvent(`Claude 会话已结束 (code: ${msg.code})`);
      state.claudeStatus = 'idle';
      updateStatusUI();
      break;
  }
}

// ─── Phase 3 多人协作 ─────────────────────────────────────

function renderParticipants() {
  // 复用 headerMeta 容器的右侧把参与者列表显示出来。如果有专门的
  // participants 容器优先用它;否则用 header 的小字区域作 fallback。
  let container = $('participantList');
  if (!container) {
    const meta = $('headerMeta');
    if (!meta) return;
    let tag = document.getElementById('participantTag');
    if (!tag) {
      tag = document.createElement('span');
      tag.id = 'participantTag';
      tag.style.marginLeft = '8px';
      tag.style.opacity = '0.85';
      meta.appendChild(tag);
    }
    container = tag;
  }
  const html = state.participants.map(p => {
    const icon = p.role === 'upstream' ? '💻' : (p.role === 'owner' ? '👑' : '👁');
    const name = escapeHtml(p.nickname || (p.id || '').substring(0, 4).toUpperCase() || 'CLI');
    return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;margin-right:5px;border-radius:9px;font-size:11px;background:rgba(129,140,248,0.15);color:var(--accent,#818cf8);font-family:monospace">${icon} ${name}</span>`;
  }).join('');
  container.innerHTML = html;
}

function renderSuggestionBroadcast(msg) {
  // 自己发的 pending 建议不重复显示 (本地 sendMessage 已 addUserEvent)
  if (msg.from === state.peerId && msg.status === 'pending') return;

  // 已存在则更新 status,否则新建
  let el = document.querySelector(`[data-suggestion-id="${msg.id}"]`);
  const isUpdate = !!el;
  if (!el) {
    el = document.createElement('div');
    el.className = 'terminal-event suggestion';
    el.dataset.suggestionId = msg.id;
    $('terminal').appendChild(el);
  }
  const statusIcon = { pending: '⏳', approved: '✅', rejected: '🚫' }[msg.status] || '⏳';
  const name = escapeHtml(msg.nickname || (msg.from || 'observer').substring(0, 8));
  let html = `💡 <strong>${name}</strong> 建议: ${escapeHtml(msg.text || '')} <span style="opacity:0.7">${statusIcon} ${msg.status}</span>`;
  if (state.role === 'owner' && msg.status === 'pending') {
    html += ` <button onclick="approveSuggestion('${msg.id}')" style="margin-left:8px;background:#34d399;border:none;color:white;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:12px">执行</button>`;
    html += ` <button onclick="rejectSuggestion('${msg.id}')" style="margin-left:4px;background:rgba(255,255,255,0.15);border:none;color:white;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:12px">忽略</button>`;
  }
  el.innerHTML = html;
  if (!isUpdate) scrollToBottom();
}

async function approveSuggestion(id) {
  if (!state.encrypted || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    const key = state.groupKey || state.aesKey;
    const payload = await E2E.encrypt(
      JSON.stringify({ type: 'approve_suggestion', id, from: state.peerId }),
      key
    );
    state.ws.send(JSON.stringify({ type: 'encrypted', payload }));
  } catch (e) {
    console.error('Approve error:', e);
    addSystemEvent('❌ 批准失败: ' + e.message);
  }
}

async function rejectSuggestion(id) {
  if (!state.encrypted || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    const key = state.groupKey || state.aesKey;
    const payload = await E2E.encrypt(
      JSON.stringify({ type: 'reject_suggestion', id, from: state.peerId }),
      key
    );
    state.ws.send(JSON.stringify({ type: 'encrypted', payload }));
  } catch (e) {
    console.error('Reject error:', e);
    addSystemEvent('❌ 忽略失败: ' + e.message);
  }
}

// onclick 内联调用需要全局可见
window.approveSuggestion = approveSuggestion;
window.rejectSuggestion = rejectSuggestion;

// ─── 发送消息 ──────────────────────────────────────────
async function sendMessage(text) {
  if (!text?.trim()) return;
  text = text.trim();

  if (!state.encrypted || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addSystemEvent('❌ 未连接或未加密');
    return;
  }

  // owner 发 input (cc 直接执行); observer 发 suggestion (待 owner 批准)
  const msgType = state.role === 'owner' ? 'input' : 'suggestion';

  // 本地立即显示 (CLI 广播回来时用 peerId 去重)
  if (msgType === 'input') {
    addUserEvent(`${state.nickname || 'YOU'}: ${text}`, state.role);
  } else {
    addUserEvent(`${state.nickname || 'YOU'} (建议): ${text}`, state.role);
  }
  $('textInput').value = '';

  try {
    const key = state.groupKey || state.aesKey;
    const payload = await E2E.encrypt(
      JSON.stringify({ type: msgType, text, from: state.peerId, nickname: state.nickname }),
      key,
    );
    state.ws.send(JSON.stringify({ type: 'encrypted', payload }));
  } catch (e) {
    addSystemEvent('❌ 加密发送失败: ' + e.message);
  }
}

// ─── 终端渲染 ──────────────────────────────────────────
function renderTerminalEvent(evt) {
  if (!evt) return;

  // system init — 静音(header 状态点已反映)
  if (evt.type === 'system' && evt.subtype === 'init') {
    return;
  }

  // 文本增量 (assistant message content)
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text) {
        appendToLastAssistant(block.text);
      }
      if (block.type === 'tool_use') {
        addToolEvent(block.name, block.input);
      }
    }
    return;
  }

  // stream delta
  if (evt.type === 'content_block_delta' || (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta')) {
    const delta = evt.delta || evt.event?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      appendToLastAssistant(delta.text);
    }
    return;
  }

  // result
  if (evt.type === 'result') {
    if (evt.is_error) {
      addErrorEvent(evt.error || 'Unknown error');
    }
    // 结束当前 assistant 块
    finalizeAssistant();
    return;
  }

  // tool result
  if (evt.type === 'tool_result' || (evt.type === 'stream_event' && evt.event?.type === 'tool_result')) {
    // 工具执行结果
    return;
  }
}

// 终端 DOM 操作
let currentAssistantEl = null;

function addUserEvent(text, role) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = `terminal-event user`;
  el.textContent = `${role === 'local' ? '⌨️' : '📱'} > ${text}`;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function appendToLastAssistant(text) {
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'terminal-event assistant';
    $('terminal').appendChild(currentAssistantEl);
  }
  currentAssistantEl.textContent += text;
  scrollToBottom();
}

function finalizeAssistant() {
  currentAssistantEl = null;
}

function addToolEvent(name, input) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = 'terminal-event tool';
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input || {}).substring(0, 100);
  el.textContent = `🔧 ${name}(${inputStr})`;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function addSystemEvent(text) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = 'terminal-event system';
  el.textContent = text;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function addErrorEvent(text) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = 'terminal-event error';
  el.textContent = `❌ ${text}`;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function addRawEvent(text) {
  const el = document.createElement('div');
  el.className = 'terminal-event system';
  el.textContent = text;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function addSuggestionEvent(from, text) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = 'terminal-event suggestion';
  el.innerHTML = `💡 <strong>${from || 'observer'}</strong>: ${escapeHtml(text)}`;
  $('terminal').appendChild(el);
  scrollToBottom();
}

// Phase 4 chat path retired — observer 改回 suggestion 流。
// 历史 addChatEvent 已删除,如有 type:'chat' 旧消息 fallback 走 suggestion 渲染。

function scrollToBottom() {
  requestAnimationFrame(() => {
    const t = $('terminal');
    t.scrollTop = t.scrollHeight;
  });
}

// ─── UI 状态 ───────────────────────────────────────────
function updateStatusUI() {
  const dot = $('statusDot');
  const meta = $('headerMeta');

  dot.className = 'status-dot';
  if (!state.connected) {
    dot.classList.add('disconnected');
  } else if (state.claudeStatus === 'thinking' || state.claudeStatus === 'executing') {
    dot.classList.add('thinking');
  } else if (state.encrypted) {
    dot.classList.add('encrypted');
  } else {
    dot.classList.add('connected');
  }

  // 状态文字
  const statusText = {
    idle: '就绪',
    thinking: 'Claude 思考中...',
    executing: '执行中...',
    done: '完成',
    error: '出错',
    queued: '排队中...',
  }[state.claudeStatus] || '';

  if (statusText && state.claudeStatus !== 'idle') {
    const existing = meta.textContent;
    if (!existing.includes('·')) {
      meta.textContent = statusText;
    } else {
      meta.textContent = existing.split('·')[0].trim() + ' · ' + statusText;
    }
  }
}

function updateParticipants() {
  // 简化实现：显示在线数
  // 完整实现需要 relay 返回参与者列表
}

// ─── 重连 ──────────────────────────────────────────────
function scheduleReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectRetry++;
  const delay = Math.min(state.reconnectRetry * 2000, 15000);
  console.log(`[reconnect] ${delay/1000}s (attempt ${state.reconnectRetry})`);
  state.reconnectTimer = setTimeout(async () => {
    if (!state.relayCode) return;
    try {
      await connectRelay(state.relayCode);
      // 重连后重发握手
      if (state.keyPair) {
        const pubKeyBase64 = btoa(String.fromCharCode(...state.keyPair.publicKeyRaw));
        state.ws.send(JSON.stringify({
          type: 'pair_handshake',
          publicKey: pubKeyBase64,
          peerId: state.peerId,
          role: state.role,
        }));
      }
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

// ─── 语音 ──────────────────────────────────────────────
function setupVoice() {
  const btn = $('voiceBtn');
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    btn.textContent = '🎤 语音不可用';
    btn.disabled = true;
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'zh-CN';
  let isListening = false;
  let finalTranscript = '';

  btn.addEventListener('touchstart', (e) => { e.preventDefault(); startListening(); });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); stopListening(); });
  btn.addEventListener('mousedown', () => startListening());
  btn.addEventListener('mouseup', () => stopListening());

  function startListening() {
    if (isListening) return;
    isListening = true;
    finalTranscript = '';
    btn.classList.add('listening');
    btn.textContent = '🎤 正在听...';
    try { recognition.start(); } catch {}
  }

  function stopListening() {
    if (!isListening) return;
    isListening = false;
    btn.classList.remove('listening');
    btn.textContent = '🎤 按住说话';
    try { recognition.stop(); } catch {}
    if (finalTranscript.trim()) {
      sendMessage(finalTranscript.trim());
    }
  }

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    // 实时显示
    btn.textContent = `🎤 ${finalTranscript}${interim}`;
  };

  recognition.onerror = () => {
    isListening = false;
    btn.classList.remove('listening');
    btn.textContent = '🎤 按住说话';
  };
}

// ─── 工具函数 ──────────────────────────────────────────
function shortenPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-2).join('/');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── 初始化 ────────────────────────────────────────────
function init() {
  initPairScreen();
  setupVoice();

  // 文本输入
  $('textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage($('textInput').value);
    }
  });
  $('sendBtn').addEventListener('click', () => sendMessage($('textInput').value));

  // 新会话
  $('newSessionBtn').addEventListener('click', () => {
    if (confirm('开始新会话？（当前对话上下文将清除）')) {
      sendMessage('/new');
      $('terminal').innerHTML = '';
      addSystemEvent('🔄 新会话已开始');
    }
  });

  // 断开
  $('disconnectBtn').addEventListener('click', () => {
    if (state.ws) state.ws.close();
    state.encrypted = false;
    state.aesKey = null;
    state.groupKey = null;
    $('mainScreen').style.display = 'none';
    $('pairScreen').style.display = 'flex';
    $('pairBtn').disabled = false;
    $('pairBtn').textContent = '连接';
  });
}

// 检查 X25519 支持
(async () => {
  try {
    await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    init();
  } catch {
    // X25519 不被支持，降级提示
    $('pairError').textContent = '你的浏览器不支持 X25519 加密，请使用 Chrome 113+ 或 Safari 17+';
    $('pairBtn').disabled = true;
  }
})();
// redeploy-1777182078
