/**
 * App 凭证校验（官方 SDK）
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import type { LarkDomain } from './types.js';

function resolveDomain(domain: LarkDomain): Lark.Domain {
  return domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

export async function validateCredentials(params: {
  appId: string;
  appSecret: string;
  domain: LarkDomain;
}): Promise<void> {
  const client = new Lark.Client({
    appId: params.appId,
    appSecret: params.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(params.domain),
  });

  const response = await client.auth.v3.tenantAccessToken.internal({
    data: {
      app_id: params.appId,
      app_secret: params.appSecret,
    },
  });

  if (response?.code !== 0) {
    throw new Error(`凭证无效: ${response?.msg || 'unknown error'}`);
  }
}
