import path from 'node:path';
import { AppError } from './errors.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function matchesMagicBytes(ext: string, buffer: Buffer): boolean {
  if (buffer.byteLength < 12) return false;
  if (ext === '.jpg' || ext === '.jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (ext === '.png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }
  if (ext === '.webp') {
    const riff = buffer.subarray(0, 4).toString('ascii') === 'RIFF';
    const webp = buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    return riff && webp;
  }
  return false;
}

/**
 * Validate uploaded image extension, size limit, and real binary magic bytes.
 * Returns normalized extension on success, or throws AppError.
 */
export function validateUploadedImage(filename: string, buffer: Buffer): string {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new AppError(400, 'INVALID_FILE_TYPE', '仅支持 jpg/jpeg/png/webp 格式图片');
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError(400, 'FILE_TOO_LARGE', '图片大小不能超过 5MB');
  }
  if (!matchesMagicBytes(ext, buffer)) {
    throw new AppError(400, 'INVALID_IMAGE_CONTENT', '文件内容与图片格式不匹配，请上传真实图片');
  }
  return ext;
}
