# paper

Runs pi's tools inside gVisor sandboxes, and gates every file change on human approval.

pi ships no sandbox by design (`docs/security.md`): its built-in tools call `node:fs` and spawn
shells directly on the host. This extension routes all of them through
[paper-api](../../../../../../paper-api)'s zones instead, each of which holds exactly one
dangerous capability.

| pi tool | Where it runs | What it can do |
|---|---|---|
| `read` `ls` `grep` `find` | a container with the staged tree mounted | read only; no network, no exec |
| `write` `edit` | host-side scratchpad, no process at all | stage a change; the real file needs approval |
| `bash`, `!` commands | a throwaway gVisor container per call | read the staged tree; no network, nothing persists |
| `fetch_url` | a container with **zero** filesystem mounts | reach the network; nothing local to exfiltrate |

## Setup

Needs Docker and gVisor registered as the `runsc` runtime (`sudo runsc install`).

```sh
cd packages/coding-agent/examples/extensions/paper
npm install --ignore-scripts
```

```sh
cd /path/to/project
pi -e /path/to/pi/packages/coding-agent/examples/extensions/paper
```

Check it end to end without an LLM — it exercises every operation against real zones and asserts
the properties below:

```sh
node_modules/.bin/tsx --tsconfig tsconfig.json \
  packages/coding-agent/examples/extensions/paper/smoke.ts
```

## How it fits together

Everything agrees on one tree: the write zone's **scratchpad**. `read`, `edit`, `grep`, `ls` and
`find` look at it directly, and `bash` gets it mounted read-only into each throwaway container.
Without that, the agent would edit a file and then run a test against the version it had just
replaced.

```
 read / ls / grep / find ─┐
 write / edit ────────────┼─▶ scratchpad ──(read-only mount)──▶ bash sandbox
                          │        │
                          │        └── diff() ─▶ you approve ─▶ commit() ─▶ real files
 fetch_url ───────────────┴─▶ network zone (no mounts)
```

`write` and `edit` report `staged`, not `wrote`. Apply them with `/paper`, or answer the prompt
that appears at the end of each turn. Nothing reaches the real tree until you say so, and a file
that changed on disk since staging is reported as a conflict and left alone.

## What this costs you

These are real losses, not rough edges. They follow from the isolation model.

- **Sandboxed `bash` cannot persist anything.** Mounts are read-only and the scratch tmpfs dies
  with the container, so formatters, code generators and `npm run build` will run and change
  nothing. Only `write` and `edit` alter files.
- **Sandboxed `bash` has no network.** `npm install`, `pip install` and `git fetch` fail. That is
  the invariant working: no zone holds both filesystem access and connectivity. Use `fetch_url`.
- **No streamed output.** A sandboxed command resolves once, so its output arrives in a single
  chunk at the end rather than live.
- **The host environment is not forwarded.** Your provider API keys live in this process's
  environment, and a sandbox for running untrusted commands is the last place they belong. Name
  the variables you actually want in `bash.env`.
- **`grep` uses POSIX ERE, not ripgrep's regex.** Matching happens inside the container via
  `grep -E`, so exotic syntax may not carry across. `find` walks the tree one directory listing
  at a time instead of shelling out to `fd`, which is correct but slower.
- **A container per `bash` call** costs roughly 200 ms of gVisor startup.
- **Staging costs a copy.** The working directory is copied into the scratchpad when the first
  tool runs. Scope it with `workspace.include` / `workspace.exclude` on a large repo.
- **Nothing can be approved without a UI.** In `--print`, `--mode json` and RPC modes, staged
  edits are left staged and reported, unless you set `autoCommit`.

## Configuration

`~/.pi/agent/extensions/paper.json` merged with `<cwd>/.pi/paper.json`; project wins, key by key.

```jsonc
{
  "readPaths": ["/home/me/reference-repo"],   // extra read-only paths outside the cwd
  "workspace": {
    "include": ["."],                          // what gets staged, relative to the cwd
    "exclude": [".git", "node_modules", "dist"],
    "maxSeedFiles": 5000,
    "maxSeedBytes": 268435456
  },
  "bash": {
    "timeoutMs": 120000,
    "maxOutputBytes": 1048576,
    "env": []                                  // host env var names to forward, by name
  },
  "resources": { "memoryBytes": 1073741824, "cpus": 2, "pidsLimit": 512 },
  "autoCommit": false,                         // apply staged edits without asking
  "transcript": { "enabled": true }
}
```

`exclude` entries are matched exactly against an entry's own name and against its path relative
to the working directory — `node_modules` skips every one at any depth. No globbing.

Defaults are tight: `resources` gives each container 1 CPU and a 128-process limit, which a real
test suite will outgrow.

## Transcripts

Every prompt, tool call and tool result is appended to
`<tmpdir>/paper-api/transcripts/<pi session id>.jsonl`. It lives host-side and is mounted into no
zone, so a compromised sandbox can neither read it nor forge an entry. Set
`transcript.enabled: false` to turn it off.

## Files

- `index.ts` — extension wiring: tool registration, approval UI, `/paper`, transcript hooks
- `session.ts` — zone lifecycle and host-path resolution
- `tools.ts` — the `*Operations` implementations, plus grep and bash
- `config.ts` — configuration loading and merging
- `smoke.ts` — end-to-end check against real zones, no LLM required
