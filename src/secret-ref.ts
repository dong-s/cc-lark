/**
 * SecretRef 风格的 secret 存储与解析
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SecretInput, SecretInputMode, SecretRef, StoredLarkChannelState } from './types.js';

export const DEFAULT_FILE_PROVIDER_NAME = 'lark-secrets';
export const DEFAULT_JSON_POINTER = '/lark/appSecret';
export const DEFAULT_SECRETS_FILE = '~/.claude/channels/lark/lark.secrets.json';

export function isSecretRef(value: unknown): value is SecretRef {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as SecretRef).source === 'file' &&
    typeof (value as SecretRef).provider === 'string' &&
    typeof (value as SecretRef).id === 'string',
  );
}

export function resolveUserPath(filePath: string): string {
  if (filePath === '~') {
    return homedir();
  }

  if (filePath.startsWith('~/')) {
    return join(homedir(), filePath.slice(2));
  }

  return resolve(filePath);
}

export function ensureDirSecure(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(dirPath, 0o700);
  }
}

export function isPermissionSecure(mode: number): boolean {
  return (mode & 0o077) === 0;
}

export function getByJsonPointer(obj: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') {
    return obj;
  }

  const tokens = pointer.split('/').slice(1);
  let current = obj as Record<string, unknown> | undefined;

  for (const token of tokens) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }
    current = current[key] as Record<string, unknown> | undefined;
  }

  return current;
}

export function setByJsonPointer(obj: Record<string, unknown>, pointer: string, value: string): void {
  const tokens = pointer.split('/').slice(1);
  let current: Record<string, unknown> = obj;

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const key = tokens[index].replace(/~1/g, '/').replace(/~0/g, '~');
    const existing = current[key];
    if (!existing || typeof existing !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = tokens[tokens.length - 1].replace(/~1/g, '/').replace(/~0/g, '~');
  current[lastKey] = value;
}

export function writeSecretToFile(params: {
  secretValue: string;
  filePath?: string;
  jsonPointer?: string;
}): SecretRef {
  const filePath = resolveUserPath(params.filePath ?? DEFAULT_SECRETS_FILE);
  const jsonPointer = params.jsonPointer ?? DEFAULT_JSON_POINTER;
  ensureDirSecure(dirname(filePath));

  let data: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }

  setByJsonPointer(data, jsonPointer, params.secretValue);
  writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }

  return {
    source: 'file',
    provider: DEFAULT_FILE_PROVIDER_NAME,
    id: jsonPointer,
  };
}

export function ensureFileProviderInState(
  state: StoredLarkChannelState,
  filePath: string,
  providerName = DEFAULT_FILE_PROVIDER_NAME,
): void {
  if (!state.secrets) {
    state.secrets = {};
  }

  if (!state.secrets.providers) {
    state.secrets.providers = {};
  }

  state.secrets.providers[providerName] = {
    source: 'file',
    path: filePath,
  };
}

export function resolveSecretValue(input: SecretInput | undefined, state: StoredLarkChannelState): string | undefined {
  if (!input) {
    return undefined;
  }

  if (typeof input === 'string') {
    return input;
  }

  const provider = state.secrets?.providers?.[input.provider];
  if (!provider || provider.source !== 'file') {
    return undefined;
  }

  const filePath = resolveUserPath(provider.path);
  if (!existsSync(filePath)) {
    return undefined;
  }

  if (process.platform !== 'win32') {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`secret file must not be a symlink: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`secret file must be a regular file: ${filePath}`);
    }
    if (!isPermissionSecure(stat.mode)) {
      throw new Error(`secret file permissions are too open: ${filePath}`);
    }
  }

  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const value = getByJsonPointer(raw, input.id);
  return typeof value === 'string' ? value : undefined;
}

export function storeSecretValue(params: {
  secretValue: string;
  mode: SecretInputMode;
  state: StoredLarkChannelState;
  filePath?: string;
  jsonPointer?: string;
}): SecretInput {
  if (params.mode === 'plaintext') {
    return params.secretValue;
  }

  const resolvedPath = params.filePath ?? DEFAULT_SECRETS_FILE;
  const ref = writeSecretToFile({
    secretValue: params.secretValue,
    filePath: resolvedPath,
    jsonPointer: params.jsonPointer,
  });
  ensureFileProviderInState(params.state, resolvedPath, ref.provider);
  return ref;
}

export function describeSecretInput(input: SecretInput | undefined): string {
  if (!input) {
    return 'missing';
  }

  if (typeof input === 'string') {
    return 'plaintext';
  }

  return `file:${input.provider}:${input.id}`;
}
