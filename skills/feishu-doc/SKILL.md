---
name: feishu-doc
description: |
  飞书文档读写操作。当用户提到飞书文档、分享飞书链接（feishu.cn/docx/ 或 feishu.cn/wiki/）、
  要求读取/写入/创建飞书文档或知识库，或要求发送文件到飞书时激活。
  支持云文档（docx）和知识库（wiki）两种类型。
allowed-tools:
  - Bash
---

# 飞书文档工具

通过 `${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs` 脚本操作飞书文档。

## URL 识别

从飞书 URL 中提取 token：
- 云文档：`https://xxx.feishu.cn/docx/TOKEN` → doc_token = `TOKEN`
- 知识库：`https://xxx.feishu.cn/wiki/TOKEN` → wiki_token = `TOKEN`

**Wiki 文档需先解析**：知识库链接（/wiki/TOKEN）背后可能是 docx、sheet、bitable 等不同类型。
必须先调用 `wiki-resolve` 获取实际 `obj_type` 和 `obj_token`，再决定后续操作。

## 命令参考

### 读取文档

```bash
node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs fetch <url_or_token>
```

支持直接传 docx URL/token 或 wiki URL/token（自动解析）。

返回：`{ title, content, doc_token, hint? }`

- `content` 中图片以 `<image token="xxx" width="yyy" height="zzz" align="left|center|right"/>` 形式嵌入
- 若文档含图片/文件，返回 `hint` 字段提示使用 `download-media` 下载

### 下载图片/文件

```bash
node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs download-media <token> <output_path>
```

将文档中的图片或文件下载到本地。`token` 从 `fetch` 返回内容的 `<image token="..."/>` 中提取。

返回：`{ path, size }`

### 覆盖写入

```bash
echo "markdown 内容" | node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs write <url_or_token>
```

清空文档后重写，使用 Lark-flavored Markdown 格式（见 `${CLAUDE_SKILL_DIR}/references/lark-markdown.md`）。

返回：`{ success, blocks_deleted, blocks_added }`

### 局部更新

```bash
echo '{"mode":"...","markdown":"...","selection":"..."}' \
  | node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs update <url_or_token>
```

支持 7 种模式，通过 stdin 传入 JSON：

| mode | 说明 | 必填字段 |
|------|------|---------|
| `append` | 追加到末尾 | `markdown` |
| `overwrite` | 覆盖全文 | `markdown` |
| `replace_range` | 定位替换 | `markdown` + `selection` 或 `title_selection` |
| `replace_all` | 全文替换所有匹配 | `markdown` + `selection` |
| `insert_before` | 在匹配内容前插入 | `markdown` + `selection` 或 `title_selection` |
| `insert_after` | 在匹配内容后插入 | `markdown` + `selection` 或 `title_selection` |
| `delete_range` | 删除匹配范围 | `selection` 或 `title_selection` |

**定位方式（二选一）：**

- `selection`：文本定位
  - 范围匹配：`"开头内容...结尾内容"`（匹配从开头到结尾之间的所有内容）
  - 精确匹配：`"完整文本"`（不含 `...`）
  - 字面量三个点：用 `\.\.\.` 转义
- `title_selection`：标题定位，如 `"## 章节标题"`，自动覆盖整个章节

**注意**：定位操作仅支持顶层 block，表格/callout 内部内容暂不支持。

示例：

```bash
# 追加
echo '{"mode":"append","markdown":"## 新章节\n\n内容"}' \
  | node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs update <url>

# 替换某章节
echo '{"mode":"replace_range","title_selection":"## 旧章节","markdown":"## 新章节\n\n新内容"}' \
  | node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs update <url>

# 删除某段
echo '{"mode":"delete_range","selection":"废弃内容开头...废弃内容结尾"}' \
  | node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs update <url>
```

返回：`{ success, blocks_deleted?, blocks_added?, replace_count? }`

### 追加内容

```bash
echo "markdown 内容" | node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs append <url_or_token>
```

在文档末尾追加内容。

返回：`{ success, blocks_added }`

### 创建新文档

```bash
echo "markdown 内容" | node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs create <title> [folder_token]
```

创建普通云文档。folder_token 可选（不填则创建到个人根目录）。

返回：`{ document_id, title, url }`

### 创建知识库节点

```bash
echo "markdown 内容" | node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs create-wiki <title> <space_id> [parent_node_token]
```

在指定知识空间下创建文档节点。

返回：`{ node_token, obj_token, url }`

### 解析 Wiki Token

```bash
node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs wiki-resolve <wiki_token_or_url>
```

返回：`{ node_token, obj_token, obj_type, title, space_id }`

- `obj_type` 为 `docx` 时可用本 skill 读写
- `obj_type` 为 `sheet` 时需用表格工具
- `obj_type` 为 `bitable` 时需用多维表格工具

### 发送文件到飞书

```bash
node ${CLAUDE_SKILL_DIR}/scripts/feishu-doc.mjs send-file <file_path> <open_id>
```

将本地文件发送给指定用户（open_id 格式 `ou_xxx`）。

返回：`{ message_id, file_key }`

## 工作流示例

### 读取含图片的文档

1. `fetch <url>` → 返回内容，图片以 `<image token="xxx" .../>` 嵌入
2. 从 `hint` 字段确认图片数量
3. `download-media <token> /tmp/image.png` → 下载图片

### 局部更新文档

1. `fetch <url>` → 了解文档结构
2. `update` with `replace_range` + `title_selection` → 替换指定章节

## Markdown 格式

写入内容必须使用 Lark-flavored Markdown 格式，详见：
`${CLAUDE_SKILL_DIR}/references/lark-markdown.md`

关键点：
- 标题层级清晰（≤ 4 层）
- 用 Callout 突出关键信息
- 流程图优先用 Mermaid
- 文档开头不要写与标题重复的一级标题
