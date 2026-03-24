#!/usr/bin/env node
/**
 * cc-lark CLI
 */

import { validateCredentials } from './auth.js';
import {
  DEFAULT_JSON_POINTER,
  DEFAULT_SECRETS_FILE,
  describeSecretInput,
  resolveSecretValue,
  storeSecretValue,
} from './secret-ref.js';
import {
  createDefaultChannelConfig,
  getResolvedChannelConfig,
  getStatePath,
  getStoredChannelConfig,
  loadState,
  saveState,
} from './store.js';
import type { LarkDomain, SecretInputMode, StoredLarkChannelState } from './types.js';

function printHelp(): void {
  console.log(`cc-lark

Usage:
  cc-lark config <appId> <appSecret> [domain] [secretMode]
  cc-lark status
  cc-lark info
  cc-lark doctor

Commands:
  config    Save and validate Lark/Feishu app credentials
  status    Show whether credentials are configured
  info      Show current channel configuration summary
  doctor    Validate current configuration and secret resolution

Arguments:
  domain      feishu (default) or lark
  secretMode  plaintext (default) or file`);
}

function parseDomain(value: string | undefined): LarkDomain {
  return value === 'lark' ? 'lark' : 'feishu';
}

function parseSecretMode(value: string | undefined): SecretInputMode {
  return value === 'file' ? 'file' : 'plaintext';
}

function ensureState(): StoredLarkChannelState {
  return loadState() ?? { channel: createDefaultChannelConfig() };
}

async function runDoctor(): Promise<number> {
  const state = loadState();
  if (!state?.channel) {
    console.log('[FAIL] 未找到配置');
    return 1;
  }

  const channel = state.channel;
  let failed = false;

  if (!channel.appId) {
    console.log('[FAIL] 缺少 appId');
    failed = true;
  }

  if (!channel.appSecret) {
    console.log('[FAIL] 缺少 appSecret');
    failed = true;
  }

  let resolvedSecret: string | undefined;
  try {
    resolvedSecret = resolveSecretValue(channel.appSecret, state);
    if (!resolvedSecret) {
      console.log('[FAIL] appSecret 无法解析');
      failed = true;
    }
  } catch (error) {
    console.log(`[FAIL] appSecret 解析失败: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }

  if (!failed && resolvedSecret) {
    try {
      await validateCredentials({
        appId: channel.appId,
        appSecret: resolvedSecret,
        domain: channel.domain,
      });
      console.log('[PASS] 凭证校验成功');
    } catch (error) {
      console.log(`[FAIL] 凭证校验失败: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
  }

  if (!failed) {
    console.log('[PASS] 配置正常');
    return 0;
  }

  return 1;
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'status') {
    const channel = getStoredChannelConfig();
    if (!channel) {
      console.log('未配置账号');
      process.exitCode = 1;
      return;
    }

    console.log(`已配置: ${channel.appId} (${channel.domain})`);
    return;
  }

  if (command === 'info') {
    const state = loadState();
    if (!state?.channel) {
      console.log('未配置账号');
      process.exitCode = 1;
      return;
    }

    const channel = state.channel;
    console.log(JSON.stringify({
      statePath: getStatePath(),
      enabled: channel.enabled,
      appId: channel.appId,
      appSecretMode: describeSecretInput(channel.appSecret),
      domain: channel.domain,
      connectionMode: channel.connectionMode,
      requireMention: channel.requireMention,
      dmPolicy: channel.dmPolicy,
      groupPolicy: channel.groupPolicy,
      allowFromCount: channel.allowFrom.length,
      groupAllowFromCount: channel.groupAllowFrom.length,
      groups: channel.groups,
      savedAt: channel.savedAt,
    }, null, 2));
    return;
  }

  if (command === 'doctor') {
    process.exitCode = await runDoctor();
    return;
  }

  if (command === 'config') {
    const [appId, appSecret, domainArg, secretModeArg] = args;
    const domain = parseDomain(domainArg);
    const secretMode = parseSecretMode(secretModeArg);

    if (!appId || !appSecret) {
      printHelp();
      process.exitCode = 1;
      return;
    }

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
      savedAt: new Date().toISOString(),
    };

    saveState(state);
    console.log(`配置成功: ${appId} (${domain}, secret=${secretMode})`);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`错误: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
