/**
 * cc-lark 配置持久化
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveSecretValue } from './secret-ref.js';
import type {
  LarkChannelConfig,
  ResolvedLarkChannelConfig,
  StoredLarkChannelState,
} from './types.js';

const STATE_FILE = 'channel.json';

export function getStateDir(): string {
  const dir = join(homedir(), '.claude', 'channels', 'lark');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getStatePath(): string {
  return join(getStateDir(), STATE_FILE);
}

export function createDefaultChannelConfig(): LarkChannelConfig {
  return {
    enabled: true,
    appId: '',
    appSecret: undefined,
    domain: 'feishu',
    connectionMode: 'websocket',
    requireMention: true,
    dmPolicy: 'open',
    groupPolicy: 'open',
    allowFrom: [],
    groupAllowFrom: [],
    groups: {},
    savedAt: new Date().toISOString(),
  };
}

export function saveState(state: StoredLarkChannelState): void {
  const dir = getStateDir();
  const tmpPath = join(dir, `${STATE_FILE}.tmp`);
  const finalPath = join(dir, STATE_FILE);
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmpPath, finalPath);
}

export function loadState(): StoredLarkChannelState | null {
  try {
    const raw = readFileSync(getStatePath(), 'utf-8');
    return JSON.parse(raw) as StoredLarkChannelState;
  } catch {
    return null;
  }
}

export function getStoredChannelConfig(): LarkChannelConfig | null {
  return loadState()?.channel ?? null;
}

export function getResolvedChannelConfig(): ResolvedLarkChannelConfig | null {
  const state = loadState();
  if (!state?.channel) {
    return null;
  }

  const appSecret = resolveSecretValue(state.channel.appSecret, state);
  if (!appSecret) {
    return null;
  }

  return {
    ...state.channel,
    appSecret,
  };
}
