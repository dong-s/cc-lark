/**
 * 飞书/Lark Open API 封装（官方 SDK）
 */

import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { DownloadedMessageResource, ResolvedLarkChannelConfig } from './types.js';

const TYPING_EMOJI_TYPE = 'Typing';

function resolveDomain(domain: ResolvedLarkChannelConfig['domain']): Lark.Domain {
  return domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

function mapFileType(filePath: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.mp4') {
    return 'mp4';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext === '.doc' || ext === '.docx') {
    return 'doc';
  }
  if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') {
    return 'xls';
  }
  if (ext === '.ppt' || ext === '.pptx') {
    return 'ppt';
  }
  if (ext === '.opus') {
    return 'opus';
  }
  return 'stream';
}

function buildMarkdownPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

export class LarkAPI {
  private readonly client: Lark.Client;

  constructor(config: ResolvedLarkChannelConfig) {
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: resolveDomain(config.domain),
    });
  }

  async sendText(receiveId: string, text: string): Promise<string> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: 'user_id' },
      data: {
        receive_id: receiveId,
        msg_type: 'post',
        content: buildMarkdownPostContent(text),
      },
    });

    if (response?.code !== 0 || !response.data?.message_id) {
      throw new Error(`发送文本失败: ${response?.msg || 'unknown error'}`);
    }

    return response.data.message_id;
  }

  async replyText(messageId: string, text: string): Promise<string> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'post',
        content: buildMarkdownPostContent(text),
      },
    });

    if (response?.code !== 0 || !response.data?.message_id) {
      throw new Error(`回复文本失败: ${response?.msg || 'unknown error'}`);
    }

    return response.data.message_id;
  }

  async updateText(messageId: string, text: string): Promise<string> {
    const response = await this.client.im.v1.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: 'post',
        content: buildMarkdownPostContent(text),
      },
    });

    if (response?.code !== 0 || !response.data?.message_id) {
      throw new Error(`编辑消息失败: ${response?.msg || 'unknown error'}`);
    }

    return response.data.message_id;
  }

  async deleteMessage(messageId: string): Promise<void> {
    const response = await this.client.im.v1.message.delete({
      path: { message_id: messageId },
    });

    if (response?.code !== 0) {
      throw new Error(`撤回消息失败: ${response?.msg || 'unknown error'}`);
    }
  }

  async sendFile(receiveId: string, filePath: string, fileType: 'image' | 'file' = 'file'): Promise<string> {
    const uploadedKey = fileType === 'image'
      ? await this.uploadImage(filePath)
      : await this.uploadFile(filePath);

    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: 'user_id' },
      data: {
        receive_id: receiveId,
        msg_type: fileType,
        content: JSON.stringify(fileType === 'image' ? { image_key: uploadedKey } : { file_key: uploadedKey }),
      },
    });

    if (response?.code !== 0 || !response.data?.message_id) {
      throw new Error(`发送文件失败: ${response?.msg || 'unknown error'}`);
    }

    return response.data.message_id;
  }

  async addTypingIndicator(messageId: string): Promise<string | null> {
    const response = await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: {
          emoji_type: TYPING_EMOJI_TYPE,
        },
      },
    });

    if (response?.code !== 0) {
      throw new Error(`添加 typing reaction 失败: ${response?.msg || 'unknown error'}`);
    }

    return response.data?.reaction_id ?? null;
  }

  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    targetFilePath: string,
    resourceType: 'file' | 'image' = 'file',
  ): Promise<DownloadedMessageResource> {
    const response = await this.client.im.v1.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: resourceType,
      },
    });

    await response.writeFile(targetFilePath);

    return {
      filePath: targetFilePath,
      headers: response.headers as Record<string, string | string[] | undefined>,
    };
  }

  async removeTypingIndicator(messageId: string, reactionId: string): Promise<void> {
    const response = await this.client.im.v1.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    });

    if (response?.code !== 0) {
      throw new Error(`移除 typing reaction 失败: ${response?.msg || 'unknown error'}`);
    }
  }

  private async uploadImage(filePath: string): Promise<string> {
    const response = await this.client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: createReadStream(filePath),
      },
    });

    if (!response?.image_key) {
      throw new Error('上传图片失败: missing image_key');
    }

    return response.image_key;
  }

  private async uploadFile(filePath: string): Promise<string> {
    const response = await this.client.im.v1.file.create({
      data: {
        file_type: mapFileType(filePath),
        file_name: basename(filePath),
        file: createReadStream(filePath),
      },
    });

    if (!response?.file_key) {
      throw new Error('上传文件失败: missing file_key');
    }

    return response.file_key;
  }
}
