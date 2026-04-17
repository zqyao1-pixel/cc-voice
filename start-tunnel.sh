#!/bin/bash
# CC Voice — Cloudflare Tunnel 启动脚本
# 支持两种模式：
#   1. 命名隧道（绑定 ccvoice.app，需要 token）
#   2. 快速隧道（随机 trycloudflare.com 地址，无需配置）

set -e

# 检查 cloudflared
if ! command -v cloudflared &> /dev/null; then
  echo "⚠️  cloudflared 未安装，正在通过 Homebrew 安装..."
  brew install cloudflared
fi

PORT=${PORT:-3456}

# ─── 模式选择 ───────────────────────────────────────────
# 设置了 TUNNEL_TOKEN 环境变量 → 命名隧道模式（绑定 ccvoice.app）
# 没设置 → 快速隧道模式（随机子域名）
#
# Token 来源：Cloudflare Dashboard → Zero Trust → Tunnels → 你的隧道 → Configure → Token
# 也可以写到 .env 文件：TUNNEL_TOKEN=eyJhIjo...

# 尝试从 .env 加载
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep TUNNEL_TOKEN | xargs 2>/dev/null) 2>/dev/null || true
fi

if [ -n "$TUNNEL_TOKEN" ]; then
  # ─── 命名隧道模式 ──────────────────────────────────────
  echo ""
  echo "🌍 启动 Cloudflare 命名隧道..."
  echo "   本地服务: http://localhost:$PORT"
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  🔗 域名: https://ccvoice.app                   ║"
  echo "║                                                  ║"
  echo "║  手机浏览器打开 ccvoice.app 即可使用              ║"
  echo "║  固定域名，每次启动地址不变                        ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""

  RETRY=0
  while true; do
    cloudflared tunnel run --token "$TUNNEL_TOKEN"
    RETRY=$((RETRY + 1))
    DELAY=$((RETRY > 5 ? 30 : RETRY * 2))
    echo ""
    echo "⚠️  隧道断开 (第 ${RETRY} 次)，${DELAY}s 后重连..."
    sleep "$DELAY"
  done

else
  # ─── 快速隧道模式 ──────────────────────────────────────
  echo ""
  echo "🌍 启动 Cloudflare 快速隧道（随机地址模式）..."
  echo "   本地服务: http://localhost:$PORT"
  echo ""
  echo "   💡 要绑定 ccvoice.app？设置 TUNNEL_TOKEN 环境变量："
  echo "      export TUNNEL_TOKEN=<你的隧道token>"
  echo "      或写入 .env 文件"
  echo ""
  echo "   等待分配公网地址..."
  echo ""

  cloudflared tunnel --url http://localhost:$PORT 2>&1 | while IFS= read -r line; do
    echo "$line"
    if echo "$line" | grep -q "trycloudflare.com"; then
      URL=$(echo "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com')
      if [ -n "$URL" ]; then
        echo ""
        echo "╔══════════════════════════════════════════════════╗"
        echo "║  🎉 公网地址就绪！                               ║"
        echo "║                                                  ║"
        echo "║  $URL"
        echo "║                                                  ║"
        echo "║  手机 Safari 打开上面的地址即可使用               ║"
        echo "║  自带 HTTPS，无需证书配置                         ║"
        echo "║  每次重启会分配新地址                              ║"
        echo "╚══════════════════════════════════════════════════╝"
        echo ""
      fi
    fi
  done
fi
