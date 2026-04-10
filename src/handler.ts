import * as fs from 'fs';
import * as path from 'path';
import {
  runClaudeStream,
  newSession,
  getSessionId,
  stopSession,
  hasActiveProc,
  getModel,
  setModel,
  getUsage,
  MODEL_PRESETS,
  getChatProject,
  setChatProject,
  clearChatProject,
} from './claude';
import { replyStreaming, replyText, addTypingIndicator, removeTypingIndicator } from './feishu-api';
import { resolvePath, getProjects, getDefaultCwd } from './projects';

// ── 内部工具 ──────────────────────────────────────────────────────────────────

function currentCwd(chatId: string): string {
  const project = getChatProject(chatId);
  if (project) {
    const p = resolvePath(project);
    if (p) return p;
  }
  return getDefaultCwd();
}

async function runAndReply(messageId: string, chatId: string, prompt: string, cwd: string) {
  const sessionId = getSessionId(chatId);
  console.log(`[claude] cwd=${cwd} session=${sessionId?.slice(0, 8) ?? 'new'} prompt=${prompt.slice(0, 60)}`);
  const reactionId = await addTypingIndicator(messageId);
  try {
    await replyStreaming(messageId, runClaudeStream(chatId, prompt, cwd));
  } catch (err) {
    await replyText(messageId, `❌ 出错了：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await removeTypingIndicator(messageId, reactionId);
  }
}

// ── 文件保存工具 ──────────────────────────────────────────────────────────────

/** 将文件保存到 {cwd}/feishu_files/{filename}，重名时插入时间戳后缀 */
function saveFileToProject(cwd: string, filename: string, data: Buffer): string {
  const dir = path.join(cwd, 'feishu_files');
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let dest = path.join(dir, filename);

  if (fs.existsSync(dest)) {
    dest = path.join(dir, `${base}.${Date.now()}${ext}`);
  }

  fs.writeFileSync(dest, data);
  return dest;
}

// ── 图片消息 ──────────────────────────────────────────────────────────────────

export async function handleImageMessage(
  messageId: string,
  chatId: string,
  imagePath: string,
): Promise<void> {
  const prompt = `用户发了一张图片：${imagePath}\n请分析这张图片。`;
  await runAndReply(messageId, chatId, prompt, currentCwd(chatId));
}

// ── 文件消息 ──────────────────────────────────────────────────────────────────

export async function handleFileMessage(
  messageId: string,
  chatId: string,
  filename: string,
  data: Buffer,
): Promise<void> {
  const cwd = currentCwd(chatId);
  const savedPath = saveFileToProject(cwd, filename, data);
  const prompt = `用户发来了一个文件，已保存到：${savedPath}\n文件名：${filename}\n请读取并处理这个文件。`;
  await runAndReply(messageId, chatId, prompt, cwd);
}

// ── 文本消息 ──────────────────────────────────────────────────────────────────

export async function handleMessage(
  messageId: string,
  chatId: string,
  text: string,
): Promise<void> {
  const input = text.trim();

  // /stop — 终止当前运行的 claude 进程
  if (input === '/stop') {
    const killed = stopSession(chatId);
    await replyText(
      messageId,
      killed ? '🛑 已终止当前任务。' : '没有正在运行的任务。',
    );
    return;
  }

  // /model [alias] — 查看或切换模型
  if (input === '/model' || input.startsWith('/model ')) {
    const alias = input.slice('/model'.length).trim();
    if (!alias) {
      const current = getModel(chatId);
      const list = MODEL_PRESETS.map(
        (p) => `${p.alias === current ? '▶ ' : '　'}**${p.alias}** — ${p.label}`,
      ).join('\n');
      await replyText(messageId, `当前模型：**${current}**\n\n可选：\n${list}\n\n发 \`/model <别名>\` 切换`);
    } else if (!setModel(chatId, alias)) {
      const names = MODEL_PRESETS.map((p) => p.alias).join(' / ');
      await replyText(messageId, `❌ 未知模型 "${alias}"，可选：${names}`);
    } else {
      const preset = MODEL_PRESETS.find((p) => p.alias === alias)!;
      await replyText(messageId, `✅ 已切换到 **${preset.label}**`);
    }
    return;
  }

  // /status — 显示当前 session 和模型信息
  if (input === '/status') {
    const sessionId = getSessionId(chatId);
    const model = getModel(chatId);
    const running = hasActiveProc(chatId);
    const lines = [
      `**模型：** ${model}`,
      `**Session：** ${sessionId ? sessionId.slice(0, 8) + '…' : '无（下次对话自动创建）'}`,
      `**状态：** ${running ? '⏳ 运行中' : '空闲'}`,
    ];
    await replyText(messageId, lines.join('\n'));
    return;
  }

  // /usage — 显示本会话累计用量
  if (input === '/usage') {
    const u = getUsage(chatId);
    if (!u) {
      await replyText(messageId, '本会话暂无用量记录。');
      return;
    }
    const lines = [
      `**模型：** ${u.model}`,
      `**对话轮次：** ${u.turns}`,
      `**输入 tokens：** ${u.inputTokens.toLocaleString()}`,
      `**输出 tokens：** ${u.outputTokens.toLocaleString()}`,
      `**缓存读取：** ${u.cacheReadTokens.toLocaleString()}`,
      `**缓存写入：** ${u.cacheCreationTokens.toLocaleString()}`,
      `**累计费用：** $${u.costUSD.toFixed(4)}`,
    ];
    await replyText(messageId, lines.join('\n'));
    return;
  }

  // /new — 新建 session
  if (/^\/new(\s+\S+)?$/.test(input)) {
    newSession(chatId);
    const projectName = input.split(/\s+/)[1] ?? getChatProject(chatId) ?? (process.env.DEFAULT_PROJECT ?? '');
    await replyText(messageId, `✅ 已开始新会话，当前项目：${projectName}`);
    return;
  }

  // /projects — 列出所有项目
  if (input === '/projects') {
    const current = getChatProject(chatId) ?? (process.env.DEFAULT_PROJECT ?? '默认');
    const list = Object.keys(getProjects()).map((k) => `• ${k}`).join('\n');
    await replyText(messageId, `当前项目：**${current}**\n\n可选：\n${list}\n\n发 \`/project <项目名>\` 切换，\`/project -\` 恢复默认`);
    return;
  }

  // /project [name] — 查看或切换项目
  if (input === '/project' || input.startsWith('/project ')) {
    const name = input.slice('/project'.length).trim();
    if (!name) {
      const current = getChatProject(chatId) ?? (process.env.DEFAULT_PROJECT ?? '默认');
      const list = Object.keys(getProjects()).map((k) => `• ${k}`).join('\n');
      await replyText(messageId, `当前项目：**${current}**\n\n可选：\n${list}\n\n发 \`/project <项目名>\` 切换，\`/project -\` 恢复默认`);
    } else if (name === '-') {
      clearChatProject(chatId);
      newSession(chatId);
      await replyText(messageId, `✅ 已恢复默认项目`);
    } else {
      const p = resolvePath(name);
      if (!p) {
        await replyText(messageId, `❌ 未知项目：${name}\n可用：${Object.keys(getProjects()).join(', ')}`);
      } else {
        setChatProject(chatId, name);
        newSession(chatId);
        await replyText(messageId, `✅ 已切换到项目 **${name}**`);
      }
    }
    return;
  }

  // 解析 prompt
  const prompt = input;
  const cwd = currentCwd(chatId);

  await runAndReply(messageId, chatId, prompt, cwd);
}
