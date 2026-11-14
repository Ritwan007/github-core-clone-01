// main.ts — the forge entrypoint. Starts the GitHub-compatible git forge on an ephemeral
// port, registers that port with the trial environment, and serves until the environment
// reports the trial is done; then it closes the server and exits 0.
//
// The forge itself lives in app.ts (routing), git.ts (smart HTTP), rest.ts (REST v3),
// graphql.ts (GraphQL v4) and mcp.ts (MCP tools) over the store in forge.ts — one process,
// no subprocesses, no outside services, Node's standard library only.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set; refusing to start');
  process.exit(1);
}

const base = envUrl.replace(/\/+$/, '');
const server = createApp();

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  console.error('could not determine the listening port');
  process.exit(1);
}
const port = address.port;
console.log(`forge listening on port ${port}`);

/** POST the chosen port to the environment; the first registration wins, so retry on any
 *  transient failure and accept a 409 (a registration is already on record) as success. */
async function register(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let delayMs = 100;
  for (;;) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok || response.status === 409) {
        console.log(`registered port ${port} (status ${response.status})`);
        return;
      }
      console.error(`register answered status ${response.status}; retrying`);
    } catch (error) {
      console.error(`register failed: ${error instanceof Error ? error.message : String(error)}; retrying`);
    }
    if (Date.now() > deadline) throw new Error('registration did not succeed within 60 seconds');
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 2_000);
  }
}

await register();

/** Poll the environment until it reports the trial is done; transient poll failures are
 *  ignored (the trial budget is enforced by the environment, not by this loop). */
async function waitUntilDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // A failed poll says nothing about the trial; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

await waitUntilDone();
console.log('trial done; shutting down');
await new Promise<void>((resolve) => {
  server.close(() => resolve());
});
process.exit(0);
