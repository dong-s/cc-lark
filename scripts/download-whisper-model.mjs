import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL_FILENAME = 'ggml-base.bin';
const DEFAULT_CACHE_DIR = join(homedir(), '.claude', 'channels', 'lark', 'models');
const MODEL_CACHE_DIR = process.env.WHISPER_MODEL_CACHE_DIR?.trim() || DEFAULT_CACHE_DIR;
const MODEL_PATH = join(MODEL_CACHE_DIR, MODEL_FILENAME);
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCES = [
  {
    name: 'ModelScope',
    url: `https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/${MODEL_FILENAME}`,
  },
  {
    name: 'HuggingFace',
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILENAME}?download=true`,
  },
];

async function downloadToFile(url, targetPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const tempPath = `${targetPath}.part-${process.pid}-${Date.now()}`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }

    if (!response.body) {
      throw new Error('missing_response_body');
    }

    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(tempPath, { mode: 0o600 }),
    );
    await rename(tempPath, targetPath);
  } finally {
    clearTimeout(timeout);
    await rm(tempPath, { force: true });
  }
}

async function ensureModelInstalled() {
  if (existsSync(MODEL_PATH)) {
    console.log(`[cc-lark] whisper model already present: ${MODEL_PATH}`);
    return;
  }

  await mkdir(MODEL_CACHE_DIR, { recursive: true });

  const errors = [];
  for (const source of SOURCES) {
    try {
      console.log(`[cc-lark] downloading whisper model from ${source.name}...`);
      await downloadToFile(source.url, MODEL_PATH);
      console.log(`[cc-lark] whisper model ready: ${MODEL_PATH}`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${reason}`);
      console.warn(`[cc-lark] failed to download from ${source.name}: ${reason}`);
    }
  }

  console.warn('[cc-lark] whisper model download skipped. Audio transcription will fall back to [音频].');
  console.warn(`[cc-lark] download errors: ${errors.join(' | ')}`);
}

await ensureModelInstalled();
