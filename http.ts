// http.ts — the HTTP plumbing every surface shares: the per-request context (who the caller
// is, whether the trial token checked out), body reading with a sane cap, and JSON replies.
// Nothing here knows about git, REST shapes, GraphQL or MCP; app.ts routes to those modules.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** What a surface handler needs about the request before it looks at the route. */
export interface Ctx {
  /** True when the request carried the trial's bearer token (or no token is configured). */
  authed: boolean;
  /** The request's authority (host[:port]) — pagination links and clone URLs stay on origin. */
  host: string;
  /** Monotonic per-process request counter: the X-GitHub-Request-Id source. Deterministic. */
  requestSeq: number;
}

const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** Read a whole request body (packs included), refusing anything past the cap. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Send a pre-encoded body with an exact content type. */
export function sendBody(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

/** Send a JSON reply. `undefined` bodies become an empty body (204-style answers). */
export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  if (value === undefined) {
    res.writeHead(status, { 'content-length': 0, ...extraHeaders });
    res.end();
    return;
  }
  sendBody(res, status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json; charset=utf-8', extraHeaders);
}

/** The JSON error shape every surface agrees on: an object with a string `message`. */
export function errorBody(message: string): { message: string } {
  return { message };
}
