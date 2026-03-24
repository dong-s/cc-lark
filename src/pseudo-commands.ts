export type LarkPseudoCommandName = 'help' | 'status' | 'new' | 'clear' | 'compact';

export interface LarkPseudoCommand {
  name: LarkPseudoCommandName;
}

export interface LarkPseudoStatusSnapshot {
  appId?: string;
  domain?: string;
  enabled: boolean;
  requireMention?: boolean;
  dmPolicy?: string;
  groupPolicy?: string;
  socketState: 'stopped' | 'starting' | 'running' | 'error';
  socketError?: string;
  hasResolvedSecret: boolean;
  pendingFreshTopic: boolean;
  typingIndicatorCount: number;
  savedAt?: string;
}

export function parsePseudoCommand(text: string): LarkPseudoCommand | null {
  const normalized = text.trim();
  if (!normalized.startsWith('/')) {
    return null;
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length !== 1) {
    return null;
  }

  const command = parts[0].toLowerCase();
  if (command === '/help') {
    return { name: 'help' };
  }
  if (command === '/status') {
    return { name: 'status' };
  }
  if (command === '/new') {
    return { name: 'new' };
  }
  if (command === '/clear') {
    return { name: 'clear' };
  }
  if (command === '/compact') {
    return { name: 'compact' };
  }

  return null;
}

export function buildPseudoCommandHelpText(): string {
  return [
    '当前支持的飞书侧伪命令：',
    '- `/help`：查看可用伪命令说明',
    '- `/status`：查看当前 channel 配置和连接状态',
    '- `/new`：把下一条消息按新话题转发给 Claude',
    '- `/clear`：等价于 `/new`，但不会真正调用 Claude Code 内建 `/clear`',
    '- `/compact`：触发一条“会话总结”请求，让 Claude 输出当前对话摘要',
    '',
    '说明：这些都是 lark-channel 自己实现的伪命令，不是 Claude Code CLI 原生命令。',
  ].join('\n');
}

export function buildPseudoCommandStatusText(snapshot: LarkPseudoStatusSnapshot): string {
  const lines = [
    '当前 lark-channel 状态：',
    `- app: ${snapshot.appId ?? '未配置'}`,
    `- domain: ${snapshot.domain ?? 'unknown'}`,
    `- enabled: ${snapshot.enabled ? 'true' : 'false'}`,
    `- socket: ${snapshot.socketState}`,
    `- secret: ${snapshot.hasResolvedSecret ? 'resolved' : 'missing'}`,
    `- dmPolicy: ${snapshot.dmPolicy ?? 'unknown'}`,
    `- groupPolicy: ${snapshot.groupPolicy ?? 'unknown'}`,
    `- requireMention: ${typeof snapshot.requireMention === 'boolean' ? String(snapshot.requireMention) : 'unknown'}`,
    `- pendingNewTopic: ${snapshot.pendingFreshTopic ? 'true' : 'false'}`,
    `- typingIndicators: ${snapshot.typingIndicatorCount}`,
  ];

  if (snapshot.savedAt) {
    lines.push(`- savedAt: ${snapshot.savedAt}`);
  }

  if (snapshot.socketError) {
    lines.push(`- lastSocketError: ${snapshot.socketError}`);
  }

  return lines.join('\n');
}

export function buildNewTopicAckText(): string {
  return '已切到新话题模式。你下一条消息我会按新话题转发给 Claude，不沿用前面的飞书对话上下文，除非你显式引用。';
}

export function buildClearAckText(): string {
  return '已按“新话题”处理。注意：这不是真正的 Claude Code `/clear`，只是让你下一条飞书消息按新话题转发。';
}

export function buildFreshTopicPrompt(messageText: string): string {
  return [
    '[Lark pseudo command: /new]',
    '请把下面这条用户消息当作一个新话题处理。除非用户显式引用之前的内容，否则不要依赖前面的飞书对话上下文。',
    '',
    '用户消息：',
    messageText,
  ].join('\n');
}

export function buildCompactPrompt(): string {
  return [
    '[Lark pseudo command: /compact]',
    '请用中文输出一份可继续工作的会话摘要。',
    '要求：',
    '1. 总结当前目标、已完成项、未完成项、关键文件和已知问题。',
    '2. 结构清晰，便于下一轮继续开发。',
    '3. 直接输出摘要，不要寒暄。',
  ].join('\n');
}
