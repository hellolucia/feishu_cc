#!/usr/bin/env node
/**
 * feishu-doc CLI — 飞书文档读写工具
 *
 * 子命令：
 *   fetch <url_or_token>                  读取文档
 *   write <url_or_token>                  覆盖写入（stdin 读取 markdown）
 *   append <url_or_token>                 追加（stdin 读取 markdown）
 *   create <title> [folder_token]         创建新文档
 *   create-wiki <title> <space_id> [parent_node]  创建知识库节点
 *   wiki-resolve <wiki_token>             解析 wiki token
 *   send-file <file_path> <open_id>       发送文件到飞书 IM
 *
 * 环境变量：FEISHU_APP_ID, FEISHU_APP_SECRET
 */

import { createRequire } from 'module';
import { createReadStream, createWriteStream } from 'fs';
import { basename, dirname } from 'path';
import { mkdir } from 'fs/promises';

const require = createRequire(import.meta.url);

// ── 初始化客户端 ─────────────────────────────────────────────────────────────

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error(JSON.stringify({ error: '缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET 环境变量' }));
  process.exit(1);
}

// 优先使用 feishu_cc 本地 node_modules 中的 SDK
const sdkCandidates = [
  new URL('../../../node_modules/@larksuiteoapi/node-sdk/lib/index.js', import.meta.url).pathname,
  `${process.env.HOME}/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/node_modules/@larksuiteoapi/node-sdk`,
];

let lark;
for (const p of sdkCandidates) {
  try {
    lark = require(p);
    break;
  } catch {
    // try next
  }
}

if (!lark) {
  console.error(JSON.stringify({ error: '无法加载 @larksuiteoapi/node-sdk，请确保已安装依赖' }));
  process.exit(1);
}

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

// ── URL 解析 ─────────────────────────────────────────────────────────────────

/**
 * 从 URL 或 token 中提取 docToken 和类型
 * 支持：
 *   https://xxx.feishu.cn/docx/TOKEN
 *   https://xxx.feishu.cn/wiki/TOKEN
 *   裸 token
 */
function parseDocInput(input) {
  const wikiMatch = input.match(/feishu\.cn\/wiki\/([A-Za-z0-9_-]+)/);
  if (wikiMatch) return { token: wikiMatch[1], type: 'wiki' };

  const docxMatch = input.match(/feishu\.cn\/docx\/([A-Za-z0-9_-]+)/);
  if (docxMatch) return { token: docxMatch[1], type: 'docx' };

  // 裸 token
  return { token: input, type: 'docx' };
}

// ── stdin 读取 ────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── Markdown → Blocks 转换辅助 ───────────────────────────────────────────────

const MAX_CONVERT_RETRY_DEPTH = 8;

async function convertMarkdown(markdown) {
  const res = await client.docx.document.convert({
    data: { content_type: 'markdown', content: markdown },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    blocks: res.data?.blocks ?? [],
    firstLevelBlockIds: res.data?.first_level_block_ids ?? [],
  };
}

function splitMarkdownByHeadings(markdown) {
  const lines = markdown.split('\n');
  const chunks = [];
  let current = [];
  let inFencedBlock = false;

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) inFencedBlock = !inFencedBlock;
    if (!inFencedBlock && /^#{1,2}\s/.test(line) && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

function splitMarkdownBySize(markdown, maxChars) {
  if (markdown.length <= maxChars) return [markdown];

  const lines = markdown.split('\n');
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let inFencedBlock = false;

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) inFencedBlock = !inFencedBlock;
    const lineLength = line.length + 1;
    if (current.length > 0 && currentLength + lineLength > maxChars && !inFencedBlock) {
      chunks.push(current.join('\n'));
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += lineLength;
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  if (chunks.length > 1) return chunks;

  const midpoint = Math.floor(lines.length / 2);
  if (midpoint <= 0 || midpoint >= lines.length) return [markdown];
  return [lines.slice(0, midpoint).join('\n'), lines.slice(midpoint).join('\n')];
}

function sortBlocksByFirstLevel(blocks, firstLevelIds) {
  if (!firstLevelIds || firstLevelIds.length === 0) return blocks;
  const sorted = firstLevelIds.map((id) => blocks.find((b) => b.block_id === id)).filter(Boolean);
  const sortedIds = new Set(firstLevelIds);
  const remaining = blocks.filter((b) => !sortedIds.has(b.block_id));
  return [...sorted, ...remaining];
}

async function convertMarkdownWithFallback(markdown, depth = 0) {
  try {
    return await convertMarkdown(markdown);
  } catch (error) {
    if (depth >= MAX_CONVERT_RETRY_DEPTH || markdown.length < 2) throw error;
    const splitTarget = Math.max(256, Math.floor(markdown.length / 2));
    const chunks = splitMarkdownBySize(markdown, splitTarget);
    if (chunks.length <= 1) throw error;

    const blocks = [];
    const firstLevelBlockIds = [];
    for (const chunk of chunks) {
      const converted = await convertMarkdownWithFallback(chunk, depth + 1);
      blocks.push(...converted.blocks);
      firstLevelBlockIds.push(...converted.firstLevelBlockIds);
    }
    return { blocks, firstLevelBlockIds };
  }
}

async function chunkedConvertMarkdown(markdown) {
  const chunks = splitMarkdownByHeadings(markdown);
  const allBlocks = [];
  const allFirstLevelBlockIds = [];
  for (const chunk of chunks) {
    const { blocks, firstLevelBlockIds } = await convertMarkdownWithFallback(chunk);
    const sorted = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
    allBlocks.push(...sorted);
    allFirstLevelBlockIds.push(...firstLevelBlockIds);
  }
  return { blocks: allBlocks, firstLevelBlockIds: allFirstLevelBlockIds };
}

// ── Block 清理（for Descendant API） ─────────────────────────────────────────

function cleanBlocksForDescendant(blocks) {
  return blocks.map((block) => {
    const { parent_id: _parentId, ...cleanBlock } = block;

    // Fix: Convert API sometimes returns children as string for TableCell
    if (cleanBlock.block_type === 32 && typeof cleanBlock.children === 'string') {
      cleanBlock.children = [cleanBlock.children];
    }

    // Clean table blocks
    if (cleanBlock.block_type === 31 && cleanBlock.table) {
      const { cells: _cells, merge_info: _merge, ...tableRest } = cleanBlock.table;
      const { row_size, column_size } = tableRest.property || {};
      cleanBlock.table = { property: { row_size, column_size } };
    }

    return cleanBlock;
  });
}

// ── 图片上传 ──────────────────────────────────────────────────────────────────

function extractImageUrls(markdown) {
  const urls = [];
  // <image url="https://..."/> 语法
  for (const m of markdown.matchAll(/<image\s+[^>]*url="([^"]+)"/g)) {
    if (m[1].startsWith('http://') || m[1].startsWith('https://')) urls.push(m[1]);
  }
  // 标准 Markdown ![](url) 语法
  for (const m of markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) {
    urls.push(m[1]);
  }
  return urls;
}

async function downloadBuffer(url) {
  const https = await import('https');
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https.default : http.default;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function processImages(docToken, markdown, insertedBlocks) {
  const imageUrls = extractImageUrls(markdown);
  const imageBlocks = insertedBlocks.filter((b) => b.block_type === 27);
  if (imageUrls.length === 0 || imageBlocks.length === 0) return 0;

  let processed = 0;
  for (let i = 0; i < Math.min(imageUrls.length, imageBlocks.length); i++) {
    try {
      const url = imageUrls[i];
      const blockId = imageBlocks[i].block_id;
      const fileName = basename(new URL(url).pathname) || `image_${i}.png`;
      const buffer = await downloadBuffer(url);

      const uploadRes = await client.drive.media.uploadAll({
        data: {
          file_name: fileName,
          parent_type: 'docx_image',
          parent_node: blockId,
          size: buffer.length,
          file: buffer,
          extra: JSON.stringify({ drive_route_token: docToken }),
        },
      });
      const fileToken = uploadRes.data?.file_token;
      if (!fileToken) continue;

      await client.docx.documentBlock.patch({
        path: { document_id: docToken, block_id: blockId },
        data: { replace_image: { token: fileToken } },
      });
      processed++;
    } catch {
      // 单张图片失败不影响整体
    }
  }
  return processed;
}

// ── Block 插入（Descendant API） ──────────────────────────────────────────────

async function insertBlocksWithDescendant(docToken, blocks, firstLevelBlockIds, { parentBlockId = docToken, index = -1 } = {}) {
  const descendants = cleanBlocksForDescendant(blocks);
  if (descendants.length === 0) return { children: [] };

  const res = await client.docx.documentBlockDescendant.create({
    path: { document_id: docToken, block_id: parentBlockId },
    data: { children_id: firstLevelBlockIds, descendants, index },
  });

  if (res.code !== 0) throw new Error(`${res.msg} (code: ${res.code})`);
  return { children: res.data?.children ?? [] };
}

// ── 清空文档 ──────────────────────────────────────────────────────────────────

async function clearDocumentContent(docToken) {
  const existing = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  if (existing.code !== 0) throw new Error(existing.msg);

  const childIds =
    existing.data?.items
      ?.filter((b) => b.parent_id === docToken && b.block_type !== 1)
      .map((b) => b.block_id) ?? [];

  if (childIds.length > 0) {
    const res = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: childIds.length },
    });
    if (res.code !== 0) throw new Error(res.msg);
  }

  return childIds.length;
}

// ── 子命令实现 ────────────────────────────────────────────────────────────────

const ALIGN_MAP = { 1: 'left', 2: 'center', 3: 'right' };

async function cmdFetch(urlOrToken) {
  const { token, type } = parseDocInput(urlOrToken);

  let docToken = token;
  if (type === 'wiki') {
    const resolved = await cmdWikiResolve(token, true);
    if (resolved.obj_type !== 'docx') {
      return { error: `不支持的 wiki 文档类型：${resolved.obj_type}，请使用对应工具操作`, obj_type: resolved.obj_type, obj_token: resolved.obj_token };
    }
    docToken = resolved.obj_token;
  }

  const [contentRes, infoRes, blocksRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
    client.docx.documentBlock.list({ path: { document_id: docToken } }),
  ]);

  if (contentRes.code !== 0) throw new Error(contentRes.msg);

  const blocks = blocksRes.data?.items ?? [];
  const imageBlocks = blocks.filter((b) => b.block_type === 27);
  const fileBlocks = blocks.filter((b) => b.block_type === 23);

  // Replace image.png placeholders with image tokens in order
  let imgIdx = 0;
  let content = (contentRes.data?.content ?? '').replace(/image\.png/g, () => {
    if (imgIdx >= imageBlocks.length) return 'image.png';
    const img = imageBlocks[imgIdx++].image ?? {};
    const align = ALIGN_MAP[img.align] ?? 'left';
    return `<image token="${img.token}" width="${img.width}" height="${img.height}" align="${align}"/>`;
  });

  const mediaCount = imageBlocks.length + fileBlocks.length;
  const hint = mediaCount > 0
    ? `此文档包含 ${imageBlocks.length} 张图片${fileBlocks.length > 0 ? `、${fileBlocks.length} 个文件` : ''}。使用 download-media <token> <output_path> 下载。`
    : undefined;

  return {
    title: infoRes.data?.document?.title,
    content,
    doc_token: docToken,
    ...(hint ? { hint } : {}),
  };
}

async function cmdWrite(urlOrToken, markdown) {
  const { token, type } = parseDocInput(urlOrToken);
  let docToken = token;
  if (type === 'wiki') {
    const resolved = await cmdWikiResolve(token, true);
    docToken = resolved.obj_token;
  }

  const deleted = await clearDocumentContent(docToken);
  const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(markdown);
  if (blocks.length === 0) return { success: true, blocks_deleted: deleted, blocks_added: 0 };

  const sorted = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
  const { children } = await insertBlocksWithDescendant(docToken, sorted, firstLevelBlockIds);
  const images_processed = await processImages(docToken, markdown, children);

  return { success: true, blocks_deleted: deleted, blocks_added: blocks.length, images_processed };
}

async function cmdAppend(urlOrToken, markdown) {
  const { token, type } = parseDocInput(urlOrToken);
  let docToken = token;
  if (type === 'wiki') {
    const resolved = await cmdWikiResolve(token, true);
    docToken = resolved.obj_token;
  }

  const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(markdown);
  if (blocks.length === 0) throw new Error('内容为空');

  const sorted = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
  const { children } = await insertBlocksWithDescendant(docToken, sorted, firstLevelBlockIds);
  const images_processed = await processImages(docToken, markdown, children);

  return { success: true, blocks_added: blocks.length, images_processed };
}

async function cmdCreate(title, folderToken, markdown) {
  const res = await client.docx.document.create({
    data: { title, ...(folderToken ? { folder_token: folderToken } : {}) },
  });
  if (res.code !== 0) throw new Error(res.msg);

  const docToken = res.data?.document?.document_id;
  if (!docToken) throw new Error('创建文档成功但未返回 document_id');

  let images_processed = 0;
  if (markdown) {
    const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(markdown);
    if (blocks.length > 0) {
      const sorted = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
      const { children } = await insertBlocksWithDescendant(docToken, sorted, firstLevelBlockIds);
      images_processed = await processImages(docToken, markdown, children);
    }
  }

  return {
    document_id: docToken,
    title: res.data?.document?.title,
    url: `https://feishu.cn/docx/${docToken}`,
    images_processed,
  };
}

async function cmdCreateWiki(title, spaceId, parentNodeToken, markdown) {
  const res = await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    data: {
      obj_type: 'docx',
      node_type: 'origin',
      title,
      ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}),
    },
  });
  if (res.code !== 0) throw new Error(res.msg);

  const node = res.data?.node;
  const docToken = node?.obj_token;

  let images_processed = 0;
  if (markdown && docToken) {
    const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(markdown);
    if (blocks.length > 0) {
      const sorted = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
      const { children } = await insertBlocksWithDescendant(docToken, sorted, firstLevelBlockIds);
      images_processed = await processImages(docToken, markdown, children);
    }
  }

  return {
    node_token: node?.node_token,
    obj_token: docToken,
    obj_type: node?.obj_type,
    title: node?.title,
    url: `https://feishu.cn/wiki/${node?.node_token}`,
    images_processed,
  };
}

async function cmdWikiResolve(wikiToken, internal = false) {
  // wikiToken 可能是 URL
  const match = wikiToken.match(/feishu\.cn\/wiki\/([A-Za-z0-9_-]+)/);
  const token = match ? match[1] : wikiToken;

  const res = await client.wiki.space.getNode({ params: { token } });
  if (res.code !== 0) throw new Error(res.msg);

  const node = res.data?.node;
  const result = {
    node_token: node?.node_token,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
    space_id: node?.space_id,
  };

  if (internal) return result;
  return result;
}

async function cmdSendFile(filePath, openId) {
  const fileName = basename(filePath);

  // 上传文件
  const uploadRes = await client.im.file.create({
    data: {
      file_type: 'stream',
      file_name: fileName,
      file: createReadStream(filePath),
    },
  });

  if (uploadRes.code !== 0 && uploadRes.code !== undefined) {
    throw new Error(`上传失败: ${uploadRes.msg || JSON.stringify(uploadRes)}`);
  }

  const fileKey = uploadRes.file_key || uploadRes.data?.file_key;
  if (!fileKey) throw new Error('上传失败: 未返回 file_key');

  // 发送消息
  const sendRes = await client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });

  if (sendRes.code !== 0) throw new Error(`发送失败: ${sendRes.msg}`);

  return { message_id: sendRes.data?.message_id, file_key: fileKey };
}

async function cmdDownloadMedia(token, outputPath, docToken) {
  await mkdir(dirname(outputPath), { recursive: true });

  const downloadParams = { path: { file_token: token } };
  if (docToken) {
    downloadParams.params = { extra: JSON.stringify({ drive_route_token: docToken }) };
  }
  const res = await client.drive.media.download(downloadParams);

  // SDK v2+ returns an object with writeFile/getReadableStream instead of a raw stream
  if (typeof res.writeFile === 'function') {
    await res.writeFile(outputPath);
  } else {
    // fallback for older SDK versions that return a readable stream directly
    await new Promise((resolve, reject) => {
      const dest = createWriteStream(outputPath);
      res.pipe(dest);
      dest.on('finish', resolve);
      dest.on('error', reject);
      res.on('error', reject);
    });
  }

  const { size } = await import('fs').then((fs) => fs.promises.stat(outputPath));
  return { path: outputPath, size };
}

// ── 局部更新辅助 ──────────────────────────────────────────────────────────────

const TEXT_BLOCK_KEY = {
  2: 'paragraph', 3: 'heading1', 4: 'heading2', 5: 'heading3',
  6: 'heading4', 7: 'heading5', 8: 'heading6', 9: 'heading7',
  10: 'heading8', 11: 'heading9', 12: 'bullet', 13: 'ordered',
  14: 'code', 15: 'quote', 17: 'todo',
};
const HEADING_TYPES = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]);

function extractBlockText(block) {
  const key = TEXT_BLOCK_KEY[block.block_type];
  if (!key || !block[key]?.elements) return '';
  return block[key].elements.map((e) => e.text_run?.content ?? '').join('');
}

async function getTopLevelBlocks(docToken) {
  const res = await client.docx.documentBlock.list({ path: { document_id: docToken } });
  if (res.code !== 0) throw new Error(res.msg);
  return (res.data?.items ?? []).filter((b) => b.parent_id === docToken && b.block_type !== 1);
}

function findRangeBySelection(blocks, selection) {
  // Unescape literal \.\.\. → ___ELLIPSIS___ then detect real ...
  const unescaped = selection.replace(/\\\.\.\./g, '\x00ELLIPSIS\x00');
  const hasEllipsis = unescaped.includes('...');
  const actual = unescaped.replace(/\x00ELLIPSIS\x00/g, '...');

  if (!hasEllipsis) {
    // exact match — find all blocks containing this text
    const indices = blocks
      .map((b, i) => (extractBlockText(b).includes(actual) ? i : -1))
      .filter((i) => i !== -1);
    if (indices.length === 0) throw new Error(`未找到匹配内容: "${actual}"`);
    return { startIdx: indices[0], endIdx: indices[indices.length - 1] };
  }

  const dotIdx = actual.indexOf('...');
  const startPat = actual.slice(0, dotIdx).trim();
  const endPat = actual.slice(dotIdx + 3).trim();

  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    const text = extractBlockText(blocks[i]);
    if (startIdx === -1 && text.includes(startPat)) { startIdx = i; }
    if (startIdx !== -1 && text.includes(endPat)) { endIdx = i; break; }
  }
  if (startIdx === -1) throw new Error(`未找到开始位置: "${startPat}"`);
  if (endIdx === -1) throw new Error(`未找到结束位置: "${endPat}"`);
  return { startIdx, endIdx };
}

function findRangeByTitle(blocks, titleSelection) {
  const titleText = titleSelection.replace(/^#+\s*/, '').trim();
  let startIdx = -1;
  let headingType = 3;
  for (let i = 0; i < blocks.length; i++) {
    if (!HEADING_TYPES.has(blocks[i].block_type)) continue;
    if (extractBlockText(blocks[i]).trim() === titleText) {
      startIdx = i;
      headingType = blocks[i].block_type;
      break;
    }
  }
  if (startIdx === -1) throw new Error(`未找到标题: "${titleText}"`);

  let endIdx = blocks.length - 1;
  for (let i = startIdx + 1; i < blocks.length; i++) {
    if (HEADING_TYPES.has(blocks[i].block_type) && blocks[i].block_type <= headingType) {
      endIdx = i - 1;
      break;
    }
  }
  return { startIdx, endIdx };
}

async function deleteRange(docToken, startIdx, endIdx) {
  const res = await client.docx.documentBlockChildren.batchDelete({
    path: { document_id: docToken, block_id: docToken },
    data: { start_index: startIdx, end_index: endIdx + 1 },
  });
  if (res.code !== 0) throw new Error(`${res.msg} (code: ${res.code})`);
}

async function cmdUpdate(urlOrToken, opts) {
  const { mode, markdown, selection, title_selection } = opts;
  const { token, type } = parseDocInput(urlOrToken);
  let docToken = token;
  if (type === 'wiki') {
    const resolved = await cmdWikiResolve(token, true);
    docToken = resolved.obj_token;
  }

  if (mode === 'append') return cmdAppend(urlOrToken, markdown);
  if (mode === 'overwrite') return cmdWrite(urlOrToken, markdown);

  const blocks = await getTopLevelBlocks(docToken);

  const getRange = () => {
    if (title_selection) return findRangeByTitle(blocks, title_selection);
    if (selection) return findRangeBySelection(blocks, selection);
    throw new Error('replace_range/insert_before/insert_after/delete_range 需要 selection 或 title_selection');
  };

  if (mode === 'delete_range') {
    const { startIdx, endIdx } = getRange();
    await deleteRange(docToken, startIdx, endIdx);
    return { success: true, blocks_deleted: endIdx - startIdx + 1 };
  }

  if (mode === 'replace_range') {
    const { startIdx, endIdx } = getRange();
    await deleteRange(docToken, startIdx, endIdx);
    const { blocks: newBlocks, firstLevelBlockIds } = await chunkedConvertMarkdown(markdown);
    if (newBlocks.length > 0) {
      const sorted = sortBlocksByFirstLevel(newBlocks, firstLevelBlockIds);
      const { children } = await insertBlocksWithDescendant(docToken, sorted, firstLevelBlockIds, { index: startIdx });
      await processImages(docToken, markdown, children);
    }
    return { success: true, blocks_deleted: endIdx - startIdx + 1, blocks_added: newBlocks.length };
  }

  if (mode === 'replace_all') {
    const sel = selection ?? '';
    const matchIndices = [];
    for (let i = 0; i < blocks.length; i++) {
      if (extractBlockText(blocks[i]).includes(sel)) matchIndices.push(i);
    }
    if (matchIndices.length === 0) throw new Error(`未找到匹配内容: "${sel}"`);
    for (let k = matchIndices.length - 1; k >= 0; k--) {
      const idx = matchIndices[k];
      await deleteRange(docToken, idx, idx);
      if (markdown) {
        const { blocks: nb, firstLevelBlockIds } = await chunkedConvertMarkdown(markdown);
        if (nb.length > 0) {
          const { children } = await insertBlocksWithDescendant(docToken, sortBlocksByFirstLevel(nb, firstLevelBlockIds), firstLevelBlockIds, { index: idx });
          await processImages(docToken, markdown, children);
        }
      }
    }
    return { success: true, replace_count: matchIndices.length };
  }

  if (mode === 'insert_before') {
    const { startIdx } = getRange();
    const { blocks: nb, firstLevelBlockIds } = await chunkedConvertMarkdown(markdown);
    if (nb.length === 0) throw new Error('内容为空');
    const { children } = await insertBlocksWithDescendant(docToken, sortBlocksByFirstLevel(nb, firstLevelBlockIds), firstLevelBlockIds, { index: startIdx });
    await processImages(docToken, markdown, children);
    return { success: true, blocks_added: nb.length };
  }

  if (mode === 'insert_after') {
    const { endIdx } = getRange();
    const { blocks: nb, firstLevelBlockIds } = await chunkedConvertMarkdown(markdown);
    if (nb.length === 0) throw new Error('内容为空');
    const { children } = await insertBlocksWithDescendant(docToken, sortBlocksByFirstLevel(nb, firstLevelBlockIds), firstLevelBlockIds, { index: endIdx + 1 });
    await processImages(docToken, markdown, children);
    return { success: true, blocks_added: nb.length };
  }

  throw new Error(`未知 mode: ${mode}`);
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

async function main() {
  const [, , cmd, ...args] = process.argv;

  try {
    let result;

    switch (cmd) {
      case 'fetch': {
        if (!args[0]) throw new Error('用法: feishu-doc.mjs fetch <url_or_token>');
        result = await cmdFetch(args[0]);
        break;
      }

      case 'write': {
        if (!args[0]) throw new Error('用法: feishu-doc.mjs write <url_or_token>  (markdown via stdin)');
        const markdown = await readStdin();
        result = await cmdWrite(args[0], markdown);
        break;
      }

      case 'append': {
        if (!args[0]) throw new Error('用法: feishu-doc.mjs append <url_or_token>  (markdown via stdin)');
        const markdown = await readStdin();
        result = await cmdAppend(args[0], markdown);
        break;
      }

      case 'create': {
        if (!args[0]) throw new Error('用法: feishu-doc.mjs create <title> [folder_token]  (markdown via stdin)');
        const title = args[0];
        const folderToken = args[1];
        const markdown = await readStdin();
        result = await cmdCreate(title, folderToken, markdown);
        break;
      }

      case 'create-wiki': {
        if (!args[0] || !args[1]) throw new Error('用法: feishu-doc.mjs create-wiki <title> <space_id> [parent_node_token]  (markdown via stdin)');
        const title = args[0];
        const spaceId = args[1];
        const parentNode = args[2];
        const markdown = await readStdin();
        result = await cmdCreateWiki(title, spaceId, parentNode, markdown);
        break;
      }

      case 'wiki-resolve': {
        if (!args[0]) throw new Error('用法: feishu-doc.mjs wiki-resolve <wiki_token_or_url>');
        result = await cmdWikiResolve(args[0]);
        break;
      }

      case 'send-file': {
        if (!args[0] || !args[1]) throw new Error('用法: feishu-doc.mjs send-file <file_path> <open_id>');
        result = await cmdSendFile(args[0], args[1]);
        break;
      }

      case 'download-media': {
        if (!args[0] || !args[1]) throw new Error('用法: feishu-doc.mjs download-media <token> <output_path> [doc_token]');
        result = await cmdDownloadMedia(args[0], args[1], args[2]);
        break;
      }

      case 'update': {
        if (!args[0]) throw new Error('用法: feishu-doc.mjs update <url_or_token>  (JSON via stdin)');
        const opts = JSON.parse(await readStdin());
        if (!opts.mode) throw new Error('update: 缺少 mode 字段');
        result = await cmdUpdate(args[0], opts);
        break;
      }

      default:
        throw new Error(`未知命令: ${cmd}\n可用命令: fetch, write, append, create, create-wiki, wiki-resolve, send-file, download-media, update`);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
