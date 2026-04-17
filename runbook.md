# cc-voice — 本机启动 Runbook（2026-04-16 架构调整后）

> 目标：把 `BRIDGE_MODE=cli` 真实链路跑通（手机 → Cloudflare Tunnel → 本地 Node → `claude` CLI headless → 流式回推）。
> **重要变更**：原设计依赖 `cc-connect` 作桥接，核对后发现架构错配（cc-connect 是到第三方 IM 的 daemon，不会把 Claude 回复流回给 cc-voice）。已改为直接 `spawn('claude', ...)` headless 模式。cc-connect 不再需要。

```bash
cd ~/cloudwalk-claude/cc-voice
```

---

## Step 0 — 环境自检

```bash
{ command -v node >/dev/null && echo "✅ node $(node -v)" || echo "❌ node";
  command -v claude >/dev/null && echo "✅ claude $(claude --version 2>&1 | head -1)" || echo "❌ claude";
  command -v cloudflared >/dev/null && echo "✅ cloudflared $(cloudflared --version | head -1)" || echo "❌ cloudflared";
  [ -d node_modules/better-sqlite3/build/Release ] && echo "✅ better-sqlite3 native" || echo "❌ native 未编";
}
```

**通过标准**：三个 ✅ node/claude/cloudflared + better-sqlite3 native。缺就先补装。

cc-connect **不需要装**（即便装了也不再被调用）。

---

## Step 1 — 确认 claude 已登录

```bash
claude -p "你好"
```

应返回一行中文。如果提示 `Not logged in · Please run /login`，执行：
```bash
claude
/login
# 浏览器登录完，退出（Ctrl+D）
```

---

## Step 2 — Claude 模型/权限决策

cc-voice 默认：
- 模型：**sonnet**（比 opus 便宜约 5x；测试下来 opus 单次 ~$0.075，sonnet ~$0.015）
- 权限模式：**bypassPermissions**（所有工具调用自动放行）

环境变量覆盖：
| 变量 | 默认 | 说明 |
|---|---|---|
| `CLAUDE_MODEL` | `sonnet` | 可选 `opus` / `haiku` / 完整模型名 |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | 其他值：`default` / `acceptEdits` / `plan` |
| `CLAUDE_CWD` | 当前目录 | Claude 执行时的 cwd，决定它能操作哪里 |
| `CLAUDE_BIN` | `claude` | 指定 claude 可执行文件路径（通常不需要） |

⚠️ **`bypassPermissions` 的安全含义**：你在手机上敲的字，Claude 会**无阻在 Mac 上执行**——包括读写任意文件、跑任意 shell。只有单机自用且不把地址泄露出去才适用。
要保守可改 `CLAUDE_PERMISSION_MODE=acceptEdits`，但某些工具仍会阻塞（headless 下表现为卡死）。

---

## Step 3 — Cloudflare Tunnel ingress 核对

`.env` 里的 `TUNNEL_TOKEN` 绑定了 `ccvoice.app`。确认：

1. Cloudflare Dashboard → Zero Trust → Networks → Tunnels
2. 对应隧道 → Public Hostname → `ccvoice.app`
3. Service 必须是 `http://localhost:3456`
4. 若不是，改保存

---

## Step 4 — 两进程启动

开两个终端标签。

### 终端 1：cc-voice 服务（cli 模式）

```bash
cd ~/cloudwalk-claude/cc-voice
BRIDGE_MODE=cli npm start
```

启动成功应看到：
```
  CC Voice v3 running at http://localhost:3456
  Bridge: cli | DB: .../cc-voice/data
  Claude: claude | model=sonnet | permission=bypassPermissions
  Claude cwd: /Users/york/cloudwalk-claude/cc-voice
```

### 终端 2：Cloudflare Tunnel

```bash
cd ~/cloudwalk-claude/cc-voice
./start-tunnel.sh
```

`.env` 有 token → 自动走命名隧道，域名固定为 `ccvoice.app`。

---

## Step 5 — 桌面浏览器冒烟

```bash
open https://ccvoice.app
```

- 登录页 → 输入昵称（第一个用户免邀请码）→ 进入主界面
- 输入一条"你好"
- 应在 1-3 秒内看到 Claude 真实回复流式出现（不是 mock 的"✅ Done (Mock)"）

### 排障

| 现象 | 定位 |
|---|---|
| 一直是 mock 响应 | 终端 1 没带 `BRIDGE_MODE=cli`，检查启动横幅 |
| `claude exit 1` | 大概率是权限/登录问题，回到 Step 1 和 Step 2 |
| `claude exit 137` | 被 OOM kill，考虑降 `--model` 或 cwd 太大 |
| 卡在"thinking"不动 | permission-mode 没对，工具调用被阻塞；改成 `bypassPermissions` |
| 返回一段然后断 | stream-json 解析出错，终端 1 看 `[claude]` stderr |

---

## Step 6 — 手机端接入

1. iPhone Safari → `https://ccvoice.app`
2. 分享按钮 → 添加到主屏幕
3. 主屏幕启动（PWA 模式）
4. 授权麦克风
5. 登录（用桌面端同一昵称 / 或另建账号测试邀请码流程）
6. 按住麦克风说话 → 转文字 → 发送 → 看流式回复

---

## Step 7 — 真实联调清单

- [ ] 文字输入 → Claude 真实回复（非 mock）
- [ ] 语音输入（iOS Safari） → 识别 → 发送 → 回复
- [ ] 工具调用任务："列出 Desktop 文件" → 能看到流式执行
- [ ] 成本可控："/cost" 或看 Anthropic Console 账单
- [ ] 多端同步：桌面 + 手机同账号，消息实时同步
- [ ] 离线重连：手机切网络后 WS 自动重连
- [ ] 第二用户注册（用邀请码）→ DM → @Claude 在 DM 里唤起 AI

---

## 故障速查

| 现象 | 处理 |
|---|---|
| `https://ccvoice.app` 502 | 隧道连上了但 localhost:3456 没响应；检查终端 1 |
| WS 连接 1006 断 | cloudflared 版本太旧（需 ≥ 2023.x）；`brew upgrade cloudflared` |
| Opus 成本过高 | 改用 `CLAUDE_MODEL=sonnet`（已是默认） |
| rate_limit_event rejected | 5h 限额用完；Anthropic Console 充值或等重置 |
| better-sqlite3 加载失败 | `cd cc-voice && rm -rf node_modules && npm install` 重编 |
| DB 锁死 / WAL 异常 | 删 `data/cc-voice.db*` 三个文件重启（会丢历史消息） |
| 麦克风不工作 | 设置 → Safari → 网站设置 → 麦克风；PWA 重装一次 |

---

## 可选：开启 git 版本控制

目前项目**不是 git 仓库**。建议跑通后初始化：

```bash
cd ~/cloudwalk-claude/cc-voice
git init
cat > .gitignore <<'EOF'
node_modules/
data/
.env
certs/
*.log
.DS_Store
EOF
git add .
git commit -m "chore: 初始提交 cc-voice v3 (直连 claude headless 架构)"
```

---

## 相关文档

- 架构与状态页：`~/cloudwalk-claude/digital-twin/09-products/cc-voice/2026-04-16_架构与状态页.md`
- 项目 README：`./README.md`
- 隧道脚本：`./start-tunnel.sh`
