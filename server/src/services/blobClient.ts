/* ============================================================================
 *  Minimal client for the xhostd Blob (an S3-compatible object store).
 *
 *  Only what the CV storage needs: put, get and delete one object, path-style
 *  addressing, requests signed with the standard "AWS4-HMAC-SHA256" scheme that
 *  every S3-compatible store expects (the scheme name is fixed by the protocol).
 *  No third-party SDK, so no vendor code ships with the app.
 * ========================================================================== */
import crypto from 'crypto';
import { Readable } from 'stream';

export interface BlobConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BlobObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
}

const sha256Hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding of one path segment, as the signing scheme requires.
const encodeSegment = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Signs one request. Adds `x-amz-date` to `headers` (it must be sent) and
 * returns the Authorization header value. `canonicalPath` is already encoded.
 */
export const signRequest = (r: {
  method: string; canonicalPath: string; query?: string; headers: Record<string, string>; payloadHash: string;
  date: Date; region: string; accessKeyId: string; secretAccessKey: string;
}): string => {
  const amzDate = r.date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const day = amzDate.slice(0, 8);
  r.headers['x-amz-date'] = amzDate;
  const names = Object.keys(r.headers).map((n) => n.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) lower[k.toLowerCase()] = v;
  const canonicalHeaders = names.map((n) => `${n}:${lower[n].trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [r.method, r.canonicalPath, r.query ?? '', canonicalHeaders, signedHeaders, r.payloadHash].join('\n');
  const scope = `${day}/${r.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + r.secretAccessKey, day);
  const kSigning = hmac(hmac(hmac(kDate, r.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
};

export class BlobClient {
  private readonly base: URL;

  constructor(private readonly cfg: BlobConfig) {
    this.base = new URL(cfg.endpoint.replace(/\/+$/, '') + '/');
  }

  private async request(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, contentType?: string): Promise<Response> {
    const basePath = this.base.pathname.replace(/\/+$/, '');
    const canonicalPath = `${basePath}/${encodeSegment(this.cfg.bucket)}/${key.split('/').map(encodeSegment).join('/')}`;
    const url = `${this.base.protocol}//${this.base.host}${canonicalPath}`;

    const payloadHash = sha256Hex(body ?? '');
    const headers: Record<string, string> = { host: this.base.host, 'x-amz-content-sha256': payloadHash };
    if (contentType) headers['content-type'] = contentType;
    const authorization = signRequest({
      method, canonicalPath, headers, payloadHash, date: new Date(),
      region: this.cfg.region, accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey,
    });

    const { host: _host, ...sent } = headers;
    const res = await fetch(url, {
      method,
      headers: {
        ...sent,
        authorization,
      },
      body: body ? new Uint8Array(body) : undefined,
    });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      // Status only: the store's response body is never logged or passed on.
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`blob ${method} failed: ${res.status}`);
    }
    return res;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.request('PUT', key, body, contentType);
    await res.body?.cancel().catch(() => undefined);
  }

  async get(key: string): Promise<BlobObject> {
    const res = await this.request('GET', key);
    if (!res.body) throw new Error('blob GET: empty body');
    const len = Number(res.headers.get('content-length'));
    return {
      body: Readable.fromWeb(res.body as any),
      contentType: res.headers.get('content-type') || undefined,
      contentLength: Number.isFinite(len) && len > 0 ? len : undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    await res.body?.cancel().catch(() => undefined);
  }
}
