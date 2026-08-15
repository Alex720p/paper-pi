# paper

Runs pi's tools inside sandboxes, and gates every file change on human approval.

pi ships no sandbox by design (`docs/security.md`): its built-in tools call `node:fs` and spawn
shells directly on the host. This extension routes all of them somewhere else, each holding
exactly one dangerous capability.

| pi tool | Where it runs | What it can do |
|---|---|---|
| `read` `ls` `grep` `find` | a gVisor container with the staged tree mounted **read-only** | read only; no network, no exec |
| `write` `edit` | a second container with it mounted **read-write** | stage a change; the real file needs approval |
| `bash`, `!` commands | **the zone**: a microvm.nix VM that lives as long as the session | run anything; no network; nothing escapes |
| `zone_install` | a host-side `nix build` you approve | add packages to the zone |
| `fetch_url` | a container with **zero** filesystem mounts, alive as long as the session | reach the network; nothing local to exfiltrate |

No single sandbox can both read and write, and the only one that runs arbitrary commands has
neither a network device nor a way to reach the host.

## The zone

`bash` runs in a NixOS micro-VM built by [microvm.nix](https://github.com/microvm-nix/microvm.nix).
It boots on the first command and lives until the session ends, which is the point: **everything in
it is ephemeral for the whole session, not for one command.** An install, a build cache, a
`node_modules`, a server started in the background — all still there in the next command, and all
gone when you quit.

The VM itself belongs to [paper-api](../../../../../../paper-api), like the containers do: this
extension calls `createExecZone`, and the supervision, the vsock protocol and the NixOS template
live there. What is below describes what the zone gives you; `paper-api/README.md` describes how.

```
  staged tree (host dir)  ──virtiofs, --readonly──▶  /mnt/lower  ┐
                                                                 ├ overlayfs ─▶ /workspace
  tmpfs in the guest                                /mnt/upper  ┘
```

The workspace is an overlay: the staged tree underneath, read-only, and a guest tmpfs on top that
takes every write. The real repository is mounted into the VM nowhere at all, and the read-only
posture is enforced on the host — by `virtiofsd --readonly`, or by qemu's `-fsdev readonly=on` for
9p — not by a guest mount option the guest's own root could undo. Try it:

```
$ mount -o remount,rw /mnt/lower && echo x > /mnt/lower/f
bash: /mnt/lower/f: Read-only file system
```

Commands travel in over AF_VSOCK. There is no network interface in the guest, so this is the only
channel; systemd socket-activates a small agent per connection, and output streams back as it is
produced — `bash` shows it as it arrives rather than when the command ends.

### Installing things

The zone has no network, so `npm install` cannot work and neither can anything else that fetches.
When the agent needs a program that is not there, it calls `zone_install` with nixpkgs attribute
names. You are asked first:

```
Add nodejs to the execution zone?
The test suite is run with npm, which is not installed.

.pi/zone/packages.json
+ nodejs

The zone will be rebuilt and restarted.
```

On approval the name is appended to `.pi/zone/packages.json`, the VM is rebuilt and restarted, and
the files the agent had created in the zone are carried back in. Running processes are not: a
restart is a restart. The rebuild is the only time anything reaches the network, it happens on the
host, and it happens because you said yes.

## Setup

Needs Docker with gVisor registered as `runsc` (`sudo runsc install`), and Nix with flakes plus
KVM (`/dev/kvm`, and your user in the `kvm` group).

paper-api is a `file:` dependency and is consumed as its build output, so build it first — the
zone's NixOS template ships in there too:

```sh
cd /path/to/paper-api && npm install && npm run build
```

```sh
cd packages/coding-agent/examples/extensions/paper
npm install --ignore-scripts
```

```sh
cd /path/to/project
pi -e /path/to/pi/packages/coding-agent/examples/extensions/paper
```

The first `bash` call offers to create `.pi/zone/` in your project — `flake.nix`, `zone.nix`,
`packages.json` and `agent.py`, copied from the template paper-api ships. They are yours: commit
them, edit `zone.nix` to change what the zone looks like. `/zone init` does it explicitly, `/zone`
shows status, `/zone restart` throws the VM away and boots a fresh one.

Check it end to end without an LLM. It exercises every operation against real zones, boots a real
VM, and asserts the properties below:

```sh
node_modules/.bin/tsx --tsconfig tsconfig.json \
  packages/coding-agent/examples/extensions/paper/smoke.ts
```

Set `PAPER_ZONE_DEBUG=1` to trace the boot when a zone will not come up; the guest's serial console
is captured to `console.log` in the session's temp directory either way.

`smoke.ts` calls the operations in `tools.ts` directly, so it checks the zones but not the agent
around them. To drive the tools pi actually registers — through the agent loop, the tool hooks and
session persistence, and still without an LLM — use a fake session from
[`packages/evals`](../../../../evals/README.md#driving-a-sandboxed-backend-the-paper-extension). You
issue the tool calls a model would otherwise choose, so a `write` followed by `bash cat` is a
deterministic check that the write container and the zone agree on one tree.

## How it fits together

Everything agrees on one tree: the **scratchpad**, a host directory mounted into every sandbox that
needs it. `write` and `edit` mutate it through `tee`/`mkdir`/`rm` in the write container; `read`,
`ls`, `grep` and `find` inspect it from a separate read-only container; the zone gets it read-only
as the bottom half of its overlay. Without that agreement, the agent would edit a file and then run
a test against the version it had just replaced.

```
                              ┌─▶ read zone    /mnt/0     (ro)   read, ls, grep, find
                              │
  scratchpad (host dir) ──────┼─▶ write zone   /workspace (rw)   tee, mkdir, rm, chmod
        │                     │
        │                     └─▶ the zone     /mnt/lower (ro)   under the overlay
        │                                      /workspace        bash, ! — session-long
        │
        └── diff() ─▶ you approve ─▶ commit() ─▶ real files      (host-side)

  fetch_url ─────────────────────▶ network zone, no mounts at all — session-long
```

`seed`, `diff` and `commit` stay host-side because their other endpoint is the real tree, which is
mounted into no sandbox. `commit` especially: giving anything a read-write handle on your actual
repo would defeat the approval gate it exists to enforce.

`write` and `edit` report `staged`, not `wrote`. Apply them with `/paper`, or answer the prompt at
the end of each turn. Nothing reaches the real tree until you say so, and a file that changed on
disk since staging is reported as a conflict and left alone.

## What this costs you

These are real losses, not rough edges. They follow from the isolation model.

- **The zone cannot change your files.** Formatters, code generators and `npm run build` run, and
  their output lives in the zone until the session ends. Only `write` and `edit` alter the real
  tree, and only with approval.
- **The zone has no network.** `npm install` and `git fetch` fail; `zone_install` and `fetch_url`
  are the two ways anything gets in, and both ask you first.
- **Fetches share one container for the session.** `fetch_url` builds its network container on the
  first fetch and keeps it until the session ends, so a later fetch sees whatever an earlier one
  left in the container's `/tmp`. That container still mounts nothing and cannot reach the host, so
  no local file is exposed either way — but one request is no longer isolated from the next.
- **A zone costs a `nix build` and a boot.** The first command of the first session pays for the
  VM's closure — several minutes, mostly downloads — and roughly 20 seconds of boot after that.
  Later sessions reuse the nix store. Nothing is built until a command actually runs.
- **The zone's changes shadow later staged edits.** A file the agent rewrote inside the zone keeps
  the zone's version even after `edit` stages a new one, because the overlay's upper layer always
  wins. That is what "contained to the zone" means, and it will surprise someone.
- **`npm install` lands in RAM.** The upper layer is a tmpfs, charged to `zone.upperSizeMb` and to
  the VM's memory. A large dependency tree needs both raised.
- **The host environment is not forwarded.** Your provider API keys live in this process's
  environment, and a sandbox for running untrusted commands is the last place they belong. Name the
  variables you actually want in `bash.env`.
- **`grep` uses POSIX ERE, not ripgrep's regex.** Matching happens inside the read container via
  `grep -E`, so exotic syntax may not carry across. `find` walks the tree one directory listing at
  a time instead of shelling out to `fd`, which is correct but slower.
- **A write costs container round trips**, not a `write(2)`. Each `write`/`edit` is 2-3 execs at
  roughly 10-50 ms each under gVisor, rather than a sub-millisecond host write.
- **Staging costs a copy.** The working directory is copied into the scratchpad when the first tool
  runs. Scope it with `workspace.include` / `workspace.exclude` on a large repo.
- **Nothing can be approved without a UI.** In `--print`, `--mode json` and RPC modes, staged edits
  are left staged and reported unless you set `autoCommit`, and `zone_install` refuses outright.

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
  "zone": {
    "enabled": true,
    "dir": ".pi/zone",                         // the zone's NixOS config, in your project
    "lowerSource": "staged",                   // or "cwd", to see the real tree instead
    "allowInstall": true,
    // Everything below is passed to paper-api untouched; omit one to take its default.
    "vcpu": 4,
    "memMb": 4096,
    "upperSizeMb": 2048,                       // the tmpfs every change lands in
    "shareProto": "virtiofs",                  // or "9p"
    "workspaceMode": "overlay",                // or "copy"
    "machine": "q35",                          // or "microvm", if your host boots it
    "preserveUpperOnRebuild": true,
    "maxPreserveBytes": 67108864
  },
  "resources": { "memoryBytes": 1073741824, "cpus": 2, "pidsLimit": 512 },
  "autoCommit": false,                         // apply staged edits without asking
  "transcript": { "enabled": true }
}
```

`exclude` entries are matched exactly against an entry's own name and against its path relative to
the working directory — `node_modules` skips every one at any depth. No globbing.

Two knobs exist because the parts they configure are the fragile ones. `workspaceMode: "copy"`
duplicates the staged tree into the tmpfs at boot instead of overlaying it, for when overlayfs and
the share disagree; it keeps the same guarantees and pays a copy. `machine` is qemu's machine type:
microvm.nix defaults to `microvm`, which boots faster, but it hangs in early kernel init on some
hosts — nested virtualisation especially — so the default here is the ordinary `q35`.

## Transcripts

Every prompt, tool call and tool result is appended to
`<tmpdir>/paper-api/transcripts/<pi session id>.jsonl`. It lives host-side and is mounted into no
sandbox, so a compromised one can neither read it nor forge an entry. Set `transcript.enabled:
false` to turn it off.

## Files

- `index.ts` — extension wiring: tool registration, approval UI, `/paper`, `/zone`, transcript hooks
- `session.ts` — zone lifecycle and host-path resolution
- `tools.ts` — the `*Operations` implementations, plus grep and bash
- `config.ts` — configuration loading and merging
- `smoke.ts` — end-to-end check against real zones, no LLM required

The sandboxes themselves are paper-api's: `createReadZone`, `createWriteZone`, `createNetworkZone`
and `createExecZone`, plus `scaffoldZoneDir` for the NixOS template.
