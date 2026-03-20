#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.bot.pid"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/bot.log"
ENV_FILE="$SCRIPT_DIR/.env"

# ── 颜色 ──────────────────────────────────────────────────────────────────────

green()  { echo -e "\033[32m$*\033[0m"; }
red()    { echo -e "\033[31m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }

# ── 工具函数 ──────────────────────────────────────────────────────────────────

# 交互式输入：有默认值时显示，直接回车保留
prompt() {
  local var_name="$1" prompt_text="$2" default="$3"
  if [ -n "$default" ]; then
    read -rp "$prompt_text [$default]: " val
    val="${val:-$default}"
  else
    read -rp "$prompt_text: " val
  fi
  eval "$var_name=\"\$val\""
}

# 写入 .env 文件
write_env() {
  local app_id="$1" app_secret="$2" workspace_dir="$3" default_project="$4"
  cat > "$ENV_FILE" <<EOF
FEISHU_APP_ID=${app_id}
FEISHU_APP_SECRET=${app_secret}

# 工作区根目录，子文件夹自动识别为可用项目（支持 ~ 展开）
WORKSPACE_DIR=${workspace_dir}

# 默认项目名（对应 WORKSPACE_DIR 下的子文件夹名，留空则以 WORKSPACE_DIR 为 cwd）
DEFAULT_PROJECT=${default_project}
EOF
}

# ── 检查依赖 ──────────────────────────────────────────────────────────────────

check_deps() {
  local missing=()
  command -v node  >/dev/null 2>&1 || missing+=("node")
  command -v npm   >/dev/null 2>&1 || missing+=("npm")
  command -v claude >/dev/null 2>&1 || missing+=("claude (Claude Code CLI)")
  if [ ${#missing[@]} -ne 0 ]; then
    red "❌ 缺少依赖：${missing[*]}"
    echo "请先安装后重试。"
    exit 1
  fi
}

# ── install ───────────────────────────────────────────────────────────────────

cmd_install() {
  check_deps

  echo ""
  green "=== feishu_cc 安装向导 ==="
  echo ""

  # 读取已有值作为默认值
  local old_app_id="" old_app_secret="" old_workspace="" old_project=""
  if [ -f "$ENV_FILE" ]; then
    old_app_id=$(grep -E '^FEISHU_APP_ID=' "$ENV_FILE" | cut -d= -f2-)
    old_app_secret=$(grep -E '^FEISHU_APP_SECRET=' "$ENV_FILE" | cut -d= -f2-)
    old_workspace=$(grep -E '^WORKSPACE_DIR=' "$ENV_FILE" | cut -d= -f2-)
    old_project=$(grep -E '^DEFAULT_PROJECT=' "$ENV_FILE" | cut -d= -f2-)
  fi

  echo "请前往飞书开放平台 https://open.feishu.cn 创建应用并获取以下信息："
  echo ""

  local app_id app_secret workspace_dir default_project
  prompt app_id      "飞书 App ID"                                "${old_app_id}"
  prompt app_secret  "飞书 App Secret"                            "${old_app_secret}"
  prompt workspace_dir "工作区目录（子文件夹自动识别为可用项目）" "${old_workspace:-~/Documents/workspace}"
  prompt default_project "默认项目名（留空则以工作区根目录为准）" "${old_project}"

  if [ -z "$app_id" ] || [ -z "$app_secret" ]; then
    red "❌ App ID 和 App Secret 不能为空"
    exit 1
  fi

  # 检查工作区目录是否存在
  local expanded_workspace="${workspace_dir/#\~/$HOME}"
  if [ -d "$expanded_workspace" ]; then
    read -rp "📁 目录已存在：$workspace_dir，确认使用？[Y/n]: " yn
    yn="${yn:-Y}"
    if [[ ! "$yn" =~ ^[Yy]$ ]]; then
      yellow "⚠️  已取消，请重新运行安装向导并输入其他目录。"
      exit 1
    fi
  else
    yellow "⚠️  目录不存在：$workspace_dir"
    read -rp "是否立即创建该目录？[Y/n]: " yn
    yn="${yn:-Y}"
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      mkdir -p "$expanded_workspace"
      green "✅ 已创建目录：$workspace_dir"
    else
      yellow "⚠️  目录未创建，请手动创建后再启动机器人：mkdir -p $workspace_dir"
    fi
  fi

  write_env "$app_id" "$app_secret" "$workspace_dir" "$default_project"
  green "✅ .env 已写入"
  echo ""

  echo "📦 安装依赖..."
  cd "$SCRIPT_DIR" && npm install

  echo ""
  echo "🔨 编译..."
  npm run build

  echo ""
  green "✅ 安装完成！"
  echo ""
  yellow "⚠️  启动前请先完成飞书应用配置："
  echo "   1. 前往 https://open.feishu.cn 创建应用并开启机器人能力"
  echo "   2. 在「权限管理」中添加所需权限（参见 README.md）"
  echo "   3. 在「事件与回调」中开启长连接并订阅 im.message.receive_v1 事件"
  echo "   4. 发布应用并等待管理员审批通过"
  echo ""
  green "配置审批通过后，双击「飞书机器人.command」，选择「2) 启动」即可。"

  # 如果正在运行，询问是否重启
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo ""
    read -rp "机器人正在运行，是否立即重启以生效？[Y/n]: " ans
    ans="${ans:-Y}"
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      cmd_restart
    else
      yellow "⚠️  新版本将在下次启动时生效"
    fi
  fi
}

# ── start ─────────────────────────────────────────────────────────────────────

cmd_start() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      yellow "⚠️  机器人已在运行（PID $pid）"
      return
    else
      rm -f "$PID_FILE"
    fi
  fi

  if [ ! -f "$SCRIPT_DIR/dist/index.js" ]; then
    red "❌ 未找到编译产物，请先运行 ./bot.sh install"
    exit 1
  fi

  if [ ! -f "$ENV_FILE" ]; then
    red "❌ 未找到 .env 文件，请先运行 ./bot.sh install"
    exit 1
  fi

  # 日志轮转（超过 5MB 时轮转，保留 3 个历史文件）
  mkdir -p "$LOG_DIR"
  if [ -f "$LOG_FILE" ]; then
    local size
    size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$size" -ge $((5 * 1024 * 1024)) ]; then
      [ -f "${LOG_FILE}.2" ] && mv "${LOG_FILE}.2" "${LOG_FILE}.3"
      [ -f "${LOG_FILE}.1" ] && mv "${LOG_FILE}.1" "${LOG_FILE}.2"
      mv "$LOG_FILE" "${LOG_FILE}.1"
    fi
  fi

  cd "$SCRIPT_DIR"
  nohup node dist/index.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  green "🚀 机器人已启动（PID $!），日志：$LOG_FILE"
}

# ── stop ──────────────────────────────────────────────────────────────────────

cmd_stop() {
  if [ ! -f "$PID_FILE" ]; then
    yellow "机器人未在运行"
    return
  fi

  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    rm -f "$PID_FILE"
    green "🛑 已停止（PID $pid）"
  else
    yellow "进程已不存在，清理 PID 文件"
    rm -f "$PID_FILE"
  fi
}

# ── config ────────────────────────────────────────────────────────────────────

cmd_config() {
  if [ ! -f "$ENV_FILE" ]; then
    red "❌ 未找到 .env，请先运行 ./bot.sh install"
    exit 1
  fi

  local old_app_id old_app_secret old_workspace old_project
  old_app_id=$(grep -E '^FEISHU_APP_ID=' "$ENV_FILE" | cut -d= -f2-)
  old_app_secret=$(grep -E '^FEISHU_APP_SECRET=' "$ENV_FILE" | cut -d= -f2-)
  old_workspace=$(grep -E '^WORKSPACE_DIR=' "$ENV_FILE" | cut -d= -f2-)
  old_project=$(grep -E '^DEFAULT_PROJECT=' "$ENV_FILE" | cut -d= -f2-)

  echo ""
  green "=== 修改配置（直接回车保留原值）==="
  echo ""

  local app_id app_secret workspace_dir default_project
  prompt app_id          "飞书 App ID"       "${old_app_id}"
  prompt app_secret      "飞书 App Secret"   "${old_app_secret}"
  prompt workspace_dir   "工作区目录"        "${old_workspace}"
  prompt default_project "默认项目名"        "${old_project}"

  write_env "$app_id" "$app_secret" "$workspace_dir" "$default_project"
  green "✅ 配置已更新"

  # 如果正在运行，提示重启
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo ""
    read -rp "机器人正在运行，是否立即重启以生效？[Y/n]: " ans
    ans="${ans:-Y}"
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      cmd_restart
    else
      yellow "⚠️  配置将在下次启动时生效"
    fi
  fi
}

# ── restart ───────────────────────────────────────────────────────────────────

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

# ── status ────────────────────────────────────────────────────────────────────

cmd_status() {
  if [ ! -f "$PID_FILE" ]; then
    yellow "● 未运行"
    return
  fi

  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    green "● 运行中"
    echo "  PID: $pid"
    echo "  日志文件：$LOG_FILE"
  else
    yellow "● 已停止（PID 文件残留，运行 start 可重启）"
    rm -f "$PID_FILE"
  fi
}

# ── logs ──────────────────────────────────────────────────────────────────────

cmd_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    yellow "暂无日志"
    return
  fi
  tail -f "$LOG_FILE"
}

# ── update ────────────────────────────────────────────────────────────────────

cmd_update() {
  check_deps

  echo "🔍 获取最新版本信息..."
  git -C "$SCRIPT_DIR" fetch --tags

  local latest_tag
  latest_tag=$(git -C "$SCRIPT_DIR" tag --sort=-v:refname | head -1)

  if [ -n "$latest_tag" ]; then
    local current
    current=$(git -C "$SCRIPT_DIR" describe --tags --exact-match 2>/dev/null || echo "")
    if [ "$current" = "$latest_tag" ]; then
      green "✅ 已是最新版本：$latest_tag"
      return
    fi
    echo "⬆️  更新到 $latest_tag ..."
    git -C "$SCRIPT_DIR" checkout "$latest_tag"
  else
    yellow "⚠️  未找到 release tag，拉取最新代码..."
    git -C "$SCRIPT_DIR" pull
  fi

  echo "📦 安装依赖..."
  cd "$SCRIPT_DIR" && npm install

  echo "🔨 编译..."
  npm run build

  green "✅ 更新完成"

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo ""
    read -rp "机器人正在运行，是否立即重启以生效？[Y/n]: " ans
    ans="${ans:-Y}"
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      cmd_restart
    else
      yellow "⚠️  新版本将在下次启动时生效"
    fi
  fi
}

# ── clean ─────────────────────────────────────────────────────────────────────

cmd_clean() {
  local count=0
  for f in "$LOG_FILE" "${LOG_FILE}.1" "${LOG_FILE}.2" "${LOG_FILE}.3"; do
    if [ -f "$f" ]; then
      rm -f "$f"
      count=$((count + 1))
    fi
  done
  if [ "$count" -gt 0 ]; then
    green "🗑️  已清理 $count 个日志文件"
  else
    yellow "暂无日志文件"
  fi
}

# ── 入口 ──────────────────────────────────────────────────────────────────────

case "${1:-}" in
  install)  cmd_install  ;;
  update)   cmd_update   ;;
  config)   cmd_config   ;;
  start)    cmd_start    ;;
  stop)     cmd_stop     ;;
  restart)  cmd_restart  ;;
  status)   cmd_status   ;;
  logs)     cmd_logs     ;;
  clean)    cmd_clean    ;;
  *)
    echo "用法：./bot.sh <命令>"
    echo ""
    echo "命令："
    echo "  install   安装依赖、配置参数、编译"
  echo "  update    更新到最新 release 版本"
    echo "  config    修改配置（AppID、Secret、工作区等）"
    echo "  start     后台启动机器人"
    echo "  stop      停止机器人"
    echo "  restart   重启机器人"
    echo "  status    查看运行状态"
    echo "  logs      查看实时日志"
    echo "  clean     清理所有日志文件"
    ;;
esac
