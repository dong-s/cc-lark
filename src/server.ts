#!/usr/bin/env node
/**
 * cc-lark MCP Server 主入口
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateCredentials } from './auth.js';
import { LarkAPI } from './lark-api.js';
import {
  createDefaultChannelConfig,
  getResolvedChannelConfig,
  getStoredChannelConfig,
  loadState,
  saveState,
} from './store.js';
import { DEFAULT_JSON_POINTER, DEFAULT_SECRETS_FILE, storeSecretValue } from './secret-ref.js';
import {
  buildClearAckText,
  buildCompactPrompt,
  buildFreshTopicPrompt,
  buildNewTopicAckText,
  buildPseudoCommandHelpText,
  buildPseudoCommandStatusText,
  parsePseudoCommand,
} from './pseudo-commands.js';
import { LarkWebSocketClient } from './websocket.js';
import type {
  GroupPolicy,
  LarkChannelConfig,
  LarkMessage,
  ResolvedLarkChannelConfig,
  SecretInputMode,
  StoredLarkChannelState,
  TypingIndicatorState,
} from './types.js';

type PendingInboundImageState = {
  messageId: string;
  tempDir: string;
  filePath: string;
  createdAt: number;
};

type ImageStageResult =
  | { status: 'success'; filePath: string; tempDir: string }
  | { status: 'skipped' | 'failed'; reason: string };

let socketClient: LarkWebSocketClient | null = null;
let socketState: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
let socketError: string | null = null;
const freshTopicTargets = new Set<string>();

const TYPING_INDICATOR_TTL_MS = 5 * 60 * 1000;
const INBOUND_IMAGE_TTL_MS = 30 * 60 * 1000;
const typingIndicators = new Map<string, TypingIndicatorState>();
const pendingInboundImages = new Map<string, PendingInboundImageState>();

const server = new Server(
  { name: 'lark-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `Messages arrive as <channel source="lark-channel" user_id="..." message_id="...">.
Reply using the reply tool. Pass user_id from the channel tag.
For media: set media to an absolute local file path to send image/file.
For inbound message replies: always set reply_to_message_id to the message_id from the channel tag so the typing indicator can be cleared.
IMPORTANT: Always use the reply tool to respond to Lark messages. Do not just output text.`,
  },
);

function parseSecretMode(value: unknown): SecretInputMode {
  return value === 'file' ? 'file' : 'plaintext';
}

function parseGroupPolicy(value: unknown): GroupPolicy {
  return value === 'allowlist' ? 'allowlist' : 'open';
}

function ensureState(): StoredLarkChannelState {
  return loadState() ?? { channel: createDefaultChannelConfig() };
}

function shouldForwardMessage(config: ResolvedLarkChannelConfig, message: LarkMessage): boolean {
  if (!config.enabled) {
    return false;
  }

  if (message.senderType !== 'user') {
    return false;
  }

  if (message.messageType === 'reaction') {
    return true;
  }

  if (message.chatType === 'p2p') {
    if (config.dmPolicy === 'allowlist') {
      return config.allowFrom.includes(message.senderId);
    }
    return true;
  }

  const groupConfig = config.groups[message.chatId];
  if (groupConfig && !groupConfig.enabled) {
    return false;
  }

  const requireMention = groupConfig?.requireMention ?? config.requireMention;
  if (requireMention && !message.hasMention) {
    return false;
  }

  if (config.groupPolicy === 'allowlist') {
    return config.groupAllowFrom.includes(message.chatId);
  }

  return true;
}

function pruneTypingIndicators(): void {
  const now = Date.now();
  for (const [messageId, state] of typingIndicators.entries()) {
    if (now - state.createdAt > TYPING_INDICATOR_TTL_MS) {
      typingIndicators.delete(messageId);
    }
  }
}

async function addTypingIndicator(account: ResolvedLarkChannelConfig, message: LarkMessage): Promise<void> {
  if (message.messageType === 'reaction') {
    return;
  }

  pruneTypingIndicators();
  const api = new LarkAPI(account);
  try {
    const reactionId = await api.addTypingIndicator(message.messageId);
    if (!reactionId) {
      return;
    }

    typingIndicators.set(message.messageId, {
      messageId: message.messageId,
      reactionId,
      createdAt: Date.now(),
    });
  } catch (error) {
    process.stderr.write(`[lark-channel] Failed to add typing indicator: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function clearTypingIndicator(account: ResolvedLarkChannelConfig, messageId: string): Promise<void> {
  const state = typingIndicators.get(messageId);
  if (!state) {
    return;
  }

  typingIndicators.delete(messageId);
  const api = new LarkAPI(account);
  try {
    await api.removeTypingIndicator(state.messageId, state.reactionId);
  } catch (error) {
    process.stderr.write(`[lark-channel] Failed to remove typing indicator: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function resolveFreshTopicKey(message: Pick<LarkMessage, 'chatType' | 'chatId' | 'senderId'>): string {
  if (message.chatType === 'group' && message.chatId) {
    return `group:${message.chatId}`;
  }
  return `user:${message.senderId}`;
}

function resolveDownloadedImageExtension(headers: Record<string, string | string[] | undefined>): string {
  const contentTypeHeader = headers['content-type'] ?? headers['Content-Type'];
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
  if (!contentType) {
    return '.png';
  }

  const normalized = contentType.toLowerCase();
  if (normalized.includes('image/jpeg') || normalized.includes('image/jpg')) {
    return '.jpg';
  }
  if (normalized.includes('image/gif')) {
    return '.gif';
  }
  if (normalized.includes('image/webp')) {
    return '.webp';
  }
  if (normalized.includes('image/bmp')) {
    return '.bmp';
  }
  if (normalized.includes('image/svg')) {
    return '.svg';
  }
  return '.png';
}

async function clearPendingInboundImage(messageId: string): Promise<void> {
  const state = pendingInboundImages.get(messageId);
  if (!state) {
    return;
  }

  try {
    await rm(state.tempDir, { recursive: true, force: true });
    pendingInboundImages.delete(messageId);
  } catch (error) {
    process.stderr.write(`[lark-channel] Failed to remove staged inbound image: ${error instanceof Error ? error.message : String(error)} (message=${messageId})\n`);
  }
}

async function prunePendingInboundImages(): Promise<void> {
  const now = Date.now();
  const expiredMessageIds = Array.from(pendingInboundImages.values())
    .filter((state) => now - state.createdAt > INBOUND_IMAGE_TTL_MS)
    .map((state) => state.messageId);

  for (const messageId of expiredMessageIds) {
    await clearPendingInboundImage(messageId);
  }
}

async function stageInboundImage(account: ResolvedLarkChannelConfig, message: LarkMessage): Promise<ImageStageResult> {
  if (message.messageType !== 'image') {
    return { status: 'skipped', reason: 'not_image_message' };
  }

  if (!message.image?.imageKey) {
    return { status: 'skipped', reason: 'missing_image_key' };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'cc-lark-image-'));
  const stagingPath = join(tempDir, 'image');

  try {
    const downloaded = await new LarkAPI(account).downloadMessageResource(message.messageId, message.image.imageKey, stagingPath, 'image');
    const extension = resolveDownloadedImageExtension(downloaded.headers);
    const finalPath = extname(stagingPath) === extension ? stagingPath : `${stagingPath}${extension}`;
    if (finalPath !== stagingPath) {
      await rename(stagingPath, finalPath);
    }
    return {
      status: 'success',
      filePath: finalPath,
      tempDir,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildInboundImagePrompt(filePath: string): string {
  return `收到一张图片。请先使用 Read 工具读取并分析这张本地图片，然后再回复用户。\n图片绝对路径：${filePath}`;
}

function buildStatusSnapshot() {
  const stored = getStoredChannelConfig();
  const resolved = getResolvedChannelConfig();
  pruneTypingIndicators();
  return {
    appId: stored?.appId,
    domain: stored?.domain,
    enabled: stored?.enabled ?? false,
    requireMention: stored?.requireMention,
    dmPolicy: stored?.dmPolicy,
    groupPolicy: stored?.groupPolicy,
    socketState,
    socketError: socketError ?? undefined,
    hasResolvedSecret: Boolean(resolved),
    pendingFreshTopic: freshTopicTargets.size > 0,
    typingIndicatorCount: typingIndicators.size,
    pendingInboundImageCount: pendingInboundImages.size,
    savedAt: stored?.savedAt,
  };
}

async function replyPseudoCommand(message: LarkMessage, text: string): Promise<void> {
  const account = getResolvedChannelConfig();
  if (!account) {
    return;
  }

  const api = new LarkAPI(account);
  await api.replyText(message.messageId, text);
  await clearTypingIndicator(account, message.messageId);
}

async function handlePseudoCommand(message: LarkMessage): Promise<boolean> {
  if (message.messageType !== 'text') {
    return false;
  }

  const command = parsePseudoCommand(message.text);
  if (!command) {
    return false;
  }

  if (command.name === 'help') {
    await replyPseudoCommand(message, buildPseudoCommandHelpText());
    return true;
  }

  if (command.name === 'status') {
    await replyPseudoCommand(message, buildPseudoCommandStatusText(buildStatusSnapshot()));
    return true;
  }

  if (command.name === 'new') {
    freshTopicTargets.add(resolveFreshTopicKey(message));
    await replyPseudoCommand(message, buildNewTopicAckText());
    return true;
  }

  if (command.name === 'clear') {
    freshTopicTargets.add(resolveFreshTopicKey(message));
    await replyPseudoCommand(message, buildClearAckText());
    return true;
  }

  if (command.name === 'compact') {
    server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: buildCompactPrompt(),
        meta: {
          source: 'lark-channel',
          user_id: message.senderId,
          message_id: message.messageId,
          chat_id: message.chatId,
          chat_type: message.chatType,
        },
      },
    });
    return true;
  }

  return false;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'login',
      description: '配置飞书/Lark 应用凭证。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          app_id: { type: 'string', description: '飞书/Lark App ID' },
          app_secret: { type: 'string', description: '飞书/Lark App Secret' },
          domain: { type: 'string', enum: ['feishu', 'lark'], description: '可选：默认 feishu' },
          secret_mode: { type: 'string', enum: ['plaintext', 'file'], description: '可选：默认 plaintext' },
          require_mention: { type: 'boolean', description: '群聊是否要求 @，默认 true' },
          dm_policy: { type: 'string', enum: ['open', 'pairing', 'allowlist'], description: '默认 open' },
          group_policy: { type: 'string', enum: ['open', 'allowlist'], description: '默认 open' },
        },
        required: ['app_id', 'app_secret'],
      },
    },
    {
      name: 'reply',
      description: '回复飞书/Lark 消息',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: { type: 'string', description: '飞书用户 ID' },
          content: { type: 'string', description: '回复文本内容' },
          media: { type: 'string', description: '可选：本地媒体绝对路径' },
          reply_to_message_id: { type: 'string', description: '可选：引用回复的消息 ID' },
        },
        required: ['user_id', 'content'],
      },
    },
    {
      name: 'edit_message',
      description: '编辑飞书/Lark 已发送文本消息',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: '目标消息 ID' },
          content: { type: 'string', description: '新的文本内容' },
        },
        required: ['message_id', 'content'],
      },
    },
    {
      name: 'delete_message',
      description: '撤回飞书/Lark 消息',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: '目标消息 ID' },
        },
        required: ['message_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'login') {
    const appId = args?.app_id as string | undefined;
    const appSecret = args?.app_secret as string | undefined;
    const domain = args?.domain === 'lark' ? 'lark' : 'feishu';
    const secretMode = parseSecretMode(args?.secret_mode);

    if (!appId || !appSecret) {
      return {
        content: [{ type: 'text' as const, text: '缺少必填参数: app_id, app_secret' }],
        isError: true,
      };
    }

    try {
      await validateCredentials({ appId, appSecret, domain });
      const state = ensureState();
      state.channel = {
        ...state.channel,
        enabled: true,
        appId,
        appSecret: storeSecretValue({
          secretValue: appSecret,
          mode: secretMode,
          state,
          filePath: DEFAULT_SECRETS_FILE,
          jsonPointer: DEFAULT_JSON_POINTER,
        }),
        domain,
        connectionMode: 'websocket',
        requireMention: typeof args?.require_mention === 'boolean' ? args.require_mention : true,
        dmPolicy: args?.dm_policy === 'open' || args?.dm_policy === 'allowlist' || args?.dm_policy === 'pairing' ? args.dm_policy : 'open',
        groupPolicy: parseGroupPolicy(args?.group_policy),
        savedAt: new Date().toISOString(),
      } satisfies LarkChannelConfig;

      saveState(state);
      const resolved = getResolvedChannelConfig();
      if (!resolved) {
        throw new Error('配置已保存，但 appSecret 无法解析');
      }
      await startSocket(resolved);
      return {
        content: [{ type: 'text' as const, text: `登录成功: ${appId} (${domain}, secret=${secretMode})` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `登录失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  if (name === 'reply') {
    const userId = args?.user_id as string | undefined;
    const content = args?.content as string | undefined;
    const media = args?.media as string | undefined;
    const replyToMessageId = args?.reply_to_message_id as string | undefined;

    if (!userId || !content) {
      return {
        content: [{ type: 'text' as const, text: '缺少必填参数: user_id, content' }],
        isError: true,
      };
    }

    if (media && !existsSync(media)) {
      return {
        content: [{ type: 'text' as const, text: `媒体文件不存在: ${media}` }],
        isError: true,
      };
    }

    const account = getResolvedChannelConfig();
    if (!account) {
      return {
        content: [{ type: 'text' as const, text: '未配置账号或 appSecret 无法解析，请先使用 login 工具' }],
        isError: true,
      };
    }

    try {
      await prunePendingInboundImages();
      const api = new LarkAPI(account);
      if (replyToMessageId) {
        await api.replyText(replyToMessageId, content);
        await clearTypingIndicator(account, replyToMessageId);
        await clearPendingInboundImage(replyToMessageId);
      } else {
        await api.sendText(userId, content);
      }

      if (media) {
        const fileType = /\.(png|jpg|jpeg|gif|webp)$/i.test(media) ? 'image' : 'file';
        await api.sendFile(userId, media, fileType);
      }

      return {
        content: [{ type: 'text' as const, text: `已发送回复${media ? ' + 1 个媒体文件' : ''}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `发送失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  if (name === 'edit_message') {
    const messageId = args?.message_id as string | undefined;
    const content = args?.content as string | undefined;

    if (!messageId || !content) {
      return {
        content: [{ type: 'text' as const, text: '缺少必填参数: message_id, content' }],
        isError: true,
      };
    }

    const account = getResolvedChannelConfig();
    if (!account) {
      return {
        content: [{ type: 'text' as const, text: '未配置账号或 appSecret 无法解析，请先使用 login 工具' }],
        isError: true,
      };
    }

    try {
      const api = new LarkAPI(account);
      await api.updateText(messageId, content);
      return {
        content: [{ type: 'text' as const, text: '已编辑消息' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `编辑失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  if (name === 'delete_message') {
    const messageId = args?.message_id as string | undefined;

    if (!messageId) {
      return {
        content: [{ type: 'text' as const, text: '缺少必填参数: message_id' }],
        isError: true,
      };
    }

    const account = getResolvedChannelConfig();
    if (!account) {
      return {
        content: [{ type: 'text' as const, text: '未配置账号或 appSecret 无法解析，请先使用 login 工具' }],
        isError: true,
      };
    }

    try {
      const api = new LarkAPI(account);
      await api.deleteMessage(messageId);
      return {
        content: [{ type: 'text' as const, text: '已撤回消息' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `撤回失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text' as const, text: `未知工具: ${name}` }],
    isError: true,
  };
});

async function buildForwardMessageText(account: ResolvedLarkChannelConfig, message: LarkMessage): Promise<string> {
  if (message.messageType === 'image') {
    const result = await stageInboundImage(account, message);
    if (result.status === 'success') {
      pendingInboundImages.set(message.messageId, {
        messageId: message.messageId,
        tempDir: result.tempDir,
        filePath: result.filePath,
        createdAt: Date.now(),
      });
      return buildInboundImagePrompt(result.filePath);
    }

    process.stderr.write(`[lark-channel] Image staging ${result.status}: ${result.reason} (message=${message.messageId})\n`);
    return extractMessageText(message);
  }

  return extractMessageText(message);
}

async function startSocket(account: ResolvedLarkChannelConfig): Promise<void> {
  socketClient?.stop();
  socketState = 'starting';
  socketError = null;

  socketClient = new LarkWebSocketClient(account, async (message) => {
    await prunePendingInboundImages();

    if (!shouldForwardMessage(account, message)) {
      return;
    }

    await addTypingIndicator(account, message);

    if (await handlePseudoCommand(message)) {
      return;
    }

    const freshTopicKey = resolveFreshTopicKey(message);
    const pendingFreshTopic = freshTopicTargets.delete(freshTopicKey);
    const messageText = await buildForwardMessageText(account, message);
    const content = pendingFreshTopic
      ? buildFreshTopicPrompt(messageText)
      : messageText;

    server.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          source: 'lark-channel',
          user_id: message.senderId,
          message_id: message.messageId,
          chat_id: message.chatId,
          chat_type: message.chatType,
        },
      },
    });
  });

  try {
    await socketClient.start();
    socketState = 'running';
    socketError = null;
  } catch (error) {
    socketState = 'error';
    socketError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function extractMessageText(message: LarkMessage): string {
  if (message.messageType === 'text') {
    return message.text || '[空消息]';
  }
  if (message.messageType === 'image') {
    return '[图片]';
  }
  if (message.messageType === 'file') {
    return '[文件]';
  }
  if (message.messageType === 'audio') {
    return '[音频]';
  }
  if (message.messageType === 'video') {
    return '[视频]';
  }
  return `[${message.messageType}]`;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[lark-channel] MCP server started\n');

  const stored = getStoredChannelConfig();
  if (stored) {
    process.stderr.write(`[lark-channel] Found saved account: ${stored.appId}\n`);
    const resolved = getResolvedChannelConfig();
    if (!resolved) {
      process.stderr.write('[lark-channel] appSecret could not be resolved\n');
      return;
    }
    try {
      await startSocket(resolved);
    } catch (error) {
      process.stderr.write(`[lark-channel] Failed to start websocket: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  } else {
    process.stderr.write('[lark-channel] No saved account. Use the login tool to configure.\n');
  }
}

main().catch((error) => {
  process.stderr.write(`[lark-channel] Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
