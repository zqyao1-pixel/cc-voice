# CC-Voice v3 改造方案：Swift 原生 iOS App

> 日期：2026-04-21
> 状态：Draft
> 作者：York + Claude

---

## 1. 定位与差异化

### 1.1 和 Happy 的关系

Happy 是目前最成熟的开源方案，CC-Voice v3 不是要复制它，而是在两个方向上做差异化：

- **多人协作**：Owner 执行 + Observer 实时观察/建议/投票，团队共享一个 Claude Code 会话。Happy 是纯单用户。
- **中文优先 + 跨境场景**：UI、语音识别、prompt 模板都针对中文用户优化，贴合 Cloudwalk 业务。

### 1.2 核心能力矩阵

| 能力 | Happy | Claude RC | CC-Voice v3 |
|------|-------|-----------|-------------|
| 上下文连续 | ✅ 包装器 | ✅ 官方 | ✅ 包装器 |
| 端到端加密 | ✅ ECDH+AES | ✅ Anthropic TLS | ✅ ECDH+AES |
| 多人协作 | ❌ | ❌ | ✅ Owner/Observer |
| 语音控制 | ✅ ElevenLabs | ❌ | ✅ 本地 Whisper + TTS |
| iOS 原生体验 | ❌ Expo 套壳 | ✅ Claude App 内 | ✅ Swift 原生 |
| 自部署 | ✅ | ❌ | ✅ |
| 免 Anthropic 订阅 | ✅ | ❌ 需 Pro/Max | ✅ |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────┐
│                    Mac 本地                           │
│                                                      │
│  ┌──────────┐    stdin/stdout    ┌──────────────┐   │
│  │ ccvoice  │◄──────────────────►│ claude (原生) │   │
│  │ CLI 包装器│                    │ Claude Code   │   │
│  └────┬─────┘                    └──────────────┘   │
│       │ E2E 加密                                     │
│       │ WebSocket                                    │
└───────┼──────────────────────────────────────────────┘
        │
        ▼
┌───────────────────┐
│  ccvoice.app      │  Cloudflare Worker
│  Relay Server     │  零知识中继
│  (只转发密文)      │  Durable Objects
└───────┬───────────┘
        │
   ┌────┴────┐
   ▼         ▼
┌──────┐  ┌──────┐
│ iOS  │  │ iOS  │
│Owner │  │Obsvr │
│ App  │  │ App  │
└──────┘  └──────┘
```

### 2.1 四层架构

| 层 | 组件 | 职责 |
|---|---|---|
| **CLI 层** | `ccvoice` (Node.js) | 包装 Claude Code 进程，加密，连接 relay |
| **中继层** | ccvoice.app (CF Worker + DO) | 零知识转发加密消息，管理配对房间 |
| **客户端层** | iOS App (Swift) | UI、加密、语音、推送 |
| **协议层** | ccvoice-protocol | 消息格式、加密握手、多人同步规范 |

---

## 3. CLI 包装器（核心改造）

### 3.1 原理

当前 cc-voice 的做法：每条消息 spawn 一个 `claude -p` 子进程 → 上下文丢失。

新做法：**常驻包装 Claude Code 进程的 stdin/stdout**，和 Happy 同一思路。

```
用户跑 `ccvoice` 而不是 `claude`
  → ccvoice spawn `claude` (交互模式，不是 -p)
  → 捕获 stdout/stderr → 序列化终端状态 → 加密 → 发到 relay
  → relay 转发到所有已连接的 iOS 客户端
  → iOS 客户端的输入 → 加密 → relay → ccvoice → 写入 claude 的 stdin
```

### 3.2 关键实现

```javascript
// ccvoice CLI 核心逻辑 (伪代码)
const claude = spawn('claude', [], {
  cwd: projectDir,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']  // 全部管道化
});

// stdout → 加密 → relay → 所有客户端
claude.stdout.on('data', (data) => {
  const encrypted = encrypt(data, sharedSecret);
  relay.broadcast({ type: 'terminal_output', payload: encrypted });
});

// iOS 客户端输入 → 解密 → claude stdin
relay.on('client_input', (msg) => {
  const decrypted = decrypt(msg.payload, sharedSecret);
  claude.stdin.write(decrypted);
});
```

### 3.3 本地键盘优先

和 Happy 一样：本地键盘按任意键立即接管输入权，iOS 端变为只读。再次切换到远程模式需要显式操作（`/remote` 命令或快捷键）。

### 3.4 安装体验

```bash
npm install -g ccvoice
ccvoice                    # 启动，显示配对二维码
ccvoice --project ~/myapp  # 指定项目目录
```

---

## 4. 端到端加密

### 4.1 配对流程 (ECDH)

```
CLI 端:                              iOS 端:
1. 生成 X25519 临时密钥对              
   (cliPub, cliPriv)                  
2. 编码为 QR:                         
   { sessionId, cliPub, relay }  ──────► 3. 扫码获取 cliPub
                                       4. 生成 X25519 临时密钥对
                                          (appPub, appPriv)
                                       5. ECDH: shared = X25519(appPriv, cliPub)
6. 收到 appPub                  ◄────── 发送 appPub (明文，仅此一次)
7. ECDH: shared = X25519(cliPriv, appPub)
8. 双方用 shared 派生 AES-256-GCM 密钥
```

### 4.2 消息加密

```
plaintext → AES-256-GCM(key, nonce) → { ciphertext, tag, nonce }
```

- 每条消息用递增 nonce，防重放
- relay 只看到 `{ sessionId, from, encrypted_blob }` — 零知识
- 会话结束密钥销毁 → 完美前向保密

### 4.3 多用户加密

Owner/Observer 场景下，每个 Observer 和 CLI 端独立做 ECDH，拥有独立的 shared secret。CLI 需要为每个 Observer 分别加密广播消息（或用群组密钥方案：Owner 生成 group key，用每个成员的 shared secret 分别加密 group key 分发）。

推荐 **群组密钥方案**，避免 N 倍加密开销：

```
CLI 生成 groupKey (随机 AES-256 密钥)
  → 用 sharedSecret_observer1 加密 groupKey → 发给 observer1
  → 用 sharedSecret_observer2 加密 groupKey → 发给 observer2
  → 后续消息全部用 groupKey 加密，广播一次即可
```

---

## 5. 协议规范 (ccvoice-protocol)

### 5.1 消息类型

```typescript
// CLI → Relay → 客户端
type ServerMessage =
  | { type: 'terminal_output', payload: EncryptedBlob }  // 终端输出流
  | { type: 'terminal_state', payload: EncryptedBlob }   // 完整终端快照 (新连接同步)
  | { type: 'session_info', sessionId: string, participants: Participant[] }
  | { type: 'peer_event', event: 'joined' | 'left', participant: Participant }

// 客户端 → Relay → CLI
type ClientMessage =
  | { type: 'input', payload: EncryptedBlob }            // 用户输入
  | { type: 'suggestion', payload: EncryptedBlob }       // Observer 建议
  | { type: 'voice_transcript', payload: EncryptedBlob } // 语音转文字结果
  | { type: 'vote', suggestionId: string, vote: 'up' | 'down' }

// Relay 控制消息 (明文，不含业务数据)
type RelayMessage =
  | { type: 'relay:pair_request', sessionId: string, publicKey: string }
  | { type: 'relay:pair_accept', publicKey: string, encryptedGroupKey?: string }
  | { type: 'relay:heartbeat' }
  | { type: 'relay:error', code: string, message: string }
```

### 5.2 角色与权限

| 权限 | Owner | Observer |
|------|-------|----------|
| 发送 input (执行命令) | ✅ | ❌ |
| 发送 suggestion | ✅ | ✅ |
| 接收 terminal_output | ✅ | ✅ |
| 发起投票 | ✅ | ✅ |
| 批准/执行建议 | ✅ | ❌ |
| 踢人 | ✅ | ❌ |

---

## 6. iOS App (Swift 原生)

### 6.1 技术选型

| 模块 | 技术 |
|------|------|
| UI 框架 | SwiftUI |
| 网络 | URLSessionWebSocketTask (原生 WS) |
| 加密 | CryptoKit (X25519, AES-GCM, 系统自带) |
| 语音识别 | Apple Speech Framework (本地 on-device) |
| TTS | AVSpeechSynthesizer |
| 推送 | APNs + Cloudflare Worker 触发 |
| QR 扫码 | AVCaptureSession + Vision |
| 本地存储 | SwiftData (会话历史) |
| 终端渲染 | 自定义 SwiftUI View + AttributedString (ANSI 解析) |

### 6.2 页面结构

```
App
├── PairScreen          — 扫码配对 / 输入配对码
├── SessionListScreen   — 已配对的会话列表
├── SessionScreen       — 主界面
│   ├── TerminalView    — 终端输出渲染 (ANSI color 支持)
│   ├── InputBar        — 文本输入 + 语音按钮 + 发送
│   ├── SuggestionPanel — Observer 的建议列表 (可投票)
│   └── ParticipantBar  — 在线参与者头像
└── SettingsScreen      — 配置 (relay 地址、语音、通知)
```

### 6.3 终端渲染

核心挑战：Claude Code 输出包含 ANSI 转义序列、进度条、颜色。需要在 SwiftUI 中正确渲染。

方案：
1. CLI 包装器用 `stream-json` 格式输出结构化数据（不是原始终端流）
2. iOS 端解析 JSON 事件，渲染为富文本
3. 对于工具调用/文件编辑等操作，渲染为结构化卡片而非原始文本

```swift
// 终端输出渲染 (简化)
struct TerminalView: View {
    @ObservedObject var session: SessionViewModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading) {
                    ForEach(session.events) { event in
                        switch event.type {
                        case .text(let content):
                            ANSITextView(text: content)
                        case .toolCall(let tool, let input):
                            ToolCallCard(tool: tool, input: input)
                        case .thinking:
                            ThinkingIndicator()
                        }
                    }
                }
            }
        }
    }
}
```

### 6.4 语音交互

利用 Apple 原生能力，不依赖 ElevenLabs：

```
用户按住说话 → Speech Framework on-device 识别
  → 文字 → (可选) 语音 Agent 润色为结构化指令
  → 加密 → relay → CLI → Claude Code stdin

Claude 回复 → CLI → relay → iOS
  → (可选) AVSpeechSynthesizer 朗读摘要
```

语音 Agent 润色是可选的增值层：把口语化的"帮我把那个 API 的错误处理加上"转成结构化的"在 server.js 的 /api/messages 路由中添加 try-catch 错误处理"。可以用本地小模型或直接透传。

### 6.5 推送通知

场景：用户退到后台或锁屏后，Claude 完成了任务，需要通知。

```
CLI 检测到 Claude 输出 "done" / 完成标记
  → 调 relay 的 /api/notify 端点
  → Relay Worker 调 APNs
  → iOS 收到推送，点击回到 SessionScreen
```

---

## 7. Relay 改造

### 7.1 现有基础

当前 relay (ccvoice.app) 已经有：
- Cloudflare Worker + Durable Objects
- WebSocket 配对房间
- 配对码生成和管理

### 7.2 需要新增

| 功能 | 说明 |
|------|------|
| **零知识转发** | 不再解析消息内容，只转发加密 blob |
| **多 downstream** | 一个房间支持 1 upstream (CLI) + N downstream (Owner + Observers) |
| **角色管理** | 在 relay 层标记 owner/observer，但不参与解密 |
| **APNs 代理** | 接收 CLI 的通知请求，代发推送到 iOS 设备 |
| **连接状态** | 告诉 CLI 哪些客户端在线，用于 UI 显示 |
| **会话持久化** | Durable Object SQLite 存储 session 元数据 (不存消息内容) |

### 7.3 Relay 不做的事

- 不存储/解密任何消息内容
- 不维护用户账号体系（配对码即认证）
- 不做消息队列/离线消息（CLI 离线 = 不可用）

---

## 8. 实施路线图

### Phase 1：CLI 包装器 + 协议 (2 周)

**目标**：用 `ccvoice` 替代 `claude`，终端可用，protocol 定稿。

- [ ] 重写 CLI 为包装器模式（spawn claude 交互模式）
- [ ] 定义 ccvoice-protocol v1 (消息格式 + 加密握手)
- [ ] 实现 ECDH 配对 + AES-256-GCM 加密
- [ ] 改造 relay 为零知识转发
- [ ] 用现有 Web 前端验证端到端加密链路
- [ ] `npm install -g ccvoice` 可用

**交付物**：加密链路跑通，Web 端能连。

### Phase 2：iOS App MVP (3 周)

**目标**：Swift 原生 App 能配对、看终端输出、发消息。

- [ ] Xcode 项目搭建 (SwiftUI + CryptoKit)
- [ ] QR 扫码配对 + ECDH 密钥交换
- [ ] WebSocket 连接 + 加密消息收发
- [ ] 终端输出渲染 (结构化事件 → 富文本)
- [ ] 文本输入 → 加密 → CLI
- [ ] 基础语音输入 (Apple Speech Framework)
- [ ] TestFlight 内测

**交付物**：TestFlight 可用，单用户能完整使用。

### Phase 3：多人协作 (2 周)

**目标**：Owner/Observer 角色系统上线。

- [ ] 群组密钥分发机制
- [ ] Observer 建议面板 + 投票
- [ ] Owner 批准/执行建议流程
- [ ] 参与者在线状态显示
- [ ] 邀请链接/邀请码加入会话

**交付物**：多人可同时连入同一个 Claude Code 会话。

### Phase 4：打磨 + 发布 (2 周)

**目标**：App Store 上架。

- [ ] APNs 推送通知（Claude 完成任务时通知）
- [ ] 语音 Agent 润色层（口语 → 结构化指令）
- [ ] 会话历史 (SwiftData 本地存储)
- [ ] 断线自动重连 + 状态恢复
- [ ] UI 打磨 (Dark mode、动画、Haptic feedback)
- [ ] App Store 审核材料 + 隐私政策
- [ ] 提交审核

**交付物**：App Store 上线。

---

## 9. 和现有代码的关系

| 现有文件 | 处理方式 |
|----------|----------|
| `server.js` | **大幅简化** — 去掉 HTTP API、用户注册登录、SQLite 用户表。包装器模式下不需要独立 web server |
| `bin/cli.js` | **重写** — 从"启动 server + 连 relay"变为"包装 claude + 加密 + 连 relay" |
| `relay/src/index.js` | **改造** — 去掉消息解析，改为零知识 blob 转发 + 多 downstream 支持 |
| `public/app.js` | **保留** — 作为 Web 端备用客户端，同步支持新协议 |
| `public/index.html` | **保留** — Web fallback |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Claude Code 交互模式的 stdout 格式不稳定 | 终端渲染错乱 | 用 `--output-format stream-json` 结构化输出，不依赖裸 terminal |
| App Store 审核拒绝 (远程代码执行) | 无法上架 | 强调 App 只是远程终端客户端，不在设备上执行代码 |
| ECDH 密钥交换被中间人攻击 | 加密被破解 | QR 码是物理信道（同一房间扫码），MITM 困难；后续可加 SAS 验证 |
| 长时间会话内存占用 | App 被系统杀掉 | 终端事件分页加载，只保留最近 N 条在内存 |
| Apple Speech 中文识别率不够 | 语音体验差 | 备选：Whisper on-device (via CoreML)，或直接调 API |

---

## 11. 技术栈总览

```
CLI (Node.js / TypeScript)
├── commander          — CLI 参数解析
├── node-pty           — 伪终端，捕获 Claude Code 的 stdout
├── ws                 — WebSocket 客户端
├── tweetnacl          — X25519 ECDH + 加密 (轻量)
├── qrcode-terminal    — 终端二维码
└── claude (系统依赖)  — Claude Code CLI

Relay (Cloudflare Worker)
├── Durable Objects    — 房间管理
├── WebSocket          — 消息转发
└── APNs HTTP/2        — 推送通知代理

iOS App (Swift)
├── SwiftUI            — 界面
├── CryptoKit          — X25519 + AES-GCM (系统自带)
├── Speech             — 语音识别 (系统自带)
├── AVFoundation       — 音频录制 + TTS (系统自带)
├── Vision             — QR 扫码 (系统自带)
└── SwiftData          — 本地持久化 (系统自带)
```

**iOS 端零第三方依赖** — 全部用 Apple 系统框架，审核友好，包体小。
