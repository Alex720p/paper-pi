/**
 * The execution zone: one microvm.nix VM per pi session.
 *
 * The VM boots once and lives until the session ends, so state persists between `bash` calls —
 * installs, build caches, background servers. None of it reaches the host: the workspace arrives
 * as a read-only share covered by a guest tmpfs overlay, and the VM has no network device at all.
 *
 * Everything below is process supervision plus one small protocol. The VM is a `nix build` away
 * (`microvm.declaredRunner` produces `bin/microvm-run`), and the only channel into it is AF_VSOCK,
 * which node cannot speak — so commands travel through `socat`, itself pinned by the same flake.
 */
import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ZoneConfig } from "./config.ts";

/** The port the guest's socket-activated agent listens on. Matches zone-template/zone.nix. */
const AGENT_PORT = 1024;
const GUEST_WORKSPACE = "/workspace";
const GUEST_UPPER = "/mnt/upper/up";
const CONSOLE_TAIL_LINES = 40;

export interface ZoneExecOptions {
	/** Absolute guest path. Anything outside the guest's view falls back to /workspace. */
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	stdin?: Buffer;
	onData?: (chunk: Buffer) => void;
	signal?: AbortSignal;
}

export interface ZoneExecResult {
	exitCode: number;
	timedOut: boolean;
	aborted: boolean;
}

export interface ZoneStatus {
	cid: number;
	pid: number | undefined;
	runner: string;
	sessionDir: string;
	lowerSource: string;
	packages: string[];
	restarts: number;
}

export interface ZoneInstallResult {
	added: string[];
	/** Bytes of ephemeral state carried across the rebuild; undefined when none was attempted. */
	preservedBytes: number | undefined;
	preserveSkipped: boolean;
}

export interface ZoneVm {
	readonly cid: number;
	exec(command: string, options: ZoneExecOptions): Promise<ZoneExecResult>;
	/** Resolve names against nixpkgs before anyone is asked to approve them. */
	resolvePackages(names: string[]): Promise<{ known: string[]; unknown: string[] }>;
	install(names: string[], onLog?: (line: string) => void): Promise<ZoneInstallResult>;
	packages(): Promise<string[]>;
	restart(onLog?: (line: string) => void): Promise<void>;
	/** The read-only lower layer changed; the next command remounts the overlay first. */
	markLowerDirty(): void;
	status(): ZoneStatus;
	consoleTail(): string;
	close(): Promise<void>;
}

// --- helpers -----------------------------------------------------------------

export function nixSystem(): string {
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
	return `${arch}-linux`;
}

/** Nix string literal. `${` matters as much as the quotes: it starts an interpolation. */
function nixString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$\{/g, "\\${")}"`;
}

function renderSessionNix(values: {
	cid: number;
	lowerSource: string;
	vcpu: number;
	memMb: number;
	upperSizeMb: number;
	shareProto: string;
	workspaceMode: string;
	machine: string;
}): string {
	return [
		"# Generated per session by the paper extension. Do not edit; do not commit.",
		"{",
		`  cid = ${values.cid};`,
		`  lowerSource = ${nixString(values.lowerSource)};`,
		`  vcpu = ${values.vcpu};`,
		`  memMb = ${values.memMb};`,
		`  upperSizeMb = ${values.upperSizeMb};`,
		`  shareProto = ${nixString(values.shareProto)};`,
		`  workspaceMode = ${nixString(values.workspaceMode)};`,
		`  machine = ${nixString(values.machine)};`,
		"}",
		"",
	].join("\n");
}

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Boot and connection tracing, for when a zone will not come up. `PAPER_ZONE_DEBUG=1`. */
function debug(message: string): void {
	if (process.env.PAPER_ZONE_DEBUG) process.stderr.write(`[zone] ${message}\n`);
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function run(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number; onLog?: (line: string) => void } = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer =
			options.timeoutMs && options.timeoutMs > 0
				? setTimeout(() => {
						child.kill("SIGKILL");
					}, options.timeoutMs)
				: undefined;

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderr += text;
			// nix reports progress on stderr; the last non-empty line is the useful status.
			if (options.onLog) {
				for (const line of text.split("\n")) {
					if (line.trim()) options.onLog(line.trim());
				}
			}
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ exitCode: code ?? -1, stdout, stderr });
		});
	});
}

/**
 * Every VM this process started, so a SIGINT does not leave qemu running with a virtiofsd
 * exporting somebody's source tree. paper-api keeps its own registry for containers; this is the
 * same idea for the one thing it does not own.
 */
const liveZones = new Set<{ shutdown: () => void }>();
let signalsHooked = false;

function hookSignals(): void {
	if (signalsHooked) return;
	signalsHooked = true;
	const teardown = () => {
		for (const zone of liveZones) zone.shutdown();
		liveZones.clear();
	};
	process.on("exit", teardown);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			teardown();
		});
	}
}

// --- the zone ----------------------------------------------------------------

export interface OpenZoneOptions {
	/** The project's `.pi/zone` directory: the durable source of truth. */
	zoneDir: string;
	/** Host directory shared read-only as the workspace's lower layer. */
	lowerSource: string;
	sessionId: string;
	config: ZoneConfig;
	onLog?: (line: string) => void;
}

export async function openZone(options: OpenZoneOptions): Promise<ZoneVm> {
	const { zoneDir, lowerSource, config } = options;
	const system = nixSystem();
	const log = (line: string) => options.onLog?.(line);

	// Kept short on purpose: qemu and virtiofsd put their unix sockets in `runDir`, and AF_UNIX
	// paths are capped at 108 bytes.
	const sessionDir = path.join(os.tmpdir(), `paper-zone-${options.sessionId.slice(0, 12)}-${process.pid}`);
	const flakeDir = path.join(sessionDir, "flake");
	const runDir = path.join(sessionDir, "run");
	await mkdir(runDir, { recursive: true });

	// A copy, not the project directory itself: session.nix carries values that belong to this
	// session alone, and two pi sessions in one repo must not fight over them. Copying flake.lock
	// along with it is what keeps the build cached rather than re-resolving inputs.
	await cp(zoneDir, flakeDir, { recursive: true });
	await rm(path.join(flakeDir, "session.nix"), { force: true });

	let cid = allocateCid();
	let runner = "";
	let socat = "";
	let restarts = 0;
	let lowerDirty = false;
	let closed = false;
	let hypervisor: ReturnType<typeof spawn> | undefined;
	let virtiofsd: ReturnType<typeof spawn> | undefined;
	let consoleStream: WriteStream | undefined;
	const consoleLines: string[] = [];

	function allocateCid(): number {
		// 0-2 are reserved; collisions across concurrent sessions are possible but rare, and a
		// clash makes qemu exit at start, which boot() retries with a fresh number.
		return 3 + Math.floor(Math.random() * 60_000);
	}

	function recordConsole(text: string): void {
		consoleStream?.write(text);
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			consoleLines.push(line);
			if (consoleLines.length > CONSOLE_TAIL_LINES) consoleLines.shift();
		}
	}

	async function writeSessionNix(): Promise<void> {
		await writeFile(
			path.join(flakeDir, "session.nix"),
			renderSessionNix({
				cid,
				lowerSource,
				vcpu: config.vcpu,
				memMb: config.memMb,
				upperSizeMb: config.upperSizeMb,
				shareProto: config.shareProto,
				workspaceMode: config.workspaceMode,
				machine: config.machine,
			}),
		);
	}

	async function nixBuild(attr: string, onLog?: (line: string) => void): Promise<string> {
		const result = await run("nix", ["build", "--no-link", "--print-out-paths", `path:${flakeDir}#${attr}`], {
			timeoutMs: config.buildTimeoutMs,
			onLog: onLog ?? log,
		});
		if (result.exitCode !== 0) {
			throw new Error(`nix build ${attr} failed:\n${result.stderr.trim()}`);
		}
		const outPath = result.stdout.trim().split("\n").pop();
		if (!outPath) throw new Error(`nix build ${attr} produced no output path`);
		return outPath;
	}

	async function build(onLog?: (line: string) => void): Promise<void> {
		await writeSessionNix();
		runner = await nixBuild("nixosConfigurations.zone.config.microvm.declaredRunner", onLog);
		if (!socat) socat = path.join(await nixBuild(`packages.${system}.host-tools`, onLog), "bin", "socat");
	}

	/** The vhost-user socket qemu expects virtiofsd to have created, as the runner declares it. */
	async function virtiofsSocket(): Promise<string | undefined> {
		const declared = path.join(runner, "share", "microvm", "virtiofs", "lower", "socket");
		if (!(await exists(declared))) return undefined;
		const value = (await readFile(declared, "utf8")).trim();
		return path.isAbsolute(value) ? value : path.join(runDir, value);
	}

	async function startProcesses(): Promise<void> {
		consoleStream = createWriteStream(path.join(sessionDir, "console.log"), { flags: "a" });

		const socketPath = await virtiofsSocket();
		if (socketPath) {
			// virtiofs needs its daemon up before qemu connects to the socket. Both run with the
			// same cwd because microvm.nix declares socket paths relative to it.
			//
			// `-u` is not optional: the generated supervisord config says `user=root`, and
			// supervisord refuses to start as anyone else without being told which user it is
			// already running as. virtiofsd itself is happy unprivileged.
			virtiofsd = spawn(path.join(runner, "bin", "virtiofsd-run"), ["-u", String(process.getuid?.() ?? 0)], {
				cwd: runDir,
				stdio: ["ignore", "pipe", "pipe"],
			});
			virtiofsd.stdout?.on("data", (chunk: Buffer) => recordConsole(`[virtiofsd] ${chunk.toString("utf8")}`));
			virtiofsd.stderr?.on("data", (chunk: Buffer) => recordConsole(`[virtiofsd] ${chunk.toString("utf8")}`));

			const deadline = Date.now() + config.bootTimeoutMs;
			while (!(await exists(socketPath))) {
				if (Date.now() > deadline) throw new Error(`virtiofsd never created ${socketPath}`);
				if (virtiofsd.exitCode !== null) {
					throw new Error(`virtiofsd exited with ${virtiofsd.exitCode}:\n${consoleLines.join("\n")}`);
				}
				await delay(100);
			}
		}

		hypervisor = spawn(path.join(runner, "bin", "microvm-run"), [], {
			cwd: runDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
		hypervisor.stdout?.on("data", (chunk: Buffer) => recordConsole(chunk.toString("utf8")));
		hypervisor.stderr?.on("data", (chunk: Buffer) => recordConsole(chunk.toString("utf8")));
	}

	function stopProcesses(): void {
		// qemu first: it holds the vhost-user connection, and virtiofsd exits once that drops.
		for (const child of [hypervisor, virtiofsd]) {
			if (!child || child.exitCode !== null) continue;
			child.kill("SIGTERM");
		}
		hypervisor = undefined;
		virtiofsd = undefined;
		consoleStream?.end();
		consoleStream = undefined;
	}

	/**
	 * Stop, and do not come back until the run directory is reusable.
	 *
	 * A restart reuses the same cwd, and both qemu and virtiofsd bind unix sockets there by
	 * relative name. Starting the replacements while the old ones still hold those paths gives
	 * `Connection refused` from qemu and a supervisord that respawns virtiofsd forever.
	 */
	async function stopAndSettle(): Promise<void> {
		const dying = [hypervisor, virtiofsd].filter((child) => child && child.exitCode === null);
		stopProcesses();

		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && dying.some((child) => child?.exitCode === null)) {
			await delay(100);
		}
		for (const child of dying) {
			if (child?.exitCode === null) child.kill("SIGKILL");
		}
		await delay(200);

		for (const name of ["paper-zone.sock", "paper-zone-virtiofs-lower.sock", "paper-zone-virtiofs-lower.sock.pid"]) {
			await rm(path.join(runDir, name), { force: true });
		}
	}

	/**
	 * Run something trivial, rather than merely connecting.
	 *
	 * systemd accepts the connection as soon as the socket unit is listening, which happens well
	 * before the workspace is mounted; it is the per-connection service instance that waits on
	 * the mount. So only a command that actually came back means the zone is usable.
	 */
	async function probe(): Promise<boolean> {
		try {
			const result = await execRequest("true", { timeoutMs: 5_000, signal: AbortSignal.timeout(15_000) });
			if (result.exitCode !== 0) debug(`probe: exit ${result.exitCode} aborted=${result.aborted}`);
			return result.exitCode === 0;
		} catch (error) {
			debug(`probe: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async function waitForAgent(): Promise<void> {
		const deadline = Date.now() + config.bootTimeoutMs;
		let attempts = 0;
		while (Date.now() < deadline) {
			if (hypervisor !== undefined && hypervisor.exitCode !== null) {
				throw new Error(`the zone exited during boot (code ${hypervisor.exitCode}):\n${consoleLines.join("\n")}`);
			}
			attempts += 1;
			if (await probe()) {
				debug(`agent answered after ${attempts} probe(s)`);
				return;
			}
			await delay(250);
		}
		throw new Error(
			`the zone did not answer on vsock ${cid}:${AGENT_PORT} within ${Math.round(config.bootTimeoutMs / 1000)}s.\n` +
				`Last console output:\n${consoleLines.join("\n")}`,
		);
	}

	async function boot(): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				debug(`boot attempt ${attempt + 1} on cid ${cid}`);
				await startProcesses();
				await waitForAgent();
				debug(`boot attempt ${attempt + 1} succeeded`);
				// The overlay is freshly mounted, so whatever the write zone did before boot is
				// already visible.
				lowerDirty = false;
				return;
			} catch (error) {
				lastError = error;
				debug(`boot attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
				await stopAndSettle();
				if (attempt === 2) break;
				// The likeliest reason to fail twice in a row is a CID another session already
				// claimed, which is cheap to walk away from.
				cid = allocateCid();
				await build();
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	// --- the protocol --------------------------------------------------------

	function execRequest(command: string, options: ZoneExecOptions): Promise<ZoneExecResult> {
		return new Promise<ZoneExecResult>((resolve, reject) => {
			if (closed) {
				reject(new Error("the zone is closed"));
				return;
			}
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}

			const child = spawn(socat, [`-t${config.hangupGraceMs / 1000}`, "-", `VSOCK-CONNECT:${cid}:${AGENT_PORT}`], {
				stdio: ["pipe", "pipe", "pipe"],
			});

			let pending = "";
			let stderrText = "";
			let settled = false;
			let sawRefresh = lowerDirty;

			const finish = (error: Error | undefined, result?: ZoneExecResult) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", onAbort);
				child.kill("SIGKILL");
				if (error) reject(error);
				else if (result) resolve(result);
			};

			const onAbort = () => {
				// Killing socat closes the connection; the guest agent notices the hangup and kills
				// the command's whole process group.
				finish(undefined, { exitCode: -1, timedOut: false, aborted: true });
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });

			child.stdout.on("data", (chunk: Buffer) => {
				pending += chunk.toString("utf8");
				let index = pending.indexOf("\n");
				while (index >= 0) {
					const line = pending.slice(0, index);
					pending = pending.slice(index + 1);
					if (line.trim()) {
						let frame: { t: string; d?: string; code?: number; timedOut?: boolean };
						try {
							frame = JSON.parse(line) as typeof frame;
						} catch {
							finish(new Error(`the zone sent a malformed frame: ${line.slice(0, 200)}`));
							return;
						}
						if (frame.t === "o" || frame.t === "e") {
							if (frame.d) options.onData?.(Buffer.from(frame.d, "base64"));
						} else if (frame.t === "x") {
							if (sawRefresh) {
								lowerDirty = false;
								sawRefresh = false;
							}
							finish(undefined, {
								exitCode: frame.code ?? -1,
								timedOut: frame.timedOut === true,
								aborted: false,
							});
							return;
						}
					}
					index = pending.indexOf("\n");
				}
			});

			child.stderr.on("data", (chunk: Buffer) => {
				stderrText += chunk.toString("utf8");
			});

			child.on("error", (error) => finish(error));

			child.on("close", () => {
				// A close without an exit frame means socat could not reach the agent, or the VM
				// died mid-command. Either way the command's result is unknown.
				finish(new Error(`the zone connection closed before the command finished. ${stderrText.trim()}`.trim()));
			});

			const request = {
				command,
				cwd: options.cwd ?? GUEST_WORKSPACE,
				env: options.env ?? {},
				timeoutMs: options.timeoutMs ?? 0,
				refresh: lowerDirty,
				...(options.stdin ? { stdin: options.stdin.toString("base64") } : {}),
			};
			child.stdin.write(`${JSON.stringify(request)}\n`);
		});
	}

	// --- packages ------------------------------------------------------------

	const packagesFile = path.join(zoneDir, "packages.json");
	const sessionPackagesFile = path.join(flakeDir, "packages.json");

	async function readPackages(): Promise<string[]> {
		const parsed: unknown = JSON.parse(await readFile(packagesFile, "utf8"));
		if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
			throw new Error(`${packagesFile} must contain a JSON array of strings`);
		}
		return parsed as string[];
	}

	async function writePackages(names: string[]): Promise<void> {
		const body = `${JSON.stringify(names, null, 2)}\n`;
		await writeFile(packagesFile, body);
		await writeFile(sessionPackagesFile, body);
	}

	async function snapshotUpper(): Promise<Buffer | undefined> {
		if (!config.preserveUpperOnRebuild) return undefined;
		const chunks: Buffer[] = [];
		let size = 0;
		let overflowed = false;
		const result = await execRequest(`tar -C ${GUEST_UPPER} -czf - . 2>/dev/null`, {
			timeoutMs: 120_000,
			onData: (chunk) => {
				size += chunk.length;
				if (size > config.maxPreserveBytes) {
					overflowed = true;
					return;
				}
				chunks.push(chunk);
			},
		});
		if (overflowed || result.exitCode !== 0) return undefined;
		return Buffer.concat(chunks);
	}

	async function restoreUpper(archive: Buffer): Promise<void> {
		await execRequest(`mkdir -p ${GUEST_UPPER} && tar -C ${GUEST_UPPER} -xzf -`, {
			timeoutMs: 120_000,
			stdin: archive,
		});
		// Everything just landed underneath a mounted overlay, which does not notice writes to its
		// own upper layer behind its back.
		lowerDirty = true;
	}

	// --- lifecycle -----------------------------------------------------------

	const registration = { shutdown: stopProcesses };
	hookSignals();
	liveZones.add(registration);

	try {
		await build();
		await boot();
	} catch (error) {
		liveZones.delete(registration);
		stopProcesses();
		await rm(sessionDir, { recursive: true, force: true });
		throw error;
	}

	return {
		get cid() {
			return cid;
		},

		exec: (command, execOptions) => execRequest(command, execOptions),

		async resolvePackages(names) {
			const known: string[] = [];
			const unknown: string[] = [];
			for (const name of names) {
				const result = await run(
					"nix",
					["eval", "--raw", `path:${flakeDir}#legacyPackages.${system}.${name}.name`],
					{ timeoutMs: 60_000 },
				);
				(result.exitCode === 0 ? known : unknown).push(name);
			}
			return { known, unknown };
		},

		packages: readPackages,

		async install(names, onLog) {
			const current = await readPackages();
			const added = names.filter((name) => !current.includes(name));
			if (added.length === 0) {
				return { added: [], preservedBytes: undefined, preserveSkipped: false };
			}

			const archive = await snapshotUpper();
			const preserveSkipped = config.preserveUpperOnRebuild && archive === undefined;

			await writePackages([...current, ...added]);
			try {
				await build(onLog);
			} catch (error) {
				await writePackages(current);
				// Put the previous runner back so the zone keeps working after a failed install.
				await build(onLog);
				throw error;
			}

			await stopAndSettle();
			restarts += 1;
			await boot();
			if (archive) await restoreUpper(archive);

			return { added, preservedBytes: archive?.length, preserveSkipped };
		},

		async restart(onLog) {
			const archive = await snapshotUpper();
			await stopAndSettle();
			restarts += 1;
			await build(onLog);
			await boot();
			if (archive) await restoreUpper(archive);
		},

		markLowerDirty() {
			lowerDirty = true;
		},

		status() {
			return {
				cid,
				pid: hypervisor?.pid,
				runner,
				sessionDir,
				lowerSource,
				packages: [],
				restarts,
			};
		},

		consoleTail() {
			return consoleLines.join("\n");
		},

		async close() {
			if (closed) return;
			closed = true;
			liveZones.delete(registration);
			stopProcesses();
			await rm(sessionDir, { recursive: true, force: true });
		},
	};
}

/** Copy the shipped template into a project that has no `.pi/zone` yet. */
export async function scaffoldZoneDir(zoneDir: string): Promise<void> {
	const template = path.join(import.meta.dirname, "zone-template");
	await cp(template, zoneDir, { recursive: true, force: false, errorOnExist: false });
}

export { GUEST_WORKSPACE };
