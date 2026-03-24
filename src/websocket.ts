/**
 * 飞书/Lark 长连接事件接收（官方 SDK）
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import type {
  LarkAudioContent,
  LarkDomain,
  LarkImageContent,
  LarkMention,
  LarkMessage,
  LarkMessageEvent,
  LarkReactionEvent,
  MessageType,
  ResolvedLarkChannelConfig,
} from './types.js';

function resolveDomain(domain: LarkDomain): Lark.Domain {
  return domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

type SdkLogger = {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
};

function createSdkLogger(): SdkLogger {
  return {
    error: (...msg: unknown[]) => process.stderr.write(`[lark-sdk:error] ${msg.map(String).join(' ')}\n`),
    warn: (...msg: unknown[]) => process.stderr.write(`[lark-sdk:warn] ${msg.map(String).join(' ')}\n`),
    info: (...msg: unknown[]) => process.stderr.write(`[lark-sdk:info] ${msg.map(String).join(' ')}\n`),
    debug: (...msg: unknown[]) => process.stderr.write(`[lark-sdk:debug] ${msg.map(String).join(' ')}\n`),
    trace: (...msg: unknown[]) => process.stderr.write(`[lark-sdk:trace] ${msg.map(String).join(' ')}\n`),
  };
}

function parseAudioContent(parsed: Record<string, unknown> | null): LarkAudioContent | undefined {
  if (!parsed || typeof parsed.file_key !== 'string' || !parsed.file_key.trim()) {
    return undefined;
  }

  const duration = typeof parsed.duration === 'number'
    ? parsed.duration
    : (typeof parsed.duration === 'string' ? Number(parsed.duration) : undefined);

  return {
    fileKey: parsed.file_key,
    duration: Number.isFinite(duration) ? duration : undefined,
  };
}

function parseImageContent(parsed: Record<string, unknown> | null): LarkImageContent | undefined {
  if (!parsed || typeof parsed.image_key !== 'string' || !parsed.image_key.trim()) {
    return undefined;
  }

  return {
    imageKey: parsed.image_key,
  };
}

function parseContent(
  raw: string,
  messageType: MessageType,
  mentionsFromEvent: LarkMention[] | undefined,
): { text: string; mentions: LarkMention[]; audio?: LarkAudioContent; image?: LarkImageContent } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : (typeof parsed.content === 'string' ? parsed.content : raw),
      mentions: Array.isArray(mentionsFromEvent)
        ? mentionsFromEvent
        : (Array.isArray(parsed.mentions) ? parsed.mentions as LarkMention[] : []),
      audio: messageType === 'audio' ? parseAudioContent(parsed) : undefined,
      image: messageType === 'image' ? parseImageContent(parsed) : undefined,
    };
  } catch {
    return {
      text: raw,
      mentions: Array.isArray(mentionsFromEvent) ? mentionsFromEvent : [],
      audio: undefined,
      image: undefined,
    };
  }
}

function normalizeMessageType(value: string): MessageType | null {
  if (value === 'text' || value === 'image' || value === 'file' || value === 'audio' || value === 'video' || value === 'media' || value === 'reaction') {
    return value;
  }
  return null;
}

function normalizeSenderType(value: string | undefined): 'user' | 'app' | 'unknown' {
  if (value === 'user' || value === 'app') {
    return value;
  }
  return 'unknown';
}

function normalizeChatType(value: string | undefined): 'p2p' | 'group' | 'unknown' {
  if (value === 'p2p' || value === 'group') {
    return value;
  }
  return 'unknown';
}

function toLarkMessage(event: LarkMessageEvent): LarkMessage | null {
  const rawMessage = event.message;
  const rawSender = event.sender;
  if (!rawMessage || !rawSender?.sender_id) {
    return null;
  }

  const messageType = normalizeMessageType(rawMessage.message_type);
  if (!messageType) {
    return null;
  }

  const parsed = parseContent(rawMessage.content, messageType, rawMessage.mentions);
  const mentions = parsed.mentions;
  const hasMention = mentions.length > 0 || /<at\b/i.test(rawMessage.content);

  return {
    messageId: rawMessage.message_id,
    chatId: rawMessage.chat_id,
    chatType: normalizeChatType(rawMessage.chat_type),
    senderId: rawSender.sender_id.user_id ?? rawSender.sender_id.open_id ?? rawSender.sender_id.union_id ?? '',
    senderType: normalizeSenderType(rawSender.sender_type),
    messageType,
    content: rawMessage.content,
    text: parsed.text,
    mentions,
    hasMention,
    createTime: Number(rawMessage.create_time),
    parentId: rawMessage.parent_id,
    audio: parsed.audio,
    image: parsed.image,
  };
}

function toReactionMessage(event: LarkReactionEvent, action: 'created' | 'deleted'): LarkMessage | null {
  if (!event.message_id || !event.reaction_type?.emoji_type) {
    return null;
  }

  const senderId = event.user_id?.user_id ?? event.user_id?.open_id ?? event.user_id?.union_id ?? '';
  if (!senderId) {
    return null;
  }

  return {
    messageId: event.message_id,
    chatId: '',
    chatType: 'unknown',
    senderId,
    senderType: normalizeSenderType(event.operator_type),
    messageType: 'reaction',
    content: event.reaction_type.emoji_type,
    text: `[reaction:${action}] ${event.reaction_type.emoji_type}`,
    mentions: [],
    hasMention: false,
    createTime: Number(event.action_time),
    reactionEmoji: event.reaction_type.emoji_type,
    reactionAction: action,
  };
}

export class LarkWebSocketClient {
  private readonly config: ResolvedLarkChannelConfig;
  private readonly onMessage: (message: LarkMessage) => Promise<void> | void;
  private readonly logger: SdkLogger;
  private wsClient: Lark.WSClient | null;

  constructor(config: ResolvedLarkChannelConfig, onMessage: (message: LarkMessage) => Promise<void> | void) {
    this.config = config;
    this.onMessage = onMessage;
    this.logger = createSdkLogger();
    this.wsClient = null;
  }

  async start(): Promise<void> {
    this.stop();

    const dispatcher = new Lark.EventDispatcher({
      logger: this.logger,
      loggerLevel: Lark.LoggerLevel.info,
    }).register({
      'im.message.receive_v1': async (data: unknown) => {
        const message = toLarkMessage(data as LarkMessageEvent);
        if (!message) {
          return;
        }
        await this.onMessage(message);
      },
      'im.message.reaction.created_v1': async (data: unknown) => {
        const message = toReactionMessage(data as LarkReactionEvent, 'created');
        if (!message) {
          return;
        }
        await this.onMessage(message);
      },
      'im.message.reaction.deleted_v1': async (data: unknown) => {
        const message = toReactionMessage(data as LarkReactionEvent, 'deleted');
        if (!message) {
          return;
        }
        await this.onMessage(message);
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: resolveDomain(this.config.domain),
      logger: this.logger,
      loggerLevel: Lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  stop(): void {
    if (this.wsClient) {
      this.wsClient.close({ force: true });
      this.wsClient = null;
    }
  }
}
