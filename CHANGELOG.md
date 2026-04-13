# Changelog

## [feishu_cc-2026.4.13]

### 修复群聊响应所有 @ 的问题

**问题**：机器人加入群后，群里 @ 任何人（非机器人自身）时也会触发回复。

**原因**：事件过滤条件只判断消息是否含有任意 mention（`mentions.length > 0`），未区分被 @ 的是否为机器人本身。

**修复**：启动时通过飞书 API 获取机器人自身的 `open_id`，群聊消息只有 mentions 中包含机器人自身时才响应。

---

### 修复 /new 命令当前项目显示为空

**问题**：执行 `/new` 后回复"已开始新会话，当前项目："时，项目名为空，即使已通过 `/project` 切换过项目。

**原因**：`/new` 命令只从命令参数（如 `/new myproject`）或环境变量 `DEFAULT_PROJECT` 读取项目名，未读取已保存的 `getChatProject(chatId)`。

**修复**：优先级改为 命令参数 → `getChatProject(chatId)` → `DEFAULT_PROJECT` 环境变量。

---

### feishu-doc skill 图片与局部更新支持

**新增**
- `fetch` 命令：文档中的图片现在以 `<image token="..." width="..." height="..." align="..."/>` 形式嵌入内容，不再静默忽略；含图片时返回 `hint` 字段提示数量
- `download-media <token> <output_path>`：下载文档内图片或文件到本地
- `update` 命令（stdin JSON）：支持 7 种局部更新模式
  - `append` / `overwrite`：追加或全文覆盖
  - `replace_range` / `replace_all`：定位替换或全文替换
  - `insert_before` / `insert_after`：在匹配内容前后插入
  - `delete_range`：删除匹配范围
  - 通过 `selection`（文本定位，支持 `开头...结尾` 范围语法）或 `title_selection`（标题定位）确定操作范围
- 写入时图片自动上传：`write`、`append`、`create`、`create-wiki`、`update` 写入含 `<image url="..."/>` 或 `![]()` 的 markdown 时，自动下载并上传图片到对应 block

**权限**（需在飞书开放平台新增）
- `docs:doc:readonly`：下载文档内图片/文件
- `docs:document.media:upload`：向文档写入图片

---

## [0.1.0] - 2026-01-01

- 初始版本发布
- 飞书 WebSocket 长连接接入 Claude Code CLI
- 支持私聊 / 群 @ 消息
- 流式卡片输出（CardKit，100ms 节流）
- 图片、文件消息支持
- 命令：`/new` `/stop` `/model` `/project` `/projects` `/status` `/usage`
- `update` 命令：检测新版本并自动更新
- `opusplan` 模型别名
- feishu-doc skill：读取、写入、追加、创建云文档及知识库节点
