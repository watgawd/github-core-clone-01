# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/watgawd/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/watgawd/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge — no UI, single process, standard
library only (Node 22, no dependencies, no git binary, no network).

It serves:

- **git smart HTTP** — protocol v2 upload-pack (`ls-refs`, `fetch`, shallow
  clones) and v0 receive-pack (`report-status`, `side-band-64k`,
  `delete-refs`), with a from-scratch packfile reader/writer and object
  store (SHA-1, zlib) — at `/{owner}/{repo}.git`.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests, including squash merges with
  real three-way merge/conflict detection.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, including introspection, cursor pagination,
  batched operations and the create/close/merge mutations.
- **MCP** at `/mcp` — Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the 2025-11-25 handshake fallback, and eight
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, `get_issue`, `list_repos`)
  acting on the same store as REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the harness env at
`$MAKEFUN_ENV_URL`, polls `/done`, and exits 0. The server in `app.ts`
holds all state in memory; the token owner is the login
`MAKEFUN_SHOP_TOKEN` names.

## Layout

- `main.ts` — entry lifecycle (bind, register, wait for done).
- `app.ts` — the whole forge: git protocol, REST, GraphQL, MCP.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

Built for the [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01)
on make.fun.
