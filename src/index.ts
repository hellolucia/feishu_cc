process.title = 'feishu_cc';

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import * as Lark from '@larksuiteoapi/node-sdk';
import { downloadImage, downloadFile } from './feishu-api';
import { handleMessage, handleImageMessage, handleFileMessage } from './handler';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error('❌ 缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
  process.exit(1);
}

// ── 消息去重 ──────────────────────────────────────────────────────────────────

const processed = new Map<string, number>();
const DEDUP_TTL = 30 * 60 * 1000;

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  if (processed.has(messageId)) return true;
  processed.set(messageId, now);
  for (const [k, t] of processed) {
    if (now - t > DEDUP_TTL) processed.delete(k);
  }
  return false;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));

// 同一个 chat 的消息串行处理，不同 chat 并行
const chatQueues = new Map<string, Promise<void>>();
function enqueue(chatId: string, fn: () => Promise<void>): void {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) => console.error('[queue]', chatId, err))
    .finally(() => { if (chatQueues.get(chatId) === next) chatQueues.delete(chatId); });
  chatQueues.set(chatId, next);
}

const wsClient = new Lark.WSClient({ appId, appSecret });

const dispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const msg = data.message;
    if (msg.chat_type !== 'p2p' && !data.message.mentions?.length) return;
    if (isDuplicate(msg.message_id)) return;

    // 忽略超过 5 分钟的旧消息（防止 WS 重连后重放）
    const msgAge = Date.now() - Number(msg.create_time);
    if (msgAge > 5 * 60 * 1000) {
      console.log(`[dedup] skip old message ${msg.message_id} age=${Math.round(msgAge / 1000)}s`);
      return;
    }

    const chatId = msg.chat_id;

    // /stop 需要立即处理，不能入队（否则要等当前任务跑完才执行，起不到打断效果）
    if (msg.message_type === 'text') {
      try {
        const rawText = (JSON.parse(msg.content) as { text?: string }).text ?? '';
        const trimmed = rawText.replace(/@\S+\s*/g, '').trim();
        if (trimmed === '/stop') {
          await handleMessage(msg.message_id, chatId, '/stop');
          return;
        }
      } catch { /* 解析失败则走正常队列 */ }
    }

    enqueue(chatId, async () => {
      // ── 图片消息 ────────────────────────────────────────────────────────────
      if (msg.message_type === 'image') {
        try {
          const content = JSON.parse(msg.content) as { image_key?: string };
          const imageKey = content.image_key;
          if (!imageKey) return;

          console.log(`[${new Date().toISOString()}] chat=${chatId} image=${imageKey}`);

          const imageData = await downloadImage(msg.message_id, imageKey);
          const tmpPath = path.join(os.tmpdir(), `feishu_${Date.now()}.jpg`);
          fs.writeFileSync(tmpPath, imageData);

          await handleImageMessage(msg.message_id, chatId, tmpPath);

          fs.unlink(tmpPath, () => {});
        } catch (err) {
          console.error('[image] 处理失败:', err);
        }
        return;
      }

      // ── 文件消息 ────────────────────────────────────────────────────────────
      if (msg.message_type === 'file') {
        try {
          const content = JSON.parse(msg.content) as { file_key?: string; file_name?: string };
          const fileKey = content.file_key;
          const filename = content.file_name ?? fileKey ?? 'file';
          if (!fileKey) return;

          console.log(`[${new Date().toISOString()}] chat=${chatId} file=${filename}`);

          const fileData = await downloadFile(msg.message_id, fileKey);
          await handleFileMessage(msg.message_id, chatId, filename, fileData);
        } catch (err) {
          console.error('[file] 处理失败:', err);
        }
        return;
      }

      // ── 富文本消息（文字+图片混发）──────────────────────────────────────────
      if (msg.message_type === 'post') {
        try {
          type PostElement = { tag: string; text?: string; href?: string; image_key?: string; token?: string; obj_type?: string; title?: string; url?: string };
          const post = JSON.parse(msg.content) as { title?: string; content?: PostElement[][] };
          const parts: string[] = [];
          const imageKeys: string[] = [];

          if (post.title) parts.push(post.title);
          for (const para of post.content ?? []) {
            for (const el of para) {
              if (el.tag === 'text' && el.text) parts.push(el.text);
              else if (el.tag === 'a' && el.href) parts.push(el.text ? `${el.text}(${el.href})` : el.href);
              else if (el.tag === 'mention_doc') {
                const url = el.url ?? (el.token ? `https://feishu.cn/${el.obj_type ?? 'docx'}/${el.token}` : null);
                if (url) parts.push(el.title ? `${el.title}(${url})` : url);
              }
              else if (el.tag === 'img' && el.image_key) imageKeys.push(el.image_key);
            }
          }

          const imagePaths: string[] = [];
          for (const key of imageKeys) {
            const buf = await downloadImage(msg.message_id, key);
            const p = path.join(os.tmpdir(), `feishu_${Date.now()}_${key}.jpg`);
            fs.writeFileSync(p, buf);
            imagePaths.push(p);
          }

          const textPart = parts.join(' ').replace(/@\S+\s*/g, '').trim();
          const imgPart = imagePaths.join('\n');
          const prompt = [textPart, imgPart].filter(Boolean).join('\n');
          if (!prompt) return;

          console.log(`[${new Date().toISOString()}] chat=${chatId} post text=${textPart.slice(0, 60)} images=${imageKeys.length}`);
          await handleMessage(msg.message_id, chatId, prompt);

          for (const p of imagePaths) fs.unlink(p, () => {});
        } catch (err) {
          console.error('[post] 处理失败:', err);
        }
        return;
      }

      // ── 文本消息 ────────────────────────────────────────────────────────────
      if (msg.message_type !== 'text') return;

      let text = '';
      try {
        text = (JSON.parse(msg.content) as { text?: string }).text ?? '';
        text = text.replace(/@\S+\s*/g, '').trim();
      } catch {
        return;
      }
      if (!text) return;

      console.log(`[${new Date().toISOString()}] chat=${chatId} text=${text}`);
      await handleMessage(msg.message_id, chatId, text);
    });
  },
});

wsClient.start({ eventDispatcher: dispatcher });
console.log('🚀 feishu_cc 已启动');
