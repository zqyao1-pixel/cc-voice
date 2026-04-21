/**
 * CC Voice Relay v3 — Cloudflare Worker + Durable Object
 *
 * 零知识中继：不解析消息内容，只转发加密 blob。
 * 支持 1 upstream (CLI) + N downstream (Owner/Observer)。
 *
 * 路由：
 *   POST /api/relay/create       → 创建配对房间，返回 code
 *   GET  /api/relay/status?code= → 查询房间状态
 *   GET  /relay?code=X&role=Y    → WebSocket 升级
 *   其他                          → 静态文件（手机 UI）
 */

import { DurableObject } from 'cloudflare:workers';

// ─── 配对码生成 ─────────────────────────────────────────
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

function generateCode() {
  const arr = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// ─── Durable Object: RelayRoom ──────────────────────────
// 零知识中继：消息全部按 blob 转发，不解析内容
export class RelayRoom extends DurableObject {

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      // 房间状态查询
      const upstreams = this.ctx.getWebSockets('upstream');
      const downstreams = this.ctx.getWebSockets('downstream');
      return Response.json({
        hasUpstream: upstreams.length > 0,
        downstreams: downstreams.length,
      });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const peerId = url.searchParams.get('peerId') || crypto.randomUUID().slice(0, 8);

    if (!['upstream', 'downstream'].includes(role)) {
      return new Response('Invalid role', { status: 400 });
    }

    // 只允许 1 个 upstream
    if (role === 'upstream') {
      const existing = this.ctx.getWebSockets('upstream');
      if (existing.length > 0) {
        // 踢掉旧 upstream（支持 CLI 重启后重连）
        for (const old of existing) {
          try { old.close(1000, 'Replaced by new upstream'); } catch {}
        }
      }
    }

    // downstream 需要有 upstream
    if (role === 'downstream') {
      const upstreams = this.ctx.getWebSockets('upstream');
      if (upstreams.length === 0) {
        return new Response('No upstream — invalid or expired code', { status: 404 });
      }
    }

    // 创建 WebSocket 对
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // tag: [role, peerId]
    this.ctx.acceptWebSocket(server, [role, peerId]);

    // 通知所有人有新连接
    const allWs = this.ctx.getWebSockets();
    const notification = JSON.stringify({
      type: 'relay:peer_connected',
      role,
      peerId,
      totalDownstreams: this.ctx.getWebSockets('downstream').length + (role === 'downstream' ? 1 : 0),
    });
    for (const ws of allWs) {
      try { ws.send(notification); } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── 消息转发 ────────────────────────────────────────
  // 零知识：不解析 message 内容，按角色路由
  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags(ws);
    if (!tags || tags.length === 0) return;

    const senderRole = tags[0];

    if (senderRole === 'upstream') {
      // upstream → 广播给所有 downstream
      for (const target of this.ctx.getWebSockets('downstream')) {
        try { target.send(message); } catch {}
      }
    } else if (senderRole === 'downstream') {
      // downstream → 只发给 upstream
      for (const target of this.ctx.getWebSockets('upstream')) {
        try { target.send(message); } catch {}
      }
      // 同时广播给其他 downstream（让 observer 看到 owner 的操作）
      const senderPeerId = tags[1];
      for (const target of this.ctx.getWebSockets('downstream')) {
        const targetTags = this.ctx.getTags(target);
        if (targetTags && targetTags[1] !== senderPeerId) {
          try { target.send(message); } catch {}
        }
      }
    }
  }

  // ─── 连接关闭 ────────────────────────────────────────
  async webSocketClose(ws, code, reason, wasClean) {
    const tags = this.ctx.getTags(ws);
    if (!tags || tags.length === 0) return;

    const senderRole = tags[0];
    const senderPeerId = tags[1];

    // 通知所有人
    const notification = JSON.stringify({
      type: 'relay:peer_disconnected',
      role: senderRole,
      peerId: senderPeerId,
    });
    for (const target of this.ctx.getWebSockets()) {
      try { target.send(notification); } catch {}
    }

    // upstream 断开 → 通知所有 downstream（不强制关闭，让客户端自己决定重连）
    if (senderRole === 'upstream') {
      const msg = JSON.stringify({ type: 'relay:upstream_gone' });
      for (const target of this.ctx.getWebSockets('downstream')) {
        try { target.send(msg); } catch {}
      }
    }
  }

  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
    try { ws.close(1011, 'WebSocket error'); } catch {}
  }
}

// ─── Worker 入口 ────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API: 创建配对房间
    if (url.pathname === '/api/relay/create' && request.method === 'POST') {
      const code = generateCode();
      return Response.json(
        { code, relay: `wss://${url.host}/relay` },
        { headers: corsHeaders },
      );
    }

    // API: 房间状态
    if (url.pathname === '/api/relay/status' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) {
        return Response.json({ error: 'Missing code' }, { status: 400, headers: corsHeaders });
      }
      const id = env.RELAY_ROOM.idFromName(code.toUpperCase());
      const room = env.RELAY_ROOM.get(id);
      const status = await room.fetch(new Request('https://internal/status'));
      const data = await status.json();
      return Response.json({ code: code.toUpperCase(), ...data }, { headers: corsHeaders });
    }

    // WebSocket: 加入房间
    if (url.pathname === '/relay') {
      const code = url.searchParams.get('code');
      const role = url.searchParams.get('role');

      if (!code || !role) {
        return new Response('Missing code or role', { status: 400 });
      }
      if (!['upstream', 'downstream'].includes(role)) {
        return new Response('role must be upstream or downstream', { status: 400 });
      }

      const id = env.RELAY_ROOM.idFromName(code.toUpperCase());
      const room = env.RELAY_ROOM.get(id);
      return room.fetch(request);
    }

    // 根路径重定向到 v3 前端（保留 hash）
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/v3/' + (url.hash || '') },
      });
    }

    // 静态文件
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
