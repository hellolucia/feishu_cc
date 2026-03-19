# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

将 Claude Code CLI 接入飞书的机器人桥接服务。飞书用户通过私聊或群 @ 与机器人交互，消息经命令路由后交由本机的 `claude` 进程处理，结果以流式卡片形式返回。

## 常用命令

```bash
npm run dev        # 开发模式运行（tsx，无需编译）
npm run build      # TypeScript 编译到 dist/
npm start          # 运行编译产物

./bot.sh start     # 后台启动（生产）
./bot.sh stop      # 停止
./bot.sh restart   # 重启
./bot.sh status    # 查看运行状态
./bot.sh logs      # 实时日志
./bot.sh install   # 安装向导（配置 .env）
```

## 架构概览

```
飞书 WS 事件
    │
    ▼
src/index.ts          # 入口：WS 连接、消息去重（30min TTL）、per-chatId 串行队列
    │
    ▼
src/handler.ts        # 命令路由（/new /stop /model /project /projects /status /usage）
    │                 # 普通消息直接透传给 Claude
    ▼
src/claude.ts         # spawn claude CLI（bypassPermissions + stream-json 输出）
    │                 # 管理 session / model / usage（均为内存 Map，进程重启即清空）
    ▼
src/feishu-api.ts     # CardKit 流式卡片（100ms throttle）、图片/文件下载、typing indicator
```

**关键流程：**
1. 同一 `chatId` 的消息严格串行（`chatQueues` Map），不同 chat 并行。
2. `/stop` 命令**绕过队列**直接执行，以确保能中断正在运行的任务。
3. `claude` 进程以目标项目路径为 `cwd` 启动，自动读取该目录的 `CLAUDE.md`。
4. 流式输出：`runClaudeStream` 以 async generator yield 文字块 → `streamTextToCard` 节流后调用 CardKit API 更新卡片内容 → 完成后 `finalizeCard` 关闭流式模式。

## 模块职责

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 飞书 WebSocket 接入、消息去重、per-chat 队列、消息类型分发（text / image / file / post） |
| `src/handler.ts` | 所有机器人命令的路由与响应逻辑 |
| `src/claude.ts` | Claude CLI 子进程管理、session/model/usage 状态 |
| `src/feishu-api.ts` | 飞书 CardKit API 封装（流式卡片、回复、发送、下载） |
| `src/projects.ts` | 从 `WORKSPACE_DIR` 动态发现子目录作为可用项目 |

## 环境变量（.env）

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID（必填） |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret（必填） |
| `WORKSPACE_DIR` | 工作区根目录，子目录自动识别为项目（默认 `~/workspace`） |
| `DEFAULT_PROJECT` | 默认项目名（可选） |

## 注意事项

- **所有状态均在内存中**（session、model、usage、chatProject），进程重启后全部重置。
- Claude CLI 以 `bypassPermissions` 模式运行，system prompt 中约定了删除等危险操作须二次确认。
- 图片消息先下载到系统临时目录，处理完毕后异步删除；文件消息保存到 `{cwd}/feishu_files/`。
- CardKit 流式更新有 100ms 节流，以避免触发飞书 API 限频。
