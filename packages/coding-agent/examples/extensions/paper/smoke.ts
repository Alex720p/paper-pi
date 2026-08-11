/**
 * Exercises the sandbox routing without an LLM: every operation pi's tools would perform, run
 * against real zones, plus the properties that make the routing worth having.
 *
 *   ./pi-test.sh --help >/dev/null   # (sanity: sources load)
 *   node_modules/.bin/tsx --tsconfig tsconfig.json \
 *     packages/coding-agent/examples/extensions/paper/smoke.ts
 *
 * Needs Docker with gVisor registered as `runsc`, and Nix with flakes plus KVM. The first run
 * builds the zone's VM, which takes a while; later runs are cached.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "./config.ts";
import { openPaperSession, type PaperSession } from "./session.ts";
import {
	createPaperBashOps,
	createPaperEditOps,
	createPaperFindOps,
	createPaperLsOps,
	createPaperReadOps,
	createPaperWriteOps,
	executePaperGrep,
} from "./tools.ts";
import { scaffoldZoneDir } from "./zone.ts";

const rows: Array<[string, string, string]> = [];

function record(area: string, check: string, result: string): void {
	rows.push([area, check, result]);
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`smoke check failed: ${message}`);
}

async function makeProject(): Promise<string> {
	const base = await mkdtemp(path.join(os.tmpdir(), "paper-pi-smoke-"));
	const root = path.join(base, "proj");
	await mkdir(path.join(root, "src"), { recursive: true });
	await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
	await writeFile(path.join(root, "src", "app.ts"), "const answer = 41; // TODO: fix\n");
	await writeFile(path.join(root, "src", "util.ts"), "export const noop = () => {};\n");
	await writeFile(path.join(root, "README.md"), "# smoke\n");
	await writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
	await writeFile(path.join(root, "node_modules", "junk", "big.js"), "should never be staged\n");
	// The zone builds from the project's own NixOS config, so the project needs one.
	await scaffoldZoneDir(path.join(root, DEFAULT_CONFIG.zone.dir));
	return root;
}

/** Run a command in the zone and collect everything it printed. */
async function zoneRun(
	session: PaperSession,
	command: string,
	root: string,
	timeoutSeconds?: number,
): Promise<{ exitCode: number; output: string }> {
	let output = "";
	const result = await createPaperBashOps(session).exec(command, root, {
		onData: (chunk) => {
			output += chunk.toString("utf8");
		},
		...(timeoutSeconds ? { timeout: timeoutSeconds } : {}),
	});
	return { exitCode: result.exitCode ?? -1, output: output.trim() };
}

async function run(): Promise<void> {
	const root = await makeProject();
	let session: PaperSession | undefined;

	try {
		session = await openPaperSession(root, DEFAULT_CONFIG, "smoke");
		const active = session;

		// --- the zone split -----------------------------------------------------
		const readStatus = active.read.status();
		const writeStatus = active.write.status();
		assert(readStatus.containerId !== null, "the read zone has a container");
		assert(writeStatus.containerId !== null, "the write zone has a container");
		assert(readStatus.containerId !== writeStatus.containerId, "read and write are distinct containers");
		record("zones", "one container each", `read=${readStatus.kind}, write=${writeStatus.kind}`);

		// --- read -------------------------------------------------------------
		const readOps = createPaperReadOps(active);
		const original = await readOps.readFile(path.join(root, "src/app.ts"));
		assert(original.toString("utf8").includes("41"), "read returned the file");
		record("read", "readFile", `${original.length} bytes`);

		const image = await readOps.readFile(path.join(root, "logo.png"));
		assert(image.length === 6 && image[5] === 0xff, "binary read is byte-exact");
		record("read", "binary readFile", `${image.length} bytes, 0x${image[5]?.toString(16)} intact`);

		// --- the excluded tree --------------------------------------------------
		const lsOps = createPaperLsOps(active);
		const staged = await lsOps.readdir(root);
		assert(!staged.includes("node_modules"), "node_modules was not staged");
		record("ls", "exclusions honoured", staged.sort().join(", "));

		// --- write, and read-after-write coherence -------------------------------
		const writeOps = createPaperWriteOps(active);
		await writeOps.writeFile(path.join(root, "src/app.ts"), "const answer = 42; // fixed\n");

		const afterStage = await readOps.readFile(path.join(root, "src/app.ts"));
		assert(afterStage.toString("utf8").includes("42"), "read sees the staged edit");
		record("write", "read sees staged edit", "yes");

		const onDisk = await readFile(path.join(root, "src/app.ts"), "utf8");
		assert(onDisk.includes("41"), "the real file is untouched before approval");
		record("write", "real file untouched", "yes");

		// Content containing NUL survives only because the bytes travel on the container
		// process's stdin — an argv element cannot hold one.
		await writeOps.writeFile(path.join(root, "src/nul.bin"), "before\0after\n");
		const nulBack = await readOps.readFile(path.join(root, "src/nul.bin"));
		assert(nulBack.includes(0), "a NUL byte survived the write");
		assert(nulBack.toString("utf8") === "before\0after\n", "the whole content round-tripped");
		record("write", "NUL content round-trips", `${nulBack.length} bytes via stdin`);

		// --- edit ---------------------------------------------------------------
		const editOps = createPaperEditOps(active);
		const forEdit = await editOps.readFile(path.join(root, "src/util.ts"));
		await editOps.writeFile(path.join(root, "src/util.ts"), forEdit.toString("utf8").replace("noop", "nothing"));
		record("edit", "staged", "src/util.ts");

		// --- find ---------------------------------------------------------------
		const findOps = createPaperFindOps(active);
		const found = await findOps.glob("*.ts", root, { ignore: [], limit: 50 });
		assert(found.length === 2, `find matched the two source files, got ${found.length}`);
		record("find", "glob", found.map((entry) => path.relative(root, entry)).join(", "));

		// --- grep ---------------------------------------------------------------
		const grep = await executePaperGrep(active, { pattern: "answer", path: "." });
		const grepText = grep.content[0]?.text ?? "";
		assert(grepText.includes("42"), "grep searched the staged tree, not the real one");
		record("grep", "matched staged content", grepText.split("\n")[0] ?? "");

		// --- bash, in the zone ---------------------------------------------------
		// The first of these builds and boots the VM, so it is much slower than the rest.
		const cat = await zoneRun(active, "cat src/app.ts", root);
		assert(cat.exitCode === 0 && cat.output.includes("42"), "bash sees the staged tree");
		record("zone", "sees staged edit", cat.output);

		const zoneStatus = active.zone?.status();
		assert(zoneStatus !== undefined && zoneStatus.pid !== undefined, "the zone has a running VM");
		record("zone", "vm", `cid ${zoneStatus?.cid}, pid ${zoneStatus?.pid}`);

		// Unlike the container it replaced, the zone is writable — and none of it escapes.
		const wrote = await zoneRun(active, "echo 'from the zone' > src/app.ts && echo built > artifact.txt && ls", root);
		assert(wrote.exitCode === 0, `bash can write in the zone, got: ${wrote.output}`);
		record("zone", "writes accepted", wrote.output.split("\n").join(" "));

		const stillStaged = await active.read.readFile("src/app.ts");
		assert(stillStaged.content.includes("42"), "the staged tree did not see the zone's write");
		assert(
			(await readFile(path.join(root, "src/app.ts"), "utf8")).includes("41"),
			"the real file did not see the zone's write",
		);
		record("zone", "changes stay inside", "staged tree and real file both untouched");

		// Persistence is the whole point of the change: this is a second, separate connection.
		const persisted = await zoneRun(active, "cat artifact.txt; cat src/app.ts", root);
		assert(persisted.output.includes("built"), "a file written by an earlier command is still there");
		assert(persisted.output.includes("from the zone"), "an edit made by an earlier command is still there");
		record("zone", "state survives between calls", persisted.output.split("\n").join(" "));

		// The read-only posture is enforced by virtiofsd on the host, not by a guest mount
		// option that the guest's own root could undo.
		const breakOut = await zoneRun(
			active,
			"mount -o remount,rw /mnt/lower; echo pwned > /mnt/lower/pwned; echo done",
			root,
		);
		const refusal = breakOut.output.split("\n").find((line) => /read-only/i.test(line));
		assert(refusal !== undefined, `the share refused the write, got: ${breakOut.output}`);
		assert(!(await lsOps.exists(path.join(root, "pwned"))), "nothing appeared in the staged tree");
		record("zone", "read-only share holds", refusal?.replace(/^.*: /, "") ?? "");

		const net = await zoneRun(active, "ip -o link | cut -d: -f2; getent hosts example.com || echo NO_DNS", root);
		assert(net.output.includes("NO_DNS"), "the zone has no DNS");
		assert(!/eth|ens|enp/.test(net.output), `the zone has no network interface, got: ${net.output}`);
		record("zone", "no network", net.output.split("\n").join(" "));

		process.env.PAPER_SMOKE_SECRET = "leaked";
		const env = await zoneRun(active, "env | grep PAPER_SMOKE_SECRET || echo NO_SECRET", root);
		assert(env.output.includes("NO_SECRET"), "host environment is not forwarded");
		record("zone", "host env withheld", "confirmed");

		// A staged edit made after boot has to reach the zone, or the agent would test the file
		// it had just replaced.
		await createPaperWriteOps(active).writeFile(path.join(root, "src/util.ts"), "export const fresh = 1;\n");
		const refreshed = await zoneRun(active, "cat src/util.ts", root);
		assert(refreshed.output.includes("fresh"), `the zone saw the new staged edit, got: ${refreshed.output}`);
		record("zone", "picks up later staged edits", refreshed.output);

		const timedOut = await zoneRun(active, "echo before; sleep 30", root, 3).then(
			() => "no error",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		assert(/^timeout:/.test(timedOut), `a slow command times out, got: ${timedOut}`);
		record("zone", "timeout", timedOut);

		const resolved = await active.zone?.resolvePackages(["hello", "definitely-not-a-package"]);
		assert(resolved?.known.join() === "hello", "a real nixpkgs attribute resolves");
		assert(resolved?.unknown.join() === "definitely-not-a-package", "a made-up one does not");
		record("zone", "package names checked before install", `known=${resolved?.known}, unknown=${resolved?.unknown}`);

		// --- approval -----------------------------------------------------------
		const diffs = await active.write.diff();
		// src/app.ts (modified), src/util.ts (modified), src/nul.bin (created).
		assert(diffs.length === 3, `three files staged, got ${diffs.length}`);
		record("approval", "diff", diffs.map((entry) => entry.path).join(", "));

		const committed = await active.write.commit(["src/app.ts"]);
		assert(committed.committed.length === 1, "only the approved path was applied");
		assert((await readFile(path.join(root, "src/app.ts"), "utf8")).includes("42"), "approved edit applied");
		assert(
			(await readFile(path.join(root, "src/util.ts"), "utf8")).includes("noop"),
			"the unapproved edit was not applied",
		);
		record("approval", "commit applies only approved", committed.committed.join(", "));
		record("approval", "unapproved left alone", "src/util.ts unchanged");
	} finally {
		if (session) await session.close();
		await rm(path.dirname(root), { recursive: true, force: true });
	}

	const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
	const line = (row: [string, string, string]) =>
		`| ${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ")} |`;
	console.log();
	console.log(line(["area", "check", "result"]));
	console.log(`|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`);
	for (const row of rows) console.log(line(row));
	console.log();
}

run().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
