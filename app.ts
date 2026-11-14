// app.ts — the HTTP front door: one server routing the git smart-HTTP endpoints, the REST v3
// API, the GraphQL endpoint and the MCP endpoint, with the bearer-token auth context and the
// uniform JSON error envelope. No framework; node:http only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { errorBody, sendBody, sendJson, type Ctx } from './http.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** The bearer token gate is active only when the harness provides MAKEFUN_SHOP_TOKEN. */
function isAuthed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match !== null && match[1] === expected;
}

export function createApp(): Server {
  let requestSeq = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    const ctx: Ctx = {
      authed: isAuthed(req),
      host: typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost',
      requestSeq,
    };
    void route(req, res, ctx).catch(() => {
      if (!res.headersSent) sendJson(res, 500, errorBody('Internal Server Error'));
      else if (!res.writableEnded) res.end();
    });
  });
  return server;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    sendBody(res, 200, Buffer.from(JSON.stringify({ status: 'ok' }), 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  if (pathname === '/api/graphql') {
    if (req.method !== 'POST') {
      sendJson(res, 404, errorBody('Not Found'));
      return;
    }
    await handleGraphQL(req, res, ctx);
    return;
  }
  if (pathname === '/mcp') {
    if (req.method !== 'POST') {
      sendJson(res, 404, errorBody('Not Found'));
      return;
    }
    await handleMcp(req, res, ctx);
    return;
  }
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    await handleRest(req, res, ctx, pathname, url.searchParams);
    return;
  }
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch !== null) {
    await handleGit(req, res, ctx, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] ?? '', url.searchParams);
    return;
  }
  sendJson(res, 404, errorBody('Not Found'));
}
