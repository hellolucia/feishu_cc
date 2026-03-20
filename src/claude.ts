import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';

// ── 状态存储（per chatId）────────────────────────────────────────────────────

const sessions    = new Map<string, string>();       // chatId → session UUID
const modelPrefs  = new Map<string, string>();       // chatId → model alias
const activeProcs = new Map<string, ChildProcess>(); // chatId → 当前运行的进程
const chatProjects = new Map<string, string>();      // chatId → project name

export interface UsageStat {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  turns: number;
  model: string;
}

const usageAccum = new Map<string, UsageStat>(); // chatId → 累计用量

// ── 模型预设 ──────────────────────────────────────────────────────────────────

export const MODEL_PRESETS: { alias: string; model: string; label: string }[] = [
  { alias: 'sonnet',   model: 'sonnet',   label: 'Claude Sonnet 4.6（默认）' },
  { alias: 'opus',     model: 'opus',     label: 'Claude Opus 4.6（更强）' },
  { alias: 'opusplan', model: 'opusplan', label: 'Claude Opus Plan（规划用 Opus，执行用 Sonnet）' },
  { alias: 'haiku',    model: 'haiku',    label: 'Claude Haiku 4.5（最快）' },
];

export function getModel(chatId: string): string {
  return modelPrefs.get(chatId) ?? 'sonnet';
}

export function setModel(chatId: string, alias: string): boolean {
  const preset = MODEL_PRESETS.find((p) => p.alias === alias);
  if (!preset) return false;
  modelPrefs.set(chatId, alias);
  return true;
}

// ── 用量统计 ──────────────────────────────────────────────────────────────────

export function getUsage(chatId: string): UsageStat | null {
  return usageAccum.get(chatId) ?? null;
}

export function clearUsage(chatId: string): void {
  usageAccum.delete(chatId);
}

function accumulateUsage(chatId: string, json: Record<string, unknown>): void {
  const prev = usageAccum.get(chatId) ?? {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0, turns: 0, model: getModel(chatId),
  };

  const totalCost = (json.total_cost_usd as number | undefined) ?? 0;
  let addInput = 0, addOutput = 0, addCacheRead = 0, addCacheCreate = 0;
  let modelName = prev.model;

  // stream-json 格式：usage 是扁平对象
  const usage = json.usage as Record<string, number> | undefined;
  if (usage) {
    addInput       += usage.input_tokens ?? 0;
    addOutput      += usage.output_tokens ?? 0;
    addCacheRead   += usage.cache_read_input_tokens ?? 0;
    addCacheCreate += usage.cache_creation_input_tokens ?? 0;
  }

  // json 格式：modelUsage 按模型名嵌套
  const modelUsage = json.modelUsage as Record<string, Record<string, number>> | undefined;
  if (modelUsage) {
    for (const [name, stats] of Object.entries(modelUsage)) {
      addInput       += stats.inputTokens ?? 0;
      addOutput      += stats.outputTokens ?? 0;
      addCacheRead   += stats.cacheReadInputTokens ?? 0;
      addCacheCreate += stats.cacheCreationInputTokens ?? 0;
      modelName = name;
    }
  }

  usageAccum.set(chatId, {
    inputTokens:         prev.inputTokens + addInput,
    outputTokens:        prev.outputTokens + addOutput,
    cacheReadTokens:     prev.cacheReadTokens + addCacheRead,
    cacheCreationTokens: prev.cacheCreationTokens + addCacheCreate,
    costUSD:             prev.costUSD + totalCost,
    turns:               prev.turns + 1,
    model:               modelName,
  });
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function makeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['CLAUDECODE'];
  return env;
}

// ── 核心：运行 claude，流式 yield 文字，同时收集 usage ────────────────────────

export async function* runClaudeStream(
  chatId: string,
  prompt: string,
  cwd: string,
): AsyncGenerator<string> {
  let sessionId = sessions.get(chatId);
  const isNew = !sessionId;
  if (isNew) {
    sessionId = randomUUID();
    sessions.set(chatId, sessionId);
  }

  const model = getModel(chatId);

  const SYSTEM_PROMPT =
    '执行删除文件、目录、数据等不可逆操作前，必须先用文字说明你打算做什么，并明确等待用户确认后再执行。禁止使用 rm -rf。';

  const args = [
    '--print',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json',
    '--model', model,
    '--system-prompt', SYSTEM_PROMPT,
    ...(isNew
      ? ['--session-id', sessionId!]
      : ['--resume', sessionId!]),
    '-p', prompt,
  ];

  console.log(`[claude] cwd=${cwd} model=${model} session=${isNew ? 'new:' : 'resume:'}${sessionId!.slice(0, 8)} prompt=${prompt.slice(0, 60)}`);

  // 检查工作目录是否存在
  if (!fs.existsSync(cwd)) {
    yield `❌ 工作目录不存在：\`${cwd}\`\n请检查 .env 中的 \`WORKSPACE_DIR\` 配置是否正确，或重新运行安装向导。`;
    return;
  }

  const proc = spawn('claude', args, { cwd, env: makeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcs.set(chatId, proc);

  const timer = setTimeout(() => proc.kill(), 600_000);

  let hasText = false;
  let hasResult = false;
  let lineBuffer = '';

  try {
    for await (const chunk of proc.stdout) {
      lineBuffer += (chunk as Buffer).toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: Record<string, unknown>;
        try { event = JSON.parse(trimmed) as Record<string, unknown>; }
        catch { continue; }

        const type = event.type as string;

        if (type === 'assistant') {
          const content = (event.message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              yield block.text;
              hasText = true;
            }
          }
        } else if (type === 'tool_use') {
          const toolName = (event.tool_name as string | undefined) ?? 'tool';
          const input = event.input as Record<string, unknown> | undefined;
          let label = toolName;
          if (toolName === 'Bash' && input?.command)
            label += `: \`${String(input.command).slice(0, 80)}\``;
          else if (input?.file_path)
            label += `: ${String(input.file_path).split('/').slice(-2).join('/')}`;
          yield `\n> 🔧 ${label}\n`;
        } else if (type === 'result') {
          hasResult = true;
          accumulateUsage(chatId, event);
          if (!hasText) {
            const text = (event.result as string | undefined) ?? '';
            yield text || '（Claude 执行了操作但没有文字输出，可以继续提问或发 `/new` 开新会话。）';
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
    activeProcs.delete(chatId);
  }

  await new Promise<void>((resolve) => proc.on('close', resolve));

  if (!hasText && !hasResult) {
    yield '⚠️ 执行超时或无响应，任务可能仍在进行中，请稍后重试或发 `/new` 开新会话。';
  }
}

// ── 会话管理 ──────────────────────────────────────────────────────────────────

export function newSession(chatId: string): void {
  sessions.delete(chatId);
  clearUsage(chatId);
}

export function getSessionId(chatId: string): string | null {
  return sessions.get(chatId) ?? null;
}

/** 终止当前正在运行的 claude 进程，返回是否有进程被终止 */
export function stopSession(chatId: string): boolean {
  const proc = activeProcs.get(chatId);
  if (!proc) return false;
  proc.kill('SIGTERM');
  activeProcs.delete(chatId);
  return true;
}

export function hasActiveProc(chatId: string): boolean {
  return activeProcs.has(chatId);
}

// ── 项目管理 ──────────────────────────────────────────────────────────────────

export function getChatProject(chatId: string): string | null {
  return chatProjects.get(chatId) ?? null;
}

export function setChatProject(chatId: string, project: string): void {
  chatProjects.set(chatId, project);
}

export function clearChatProject(chatId: string): void {
  chatProjects.delete(chatId);
}
