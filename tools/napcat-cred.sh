#!/bin/sh
# ============================================================================
# napcat-cred.sh —— 用纯 shell（sed / sha256sum / curl）换取 NapCat WebUI 的
#                  登录凭证 Credential，用于 Authorization: Bearer <凭证>
#                  不依赖 python / node / jq
#
# 用法:
#   ./napcat-cred.sh                       # 默认容器 napcat、WebUI 127.0.0.1:6003
#   ./napcat-cred.sh napcat3               # 指定容器名
#   ./napcat-cred.sh napcat3 6003          # 指定容器名 + WebUI 端口
#   ./napcat-cred.sh '' 6003 192.168.1.5   # 不从容器读，走远端 WebUI（配合下面环境变量给 token）
#   NAPCAT_WEBUI_TOKEN=你的token ./napcat-cred.sh '' 6003
#
# 典型用法:
#   CRED=$(./napcat-cred.sh napcat3)
#   curl -s -H "Authorization: Bearer $CRED" http://127.0.0.1:6003/api/Plugin/List
#
# 说明:
#   * 换出来的凭证 1 小时有效；WebUI 登出或改密后立即失效
#   * 若 WebUI 开了 2FA，本脚本拿不到（login 会先返回 require2FA）
#   * 只想调「插件导入器」的接口时，不必换凭证：直接用 webui.json 里的 token 即可
# ============================================================================
set -eu

CTN="${1:-napcat}"
PORT="${2:-6003}"
HOST="${3:-127.0.0.1}"

# ---- 1) 取原始 token：环境变量优先，否则从容器里的 webui.json 读 ------------
TOK="${NAPCAT_WEBUI_TOKEN:-}"
if [ -z "$TOK" ] && [ -n "$CTN" ] && command -v docker >/dev/null 2>&1; then
  TOK=$(docker exec "$CTN" sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' /app/napcat/config/webui.json 2>/dev/null || true)
fi
if [ -z "$TOK" ]; then
  echo "拿不到 token：容器 '$CTN' 里没有可读的 webui.json。" >&2
  echo "可改用：NAPCAT_WEBUI_TOKEN=<你的token> $0 '' $PORT $HOST" >&2
  exit 1
fi

# ---- 2) hash = sha256(token + ".napcat")（前端登录发的就是这个） -----------
sha256 () {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  else
    printf '%s' "$1" | openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}
HASH=$(sha256 "${TOK}.napcat")

# ---- 3) 登录换凭证（响应里的 Credential 用 sed 抠出来） --------------------
RESP=$(curl -s -X POST "http://${HOST}:${PORT}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"hash\":\"${HASH}\"}")

CRED=$(printf '%s' "$RESP" | sed -n 's/.*"Credential":"\([^"]*\)".*/\1/p')
if [ -z "$CRED" ]; then
  # 有些实现会把字段排在后面，用 grep -o 兜一次
  CRED=$(printf '%s' "$RESP" | grep -o '"Credential":"[^"]*"' | cut -d'"' -f4 || true)
fi

if [ -z "$CRED" ]; then
  echo "登录失败，服务端返回：$RESP" >&2
  case "$RESP" in
    *require2FA*) echo "（该 WebUI 启用了 2FA，需要带 totpCode，本脚本未处理）" >&2 ;;
    *Unauthorized*|*invalid*) echo "（token 不对。检查 webui.json 里的 token，或容器启动时的 WEBUI_TOKEN 环境变量）" >&2 ;;
  esac
  exit 1
fi

printf '%s\n' "$CRED"
