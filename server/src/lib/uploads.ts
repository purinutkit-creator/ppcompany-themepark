import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { config } from '../config';
import { badRequest } from './errors';

export const UPLOAD_KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  video: ['.mp4', '.webm'],
  font: ['.ttf', '.otf', '.woff', '.woff2'],
} as const;
export type UploadKind = keyof typeof UPLOAD_KINDS;

export function uploadRoot() {
  return path.resolve(config.uploadDir);
}

/** Persist an uploaded file under UPLOAD_DIR/<kind>/<yyyy-mm>/<random><ext> and return its public URL. */
export async function saveUpload(file: MultipartFile, kinds: UploadKind[]): Promise<{ url: string; ext: string; size: number; filename: string }> {
  const ext = path.extname(file.filename).toLowerCase();
  const kind = kinds.find((k) => (UPLOAD_KINDS[k] as readonly string[]).includes(ext));
  if (!kind) throw badRequest('UNSUPPORTED_FILE_TYPE', `Allowed: ${kinds.flatMap((k) => UPLOAD_KINDS[k]).join(', ')}`);
  const month = new Date().toISOString().slice(0, 7);
  const dir = path.join(uploadRoot(), kind, month);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}${ext}`;
  const dest = path.join(dir, name);
  await pipeline(file.file, fs.createWriteStream(dest));
  if (file.file.truncated) {
    await fs.promises.unlink(dest).catch(() => {});
    throw badRequest('FILE_TOO_LARGE');
  }
  const size = (await fs.promises.stat(dest)).size;
  return { url: `/uploads/${kind}/${month}/${name}`, ext: ext.slice(1), size, filename: file.filename };
}
