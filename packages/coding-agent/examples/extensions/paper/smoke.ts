/**
 * Exercises the sandbox routing without an LLM: every operation pi's tools would perform, run
 * against real gVisor zones, plus the properties that make the routing worth having.
 *
 *   ./pi-test.sh --help >/dev/null   # (sanity: sources load)
 *   node_modules/.bin/tsx --tsconfig tsconfig.json \
 *     packages/coding-agent/examples/extensions/paper/smoke.ts
 *
 * Needs Docker and gVisor registered as `runsc`.
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
	return root;
}

async function run(): Promise<void> {
	const root = await makeProject();
	let session: PaperSession | undefined;

	try {
		session = await openPaperSession(root, DEFAULT_CONFIG);
		const active = session;

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

		// --- bash ---------------------------------------------------------------
		const bashOps = createPaperBashOps(active);
		let output = "";
		const cat = await bashOps.exec("cat src/app.ts", root, {
			onData: (chunk) => {
				output += chunk.toString("utf8");
			},
		});
		assert(cat.exitCode === 0 && output.includes("42"), "bash sees the staged tree");
		record("bash", "sees staged edit", output.trim());

		let writeOutput = "";
		const tryWrite = await bashOps.exec("echo nope > src/app.ts", root, {
			onData: (chunk) => {
				writeOutput += chunk.toString("utf8");
			},
		});
		assert(tryWrite.exitCode !== 0, "bash cannot write to the staged tree");
		assert(/read-only/i.test(writeOutput), `the mount refused the write, got: ${writeOutput.trim()}`);
		record("bash", "writes rejected", `exit ${tryWrite.exitCode}, ${writeOutput.trim()}`);

		let netOutput = "";
		await bashOps.exec("getent hosts example.com || echo NO_DNS", root, {
			onData: (chunk) => {
				netOutput += chunk.toString("utf8");
			},
		});
		assert(netOutput.includes("NO_DNS"), "bash has no network");
		record("bash", "no network", "confirmed");

		let envOutput = "";
		process.env.PAPER_SMOKE_SECRET = "leaked";
		await bashOps.exec("env | grep PAPER_SMOKE_SECRET || echo NO_SECRET", root, {
			onData: (chunk) => {
				envOutput += chunk.toString("utf8");
			},
		});
		assert(envOutput.includes("NO_SECRET"), "host environment is not forwarded");
		record("bash", "host env withheld", "confirmed");

		// --- approval -----------------------------------------------------------
		const diffs = await active.write.diff();
		assert(diffs.length === 2, `two files staged, got ${diffs.length}`);
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
