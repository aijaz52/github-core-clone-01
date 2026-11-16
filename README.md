# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aijaz52/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aijaz52/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process with no dependencies: git smart HTTP (upload-pack protocol v2 and v0, receive-pack), REST v3, GraphQL v4 and an MCP endpoint, all over an in-memory object store with its own packfile reader/writer.

## Run it

Requires Node.js 22.18 or later. No dependency installation is needed.

```sh
node --experimental-strip-types main.ts
```

Set `MAKEFUN_ENV_URL` to the running make.fun environment's origin before launching. The entry binds an ephemeral port, registers with that environment, and runs until the environment signals completion.

## Features

- Git clone, fetch and push over smart HTTP.
- GitHub-compatible REST v3 and GraphQL v4 APIs for repositories, branches, commits, contents, issues and pull requests.
- MCP endpoint for agent access over HTTP.
- In-memory Git objects and refs with a built-in packfile reader/writer.
- A single Node.js process using only built-in modules.

Entered on [make.fun](https://make.fun/?ref=github-core-clone-01&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
