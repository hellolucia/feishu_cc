#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

green()  { echo -e "\033[32m$*\033[0m"; }
red()    { echo -e "\033[31m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
cyan()   { echo -e "\033[36m$*\033[0m"; }

# 进入项目目录
cd "$SCRIPT_DIR"

# 检查依赖
check_deps() {
  local missing=()
  command -v node  >/dev/null 2>&1 || missing+=("node / npm（https://nodejs.org）")
  command -v claude >/dev/null 2>&1 || missing+=("claude CLI（npm install -g @anthropic-ai/claude-code）")
  if [ ${#missing[@]} -ne 0 ]; then
    echo ""
    red "❌ 缺少以下依赖，请先安装："
    for m in "${missing[@]}"; do
      echo "   • $m"
    done
    echo ""
    read -rp "按回车关闭..." _
    exit 1
  fi
}

# ── 后台检查新版本 ────────────────────────────────────────────────────────────

UPDATE_AVAILABLE=""   # 有新版时设为新 tag 名
UPDATE_CHECK_DONE=0  # fetch 完成标志

UPDATE_TMP="$SCRIPT_DIR/.update_check_result"

check_update_bg() {
  rm -f "$UPDATE_TMP"
  (
    git -C "$SCRIPT_DIR" fetch --tags --quiet 2>/dev/null
    latest=$(git -C "$SCRIPT_DIR" tag --sort=-v:refname 2>/dev/null | head -1)
    current=$(git -C "$SCRIPT_DIR" tag --sort=-v:refname --merged HEAD 2>/dev/null | head -1)
    if [ -n "$latest" ] && [ "$latest" != "$current" ]; then
      echo "$latest" > "$UPDATE_TMP"
    else
      echo "" > "$UPDATE_TMP"
    fi
  ) &
}

poll_update_result() {
  if [ -f "$UPDATE_TMP" ]; then
    UPDATE_AVAILABLE=$(cat "$UPDATE_TMP")
    rm -f "$UPDATE_TMP"
    UPDATE_CHECK_DONE=1
  fi
}

show_menu() {
  poll_update_result

  clear
  cyan "╔══════════════════════════════════╗"
  cyan "║       飞书机器人控制台           ║"
  cyan "╚══════════════════════════════════╝"
  echo ""

  # 新版本提醒（只在检测到新版时显示）
  if [ -n "$UPDATE_AVAILABLE" ]; then
    yellow "  [NEW] 发现新版本：$UPDATE_AVAILABLE，选 9 一键升级"
    echo ""
  fi

  # 显示当前状态（PID 文件 + 进程名双重检测）
  local PID_FILE="$SCRIPT_DIR/.bot.pid"
  local bot_pid=""
  if [ -f "$PID_FILE" ]; then
    bot_pid=$(cat "$PID_FILE" | tr -d '[:space:]')
    kill -0 "$bot_pid" 2>/dev/null || bot_pid=""
  fi
  if [ -z "$bot_pid" ]; then
    bot_pid=$(pgrep -x "feishu_cc" 2>/dev/null | head -1)
  fi
  if [ -n "$bot_pid" ]; then
    green "  状态：● 运行中"
    green "  PID：$bot_pid"
  else
    yellow "  状态：● 未运行"
  fi

  echo ""
  echo "  1) 安装 / 重新安装"
  echo "  2) 启动"
  echo "  3) 重启"
  echo "  4) 停止"
  echo "  5) 修改配置"
  echo "  6) 查看状态"
  echo "  7) 查看日志（Ctrl+C 退出）"
  echo "  8) 清理日志"
  echo "  9) 升级到新版本"
  echo "  0) 退出"
  echo ""
}

# 启动时后台检查更新
check_update_bg

while true; do
  show_menu
  read -rp "  请选择 [0-9]: " choice
  echo ""

  case "$choice" in
    1)
      check_deps
      bash "$SCRIPT_DIR/bot.sh" install
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    2)
      check_deps
      bash "$SCRIPT_DIR/bot.sh" start
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    3)
      check_deps
      bash "$SCRIPT_DIR/bot.sh" restart
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    4)
      bash "$SCRIPT_DIR/bot.sh" stop
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    5)
      bash "$SCRIPT_DIR/bot.sh" config
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    6)
      bash "$SCRIPT_DIR/bot.sh" status
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    7)
      bash "$SCRIPT_DIR/bot.sh" logs
      # tail -f 被 Ctrl+C 中断后回到菜单
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    8)
      bash "$SCRIPT_DIR/bot.sh" clean
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    9)
      check_deps
      bash "$SCRIPT_DIR/bot.sh" update
      UPDATE_AVAILABLE=""
      UPDATE_CHECK_DONE=1
      echo ""
      read -rp "按回车返回菜单..." _
      ;;
    0)
      echo "再见！"
      exit 0
      ;;
    *)
      red "无效选项，请输入 0-8"
      sleep 1
      ;;
  esac
done
