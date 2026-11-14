# github-core-clone-01

A standalone GitHub-compatible git forge in a single Node process — no UI, no database, no
outside service, no subprocesses. It speaks the four surfaces GitHub clients use:

- **Git smart HTTP** (`/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack`):
  protocol v0 and v2 (`ls-refs`, `fetch`), packfile read/write with OFS/REF delta support,
  shallow fetch and deepen, side-band progress framing, report-status push results with
  per-ref accept/reject semantics, fast-forward enforcement and annotated tags.
- **REST v3** (`/api/v3`): repositories (create/read/patch/delete, Link-header pagination),
  contents (get/put/delete with blob-sha optimistic concurrency), branches, commits, git
  refs, labels, issues and comments, pull requests (create/list/get/files/merge with real
  three-way merges — squash or merge commit), plus the root document and `/meta`.
- **GraphQL v4** (`/api/graphql`): viewer/repository/node lookups, issue and pull-request
  connections with cursor pagination and state filters, the create/close/reopen issue,
  create/merge pull-request and add-comment mutations, Relay global ids, operation
  batching, and the `__type`/`__schema` introspection shapes `gh` probes.
- **MCP** (`/mcp`): stateless JSON-RPC 2.0 in both protocol eras (`server/discover` and
  `initialize`), with `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request` tools returning REST-shaped results.

State lives in memory: a content-addressed git object store (SHA-1, zlib) plus repository,
issue and pull-request records. Timestamps and ids are deterministic — a logical clock
seeded from the trial clock — so identical request sequences produce identical bytes.

## Running

Requires Node 22.18+ (the trial harness runs `node main.ts` directly; TypeScript uses only
erasable syntax). The process requires `MAKEFUN_ENV_URL` to be set: it listens on an
ephemeral port, registers it with the environment, and exits 0 when the environment
reports the trial is done. API and git requests authenticate with
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN` when that variable is set.

## Layout

- `main.ts` — entrypoint: lifecycle (register, poll, exit).
- `app.ts` — HTTP server and routing.
- `forge.ts` — identity, logical clock, object store, records, merge machinery.
- `git.ts` — pkt-lines, packfiles, advertisements, upload-pack and receive-pack.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — lexer, parser and executor for the GraphQL subset.
- `mcp.ts` — the MCP JSON-RPC surface.
- `http.ts` — shared HTTP plumbing.

## License

MIT — see `LICENSE` (`SPDX-License-Identifier: MIT`).
