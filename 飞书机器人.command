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

show_menu() {
  clear
  cyan "╔══════════════════════════════════╗"
  cyan "║       飞书机器人控制台           ║"
  cyan "╚══════════════════════════════════╝"
  echo ""

  # 显示当前状态
  local PID_FILE="$SCRIPT_DIR/.bot.pid"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    green "  状态：● 运行中（PID $(cat "$PID_FILE")）"
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
  echo "  0) 退出"
  echo ""
}

while true; do
  show_menu
  read -rp "  请选择 [0-8]: " choice
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
