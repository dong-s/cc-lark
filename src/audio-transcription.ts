/**
 * 飞书音频本地离线转写（ffmpeg + whisper.cpp）
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LarkAPI } from './lark-api.js';
import type { LarkMessage } from './types.js';

const execFileAsync = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 2 * 60 * 1000;
const WHISPER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MODEL_FILENAME = 'ggml-base.bin';
const DEFAULT_MODEL_CACHE_DIR = join(homedir(), '.claude', 'channels', 'lark', 'models');

export type AudioTranscriptionResult =
  | { status: 'success'; transcript: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

function resolveCommand(envName: string, fallback: string): string {
  const configured = process.env[envName]?.trim();
  return configured || fallback;
}

function resolveConfiguredModelPath(): string | undefined {
  const configured = process.env.WHISPER_MODEL_PATH?.trim();
  if (!configured) {
    return undefined;
  }
  return existsSync(configured) ? configured : undefined;
}

function resolveModelCacheDir(): string {
  const configured = process.env.WHISPER_MODEL_CACHE_DIR?.trim();
  return configured || DEFAULT_MODEL_CACHE_DIR;
}

function resolveDefaultModelPath(): string | undefined {
  const defaultModelPath = join(resolveModelCacheDir(), DEFAULT_MODEL_FILENAME);
  return existsSync(defaultModelPath) ? defaultModelPath : undefined;
}

function buildSkipped(reason: string): AudioTranscriptionResult {
  return { status: 'skipped', reason };
}

function buildFailed(reason: string): AudioTranscriptionResult {
  return { status: 'failed', reason };
}

function isMissingCommandError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function normalizeTranscript(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function resolveModelPath(): string | undefined {
  return resolveConfiguredModelPath() || resolveDefaultModelPath();
}

async function transcodeToWav(sourcePath: string, wavPath: string): Promise<void> {
  const ffmpegCommand = resolveCommand('FFMPEG_PATH', 'ffmpeg');
  await execFileAsync(
    ffmpegCommand,
    ['-y', '-i', sourcePath, '-ac', '1', '-ar', '16000', wavPath],
    {
      timeout: FFMPEG_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
    },
  );
}

async function runWhisper(wavPath: string, outputPrefix: string, modelPath: string): Promise<string> {
  const whisperCommand = resolveCommand('WHISPER_CLI_PATH', 'whisper-cli');

  await execFileAsync(
    whisperCommand,
    ['-m', modelPath, '-f', wavPath, '-otxt', '-of', outputPrefix],
    {
      timeout: WHISPER_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
    },
  );

  const transcript = normalizeTranscript(await readFile(`${outputPrefix}.txt`, 'utf8'));
  if (!transcript) {
    throw new Error('empty_transcript');
  }

  return transcript;
}

export async function transcribeAudioMessage(api: LarkAPI, message: LarkMessage): Promise<AudioTranscriptionResult> {
  if (message.messageType !== 'audio') {
    return buildSkipped('not_audio_message');
  }

  if (!message.audio?.fileKey) {
    return buildSkipped('missing_file_key');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'cc-lark-audio-'));
  const sourcePath = join(tempDir, 'source-audio');
  const wavPath = join(tempDir, 'audio.wav');
  const outputPrefix = join(tempDir, 'transcript');

  const modelPath = resolveModelPath();
  if (!modelPath) {
    return buildSkipped('missing_model_file');
  }

  try {
    const downloaded = await api.downloadMessageResource(message.messageId, message.audio.fileKey, sourcePath);
    const fileStats = await stat(downloaded.filePath);
    if (fileStats.size > MAX_AUDIO_FILE_BYTES) {
      return buildSkipped(`audio_too_large:${fileStats.size}`);
    }

    await transcodeToWav(downloaded.filePath, wavPath);
    const transcript = await runWhisper(wavPath, outputPrefix, modelPath);
    return { status: 'success', transcript };
  } catch (error) {
    if (isMissingCommandError(error)) {
      const missingCommand = 'path' in error && typeof error.path === 'string' ? error.path : 'command';
      return buildSkipped(`missing_command:${missingCommand}`);
    }

    const reason = extractErrorMessage(error);
    if (reason === 'empty_transcript') {
      return buildFailed('empty_transcript');
    }

    return buildFailed(reason);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
