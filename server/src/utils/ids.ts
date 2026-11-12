import crypto from 'crypto';

/**
 * 24-hex id (4-byte timestamp + 8 random bytes), the same layout as the ids
 * already stored, so existing /job/<id> links and imported data keep working,
 * and sorting by id still means "newest last".
 */
export const newObjectId = (): string => {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  return ts + crypto.randomBytes(8).toString('hex');
};

export const isObjectId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);
