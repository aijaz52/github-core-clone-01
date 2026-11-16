# GitHub Core Clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aijaz52/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aijaz52/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A self-contained, GitHub-compatible forge implementing Git smart HTTP, REST v3, GraphQL v4, and MCP over one deterministic store. Built for the [Make.fun GitHub-compatible git forge bounty](https://make.fun/bounty/github-core-clone-01).

## Run

Requires Node.js 22. In the Make.fun trial environment, run:

```sh
node main.ts
```

The trial provides `MAKEFUN_ENV_URL`; the service binds an ephemeral port, registers it with the trial environment, and exits after the suite reports completion.

The implementation uses Node.js built-ins and does not require a Git binary or external service.
