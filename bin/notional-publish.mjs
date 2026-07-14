#!/usr/bin/env node

import { Buffer } from "buffer";
import { createHash, randomUUID } from "crypto";
import { existsSync, realpathSync, statSync } from "fs";
import { createConnection } from "net";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, relative, resolve } from "path";

const VERSION = "0.3.1";
const PROTOCOL = 1;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

const usage = `notional-publish ${VERSION}

Usage:
  notional-publish status [--vault PATH]
  notional-publish preflight NOTE [--vault PATH]
  notional-publish publish NOTE --confirm --fingerprint SHA256 [--allow-warnings] [--vault PATH]
  notional-publish repair-links NOTE [--confirm --fingerprint SHA256] [--allow-warnings] [--vault PATH]

All results are emitted as JSON. Publication requires an explicit confirmation
flag and a fingerprint returned by preflight (or by an unconfirmed repair plan).`;

const failUsage = (message) => {
	process.stderr.write(`${message}\n\n${usage}\n`);
	process.exit(2);
};

const parseArguments = (argv) => {
	if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${usage}\n`);
		process.exit(0);
	}
	if (argv.includes("--version")) {
		process.stdout.write(`${VERSION}\n`);
		process.exit(0);
	}
	const operation = argv[0];
	if (!["status", "preflight", "publish", "repair-links"].includes(operation)) {
		failUsage(`Unknown operation: ${operation}`);
	}
	const options = {
		operation,
		note: undefined,
		vault: undefined,
		fingerprint: undefined,
		confirm: false,
		allowWarnings: false,
	};
	let index = 1;
	if (operation !== "status" && argv[index] && !argv[index].startsWith("--")) {
		options.note = argv[index];
		index += 1;
	}
	while (index < argv.length) {
		const argument = argv[index];
		if (argument === "--confirm") options.confirm = true;
		else if (argument === "--allow-warnings") options.allowWarnings = true;
		else if (argument === "--vault" || argument === "--fingerprint") {
			const value = argv[index + 1];
			if (!value) failUsage(`${argument} requires a value.`);
			if (argument === "--vault") options.vault = value;
			else options.fingerprint = value;
			index += 1;
		} else failUsage(`Unknown argument: ${argument}`);
		index += 1;
	}
	if (operation !== "status" && !options.note) failUsage("A note path is required.");
	if (operation === "publish" && !options.confirm) {
		failUsage("publish requires --confirm.");
	}
	if (operation === "publish" && !options.fingerprint) {
		failUsage("publish requires --fingerprint from preflight.");
	}
	if (
		["status", "preflight"].includes(operation) &&
		(options.confirm || options.allowWarnings || options.fingerprint)
	) {
		failUsage(`${operation} does not accept publication approval flags.`);
	}
	if (operation === "repair-links" && !options.confirm && options.fingerprint) {
		failUsage("Pass the repair fingerprint only with --confirm.");
	}
	if (options.allowWarnings && !options.confirm) {
		failUsage("--allow-warnings requires --confirm.");
	}
	if (options.confirm && !options.fingerprint) {
		failUsage("Confirmed operations require --fingerprint.");
	}
	if (options.fingerprint && !/^[a-f0-9]{64}$/.test(options.fingerprint)) {
		failUsage("--fingerprint must be a SHA-256 digest.");
	}
	return options;
};

const findVault = (startPath) => {
	let current = resolve(startPath);
	while (true) {
		if (existsSync(join(current, ".obsidian"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
};

const resolveVault = (requested) => {
	const candidate =
		requested ||
		process.env.NOTIONAL_VAULT ||
		findVault(process.cwd()) ||
		join(homedir(), "Documents", "Obsidian Vault");
	if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
		failUsage(`Vault directory not found: ${candidate}`);
	}
	const canonical = realpathSync(candidate);
	if (!existsSync(join(canonical, ".obsidian"))) {
		failUsage(`Not an Obsidian vault: ${canonical}`);
	}
	return canonical;
};

const resolveNote = (note, vault) => {
	const absolute = isAbsolute(note) ? resolve(note) : resolve(vault, note);
	const relativePath = relative(vault, absolute).replace(/\\/g, "/");
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		isAbsolute(relativePath)
	) {
		failUsage("The note must stay inside the selected vault.");
	}
	if (!relativePath.toLowerCase().endsWith(".md")) {
		failUsage("The target must be a Markdown note.");
	}
	return relativePath;
};

const socketPathForVault = (vault) => {
	const runtimeDirectory =
		process.env.XDG_RUNTIME_DIR ||
		join(tmpdir(), `notional-${process.getuid?.() ?? "user"}`);
	const digest = createHash("sha256").update(vault).digest("hex").slice(0, 16);
	return join(runtimeDirectory, "notional-vault-publisher", `${digest}.sock`);
};

const requestBridge = (socketPath, request) =>
	new Promise((resolveResponse, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let bytes = 0;
		let finished = false;
		const finishError = (error) => {
			if (finished) return;
			finished = true;
			socket.destroy();
			reject(error);
		};
		socket.setEncoding("utf8");
		socket.setTimeout(RESPONSE_TIMEOUT_MS, () =>
			finishError(Error("CLI bridge response timed out."))
		);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk) => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > MAX_RESPONSE_BYTES) {
				finishError(Error("CLI bridge response is too large."));
				return;
			}
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline));
				finished = true;
				socket.end();
				resolveResponse(response);
			} catch {
				finishError(Error("CLI bridge returned invalid JSON."));
			}
		});
		socket.once("error", finishError);
	});

const exitCodeFor = (response) => {
	if (response.ok) return 0;
	const code = response.error?.code;
	if (["preflight_warnings", "preflight_required", "stale_preflight", "confirmation_required"].includes(code)) return 4;
	if (["publication_failed", "repair_failed", "configuration_required"].includes(code)) return 5;
	return 3;
};

const main = async () => {
	const options = parseArguments(process.argv.slice(2));
	const vault = resolveVault(options.vault);
	const request = {
		protocol: PROTOCOL,
		id: randomUUID(),
		operation: options.operation,
		...(options.note ? { path: resolveNote(options.note, vault) } : {}),
		...(options.confirm ? { confirm: true } : {}),
		...(options.allowWarnings ? { allowWarnings: true } : {}),
		...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
	};
	try {
		const response = await requestBridge(socketPathForVault(vault), request);
		process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
		process.exitCode = exitCodeFor(response);
	} catch (error) {
		const response = {
			protocol: PROTOCOL,
			id: request.id,
			ok: false,
			error: {
				code: "bridge_unavailable",
				message: `${error instanceof Error ? error.message : String(error)} Ensure Obsidian is running with Notional Vault Publisher enabled.`,
			},
		};
		process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
		process.exitCode = 3;
	}
};

await main();
