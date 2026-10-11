/**
 * AES-256-GCM sealing for the server's secret store (electronShim's
 * safeStorage). Format: "mds1" | iv (12) | tag (16) | ciphertext.
 *
 * The tag length is pinned to 16 bytes and short buffers are refused: without
 * that, Node accepts a truncated tag, which weakens tamper detection.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = 'mds1';
const HEADER = 4 + 12 + 16;

export function seal(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from(MAGIC), iv, c.getAuthTag(), body]);
}

export function open(key: Buffer, buf: Buffer): string {
  if (buf.length < HEADER || buf.subarray(0, 4).toString() !== MAGIC) throw new Error('not a server-encrypted secret');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16), { authTagLength: 16 });
  d.setAuthTag(buf.subarray(16, HEADER));
  return Buffer.concat([d.update(buf.subarray(HEADER)), d.final()]).toString('utf8');
}
