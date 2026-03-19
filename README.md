# feishu_cc

将 Claude Code 接入飞书的机器人，支持流式输出、多会话、图片识别、项目切换。

## 前置要求

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并登录（`claude` 命令可用）
- 飞书开放平台应用（见下方配置步骤）

## 使用注意

- 默认在配置的工作目录下运行，用 `/project <名称>` 切换项目（同时开启新 session），`/projects` 可列出所有可用项目
- 同一项目下会持续复用同一 session，上下文过长时用 `/new` 手动重置
- 以 **bypass permissions** 模式运行，操作不受限，请勿执行危险操作
- 建议仅私聊使用，不建议加入群聊

## 快速开始

**macOS 推荐方式：** 双击 `飞书机器人.command`，在弹出的菜单中选择 `1) 安装 / 重新安装`，填写 App ID 和 Secret 后完成安装；按照下方「飞书应用配置」完成配置并审批通过后，再选择 `2) 启动` 即可。


## 飞书应用配置

### 1. 创建应用

前往 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**。

### 2. 添加机器人

进入应用 → **添加应用能力** → 找到 **机器人** 并启用。

### 3. 配置权限

**开发配置 → 权限管理** → 开启以下权限：

| 权限 | 用途 |
|------|------|
| `im:message.p2p_msg:readonly` | 接收私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群 @ 消息 |
| `im:message:readonly` | 下载图片附件 |
| `im:message:send_as_bot` | 发送回复 |
| `im:message.reactions:write_only` | 打字指示器 |
| `cardkit:card:write` | 流式卡片输出 |

可复制以下 JSON 批量导入权限管理：

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:write",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:send_as_bot"
    ],
    "user": []
  }
}
```

### 4. 开启长连接

**开发配置 → 事件与回调 → 事件配置** → 将接收方式改为 **"使用长连接接收事件"**（无需公网地址，无需机器人提前运行即可保存）→ 添加事件：

- `im.message.receive_v1`（接收消息 v2.0）

### 5. 发布应用

完成以上配置后，**版本管理与发布 → 创建版本 → 申请发布**，等待管理员审批通过。
> ⚠️ 应用发布后配置才会正式生效，机器人才可在飞书中使用。

### 6. 启动机器人

发布审批通过后，运行机器人即可建立 WebSocket 长连接并开始接收消息：

```bash
# 双击 飞书机器人.command → 选择 2) 启动

# 或命令行
./bot.sh start
```

启动后可在日志中确认长连接建立成功。在飞书中搜索**应用名称**找到机器人，给它发消息验证权限是否正常。

## 管理菜单（macOS）

双击 `飞书机器人.command` 打开交互菜单：

```
1) 安装 / 重新安装
2) 启动
3) 重启
4) 停止
5) 修改配置
6) 查看状态
7) 查看日志（Ctrl+C 退出）
8) 清理日志
0) 退出
```

## 管理命令（命令行）

```bash
./bot.sh install   # 安装 / 重新安装
./bot.sh config    # 修改配置（AppID、Secret、工作区等）
./bot.sh start     # 后台启动
./bot.sh stop      # 停止
./bot.sh restart   # 重启
./bot.sh status    # 查看运行状态
./bot.sh logs      # 查看实时日志
./bot.sh clean     # 清理日志文件
```

## 机器人命令

在飞书中私聊机器人，或在群里 @ 机器人：

| 命令 | 说明 |
|------|------|
| 直接发消息 | 与 Claude 对话 |
| `/new` | 开始新会话（清空上下文） |
| `/stop` | 终止当前正在运行的任务 |
| `/model` | 查看当前模型 |
| `/model sonnet` | 切换到 Claude Sonnet 4.6（默认） |
| `/model opus` | 切换到 Claude Opus 4.6 |
| `/model haiku` | 切换到 Claude Haiku 4.5 |
| `/status` | 查看当前会话和模型状态 |
| `/usage` | 查看本会话累计 token 用量和费用 |
| `/projects` | 列出可用项目 |
| `/project <名字> <问题>` | 在指定项目目录下提问 |

## 配置说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 App ID | 必填 |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | 必填 |
| `WORKSPACE_DIR` | 工作区根目录，子文件夹自动识别为可用项目 | `~/Documents/workspace` |
| `DEFAULT_PROJECT` | 默认项目名（对应工作区下的子文件夹名） | 空（以工作区根目录为准） |
