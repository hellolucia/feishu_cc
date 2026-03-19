/**
 * feishu-bot/cardkit.ts
 * 飞书 CardKit 通用层 — 无业务逻辑，可被任意飞书 bot 复用
 */
import * as Lark from '@larksuiteoapi/node-sdk';

let _client: Lark.Client | null = null;

const LOADING_ICON_KEY = process.env.FEISHU_LOADING_ICON_KEY ?? 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg';
const LOADING_ELEMENT = LOADING_ICON_KEY
  ? { tag: 'markdown', content: ' ', icon: { tag: 'custom_icon', img_key: LOADING_ICON_KEY, size: '16px 16px' }, element_id: 'loading_icon' }
  : { tag: 'markdown', content: '思考中...', element_id: 'loading_icon' };

export function getClient(): Lark.Client {
  if (!_client) {
    _client = new Lark.Client({
      appId: process.env.FEISHU_APP_ID!,
      appSecret: process.env.FEISHU_APP_SECRET!,
    });
  }
  return _client;
}

// ── Card JSON builders ────────────────────────────────────────────────────────

const ELEMENT_ID = 'content';
const THROTTLE_MS = 100;

export interface CardOptions {
  elementId?: string;
  summaryText?: string;
  extraElements?: object[];
}

export function buildStreamingCardJson(opts: CardOptions = {}): string {
  const { elementId = ELEMENT_ID, summaryText = '', extraElements = [] } = opts;
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: true,
      update_multi: true,
      summary: { content: summaryText },
      style: {
        text_size: { 'cus-content': { default: 'normal', pc: 'normal', mobile: 'large' } },
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          element_id: elementId,
          content: ' ',
          text_align: 'left',
          text_size: 'cus-content',
          margin: '0px 0px 0px 0px',
        },
        LOADING_ELEMENT,
        ...extraElements,
      ],
    },
  });
}

export function buildCompleteCardJson(content: string, opts: CardOptions = {}): string {
  const { elementId = ELEMENT_ID, extraElements = [] } = opts;
  const summary = content
    .replace(/[*_`#\[\]()~\-|<>]/g, '')
    .trim()
    .slice(0, 120);
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: false,
      update_multi: true,
      summary: { content: summary || '完成' },
      style: {
        text_size: { 'cus-content': { default: 'normal', pc: 'normal', mobile: 'large' } },
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          element_id: elementId,
          content,
          text_align: 'left',
          text_size: 'cus-content',
          margin: '0px 0px 0px 0px',
        },
        ...extraElements,
      ],
    },
  });
}

// ── CardKit API primitives ────────────────────────────────────────────────────

export async function createCard(opts: CardOptions = {}): Promise<string> {
  const res = await getClient().cardkit.v1.card.create({
    data: { type: 'card_json', data: buildStreamingCardJson(opts) },
  });
  return (res as { data?: { card_id?: string } }).data?.card_id ?? '';
}

export async function streamContent(
  cardId: string,
  elementId: string,
  content: string,
  sequence: number,
): Promise<void> {
  try {
    await getClient().cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, sequence },
    });
  } catch (err) {
    console.error('[cardkit] streamContent failed:', err instanceof Error ? err.message : err);
  }
}

export async function setStreamingMode(
  cardId: string,
  mode: boolean,
  sequence: number,
): Promise<void> {
  await getClient().cardkit.v1.card.settings({
    path: { card_id: cardId },
    data: { settings: JSON.stringify({ streaming_mode: mode }), sequence },
  });
}

export async function updateCard(
  cardId: string,
  cardJson: string,
  sequence: number,
): Promise<void> {
  await getClient().cardkit.v1.card.update({
    path: { card_id: cardId },
    data: { card: { type: 'card_json', data: cardJson }, sequence },
  });
}

export async function finalizeCard(
  cardId: string,
  content: string,
  sequence: number,
  opts: CardOptions = {},
): Promise<void> {
  await setStreamingMode(cardId, false, sequence++);
  await updateCard(cardId, buildCompleteCardJson(content, opts), sequence);
}

// ── 发送 / 回复卡片 ───────────────────────────────────────────────────────────

function cardContent(cardId: string): string {
  return JSON.stringify({ type: 'card', data: { card_id: cardId } });
}

export async function sendCard(openId: string, cardId: string): Promise<string> {
  const res = await getClient().im.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'interactive', content: cardContent(cardId) },
  });
  return (res as { data?: { message_id?: string } }).data?.message_id ?? '';
}

export async function replyCard(messageId: string, cardId: string): Promise<string> {
  const res = await getClient().im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'interactive', content: cardContent(cardId) },
  });
  return (res as { data?: { message_id?: string } }).data?.message_id ?? '';
}

// ── Typing indicator ──────────────────────────────────────────────────────────

const THINKING_EMOJI = 'GoGoGo';

export async function addTypingIndicator(messageId: string): Promise<string | null> {
  try {
    const res = await getClient().im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: THINKING_EMOJI } },
    });
    return (res as { data?: { reaction_id?: string } }).data?.reaction_id ?? null;
  } catch (err) {
    console.debug('[feishu-typing] Failed to add:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function removeTypingIndicator(
  messageId: string,
  reactionId: string | null,
): Promise<void> {
  if (!reactionId) return;
  try {
    await getClient().im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch (err) {
    console.debug('[feishu-typing] Failed to remove:', err instanceof Error ? err.message : err);
  }
}

// ── 下载图片 / 文件 ───────────────────────────────────────────────────────────

async function getTenantToken(): Promise<string> {
  const tokenRes = await getClient().auth.tenantAccessToken.internal({
    data: {
      app_id: process.env.FEISHU_APP_ID!,
      app_secret: process.env.FEISHU_APP_SECRET!,
    },
  });
  const token = (tokenRes as { tenant_access_token?: string }).tenant_access_token;
  if (!token) throw new Error('Failed to get tenant_access_token');
  return token;
}

export async function downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
  const token = await getTenantToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`下载图片失败: ${resp.status} ${resp.statusText}`);
  return Buffer.from(await resp.arrayBuffer());
}

export async function downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
  const token = await getTenantToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`下载文件失败: ${resp.status} ${resp.statusText}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── 通用流式回复（文本 chunk stream）─────────────────────────────────────────

/**
 * 消费 AsyncIterable<string>（如 claude CLI stdout），流式更新卡片
 */
export async function streamTextToCard(
  cardId: string,
  textStream: AsyncIterable<string>,
  elementId = ELEMENT_ID,
): Promise<{ accumulated: string; sequence: number }> {
  let accumulated = '';
  let sequence = 1;
  let lastFlush = 0;
  let flushInProgress = false;
  let needsReflush = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let streamDone = false;

  const doFlush = async () => {
    if (streamDone || flushInProgress) {
      if (!streamDone) needsReflush = true;
      return;
    }
    flushInProgress = true;
    needsReflush = false;
    lastFlush = Date.now();
    try {
      await streamContent(cardId, elementId, accumulated, sequence++);
    } finally {
      flushInProgress = false;
      if (!streamDone && needsReflush && !pendingTimer) {
        needsReflush = false;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          doFlush();
        }, 0);
      }
    }
  };

  const throttledFlush = () => {
    if (streamDone) return;
    const elapsed = Date.now() - lastFlush;
    if (elapsed >= THROTTLE_MS) {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      doFlush();
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        doFlush();
      }, THROTTLE_MS - elapsed);
    }
  };

  for await (const chunk of textStream) {
    accumulated += chunk;
    throttledFlush();
  }

  streamDone = true;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  while (flushInProgress) await new Promise((r) => setTimeout(r, 10));
  if (accumulated) await streamContent(cardId, elementId, accumulated, sequence++);

  return { accumulated, sequence };
}

// ── 高层 API ──────────────────────────────────────────────────────────────────

/**
 * 流式回复消息（文本 chunk stream）
 */
export async function replyStreaming(
  messageId: string,
  textStream: AsyncIterable<string>,
  opts: CardOptions = {},
): Promise<string> {
  const cardId = await createCard(opts);
  if (!cardId) throw new Error('Failed to create card');
  await replyCard(messageId, cardId);

  const { accumulated, sequence } = await streamTextToCard(cardId, textStream, opts.elementId);
  await finalizeCard(cardId, accumulated, sequence, opts);
  return accumulated;
}

/**
 * 普通文本回复
 */
export async function replyText(messageId: string, text: string): Promise<void> {
  const cardId = await createCard();
  if (!cardId) {
    await getClient().im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }) },
    });
    return;
  }
  await replyCard(messageId, cardId);
  await streamContent(cardId, ELEMENT_ID, text, 1);
  await finalizeCard(cardId, text, 2);
}

/**
 * 发送文本给指定用户（open_id）
 */
export async function sendText(openId: string, text: string): Promise<void> {
  const cardId = await createCard();
  if (!cardId) {
    await getClient().im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
    return;
  }
  await sendCard(openId, cardId);
  await streamContent(cardId, ELEMENT_ID, text, 1);
  await finalizeCard(cardId, text, 2);
}
