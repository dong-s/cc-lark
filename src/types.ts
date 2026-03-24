/**
 * cc-lark 类型定义
 */

export type LarkDomain = 'feishu' | 'lark';
export type ConnectionMode = 'websocket';
export type MessageType = 'text' | 'image' | 'file' | 'audio' | 'video' | 'media' | 'reaction';
export type DmPolicy = 'open' | 'pairing' | 'allowlist';
export type GroupPolicy = 'open' | 'allowlist';
export type SecretInputMode = 'plaintext' | 'file';

export interface SecretRef {
  source: 'file';
  provider: string;
  id: string;
}

export type SecretInput = string | SecretRef;

export interface SecretProvider {
  source: 'file';
  path: string;
}

export interface GroupSettings {
  enabled: boolean;
  requireMention?: boolean;
}

export interface LarkChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret?: SecretInput;
  domain: LarkDomain;
  connectionMode: ConnectionMode;
  requireMention: boolean;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  groups: Record<string, GroupSettings>;
  savedAt: string;
}

export interface StoredLarkChannelState {
  channel: LarkChannelConfig;
  secrets?: {
    providers?: Record<string, SecretProvider>;
  };
}

export interface ResolvedLarkChannelConfig extends Omit<LarkChannelConfig, 'appSecret'> {
  appSecret: string;
}

export interface LarkMention {
  key?: string;
  name?: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
}

export interface LarkAudioContent {
  fileKey: string;
  duration?: number;
}

export interface LarkImageContent {
  imageKey: string;
}

export interface DownloadedMessageResource {
  filePath: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface LarkMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group' | 'unknown';
  senderId: string;
  senderType: 'user' | 'app' | 'unknown';
  messageType: MessageType;
  content: string;
  text: string;
  mentions: LarkMention[];
  hasMention: boolean;
  createTime: number;
  parentId?: string;
  audio?: LarkAudioContent;
  image?: LarkImageContent;
  reactionEmoji?: string;
  reactionAction?: 'created' | 'deleted';
}

export interface TokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

export interface SendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id: string;
  };
}

export interface UploadFileResponse {
  code: number;
  msg: string;
  data?: {
    file_key: string;
    image_key?: string;
  };
}

export interface LarkMessageEvent {
  app_id?: string;
  sender?: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message?: {
    message_id: string;
    chat_id: string;
    chat_type?: string;
    message_type: string;
    content: string;
    mentions?: LarkMention[];
    create_time: string | number;
    parent_id?: string;
    root_id?: string;
    thread_id?: string;
  };
}

export interface LarkReactionEvent {
  app_id?: string;
  message_id?: string;
  reaction_id?: string;
  reaction_type?: {
    emoji_type: string;
  };
  operator_type?: string;
  user_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  action_time?: string;
}

export interface TypingIndicatorState {
  messageId: string;
  reactionId: string;
  createdAt: number;
}
