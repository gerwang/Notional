import { createHash } from "crypto";
import {
	appendFile,
	chmod,
	lstat,
	mkdir,
	realpath,
	unlink,
} from "fs/promises";
import { createConnection, createServer, Server, Socket } from "net";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { TFile } from "obsidian";
import type NObsidian from "main";
import {
	PublicationPreflight,
	collectPublishedInboundLinks,
	preflightPublication,
	publishFile,
	republishPublishedPreflights,
} from "./publisher";
import {
	CLI_MAX_REQUEST_BYTES,
	CLI_PROTOCOL_VERSION,
	CliBridgeError,
	CliRequest,
	CliResponse,
	errorResponse,
	parseCliRequest,
	socketPathForVault,
	successResponse,
} from "./cli-protocol";

type CliBridgeOptions = {
	runtimeDirectory?: string;
	stateDirectory?: string;
};

type PreparedNote = {
	file: TFile;
	preflight: PublicationPreflight;
	fingerprint: string;
	summary: Record<string, unknown>;
};

const REQUEST_TIMEOUT_MS = 30_000;

const errnoCode = (error: unknown): string | number | undefined =>
	(error as { code?: string | number } | null)?.code;

const pluginVaultPath = (plugin: NObsidian): string => {
	const adapter = plugin.app.vault.adapter as { getBasePath?: () => string };
	const basePath = adapter.getBasePath?.();
	if (!basePath) {
		throw new CliBridgeError(
			"unsupported_vault",
			"The CLI bridge requires a local filesystem vault."
		);
	}
	return basePath;
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory()) {
		throw new CliBridgeError(
			"unsafe_runtime_path",
			`Refusing to use a non-directory runtime path: ${path}`
		);
	}
	if (process.getuid && stat.uid !== process.getuid()) {
		throw new CliBridgeError(
			"unsafe_runtime_path",
			`Refusing to use a runtime path owned by another user: ${path}`
		);
	}
	await chmod(path, 0o700);
};

const fingerprintPreflight = async (
	plugin: NObsidian,
	file: TFile,
	preflight: PublicationPreflight
): Promise<string> => {
	const rawMarkdown = await plugin.app.vault.read(file);
	const attachments = [];
	for (const attachment of preflight.attachments) {
		const bytes = await plugin.app.vault.readBinary(attachment.file);
		attachments.push({
			path: attachment.file.path,
			size: attachment.file.stat.size,
			mtime: attachment.file.stat.mtime,
			contentHash: createHash("sha256")
				.update(Buffer.from(bytes))
				.digest("hex"),
			kind: attachment.kind,
			marker: attachment.marker,
		});
	}
	return createHash("sha256")
		.update(
			JSON.stringify({
				filePath: file.path,
				rawMarkdown,
				publicationMarkdown: preflight.markdown,
				attachments,
				databaseID: plugin.settings.databaseID,
				dataSourceID: plugin.settings.dataSourceID,
				databaseAlias: plugin.settings.databaseAlias,
				titleProperty: plugin.settings.titleProperty,
				tagsProperty: plugin.settings.tagsProperty,
				allowTags: plugin.settings.allowTags,
				maxUploadBytes: plugin.settings.maxUploadBytes,
				excludedFolders: plugin.settings.excludedFolders,
			})
		)
		.digest("hex");
};

const preflightSummary = (
	file: TFile,
	preflight: PublicationPreflight,
	fingerprint: string
): Record<string, unknown> => ({
	filePath: file.path,
	fingerprint,
	identity: {
		published: Boolean(preflight.pageId),
		pageId: preflight.pageId,
		pageUrl: preflight.pageUrl,
	},
	reviewStatus:
		typeof preflight.frontmatter.review_status === "string"
			? preflight.frontmatter.review_status
			: undefined,
	warnings: preflight.warnings,
	attachments: preflight.attachments.map((attachment) => ({
		path: attachment.file.path,
		kind: attachment.kind,
		size: attachment.file.stat.size,
	})),
	linkedNotes: preflight.linkedFiles.map((linked) => linked.path),
});

const prepareNote = async (
	plugin: NObsidian,
	file: TFile
): Promise<PreparedNote> => {
	const result = await preflightPublication(plugin, file);
	if (result.error) {
		throw new CliBridgeError("preflight_failed", result.error.message);
	}
	const fingerprint = await fingerprintPreflight(plugin, file, result.data);
	return {
		file,
		preflight: result.data,
		fingerprint,
		summary: preflightSummary(file, result.data, fingerprint),
	};
};

const requireFingerprint = (
	request: CliRequest,
	actualFingerprint: string
): void => {
	if (!request.fingerprint) {
		throw new CliBridgeError(
			"preflight_required",
			"Run preflight first and pass its fingerprint."
		);
	}
	if (request.fingerprint !== actualFingerprint) {
		throw new CliBridgeError(
			"stale_preflight",
			"The note, its resolved assets, or publication settings changed after preflight."
		);
	}
};

const requirePublicationApproval = (request: CliRequest): void => {
	if (!request.confirm) {
		throw new CliBridgeError(
			"confirmation_required",
			"Publication requires the explicit --confirm flag."
		);
	}
};

const requireWarningsApproval = (
	request: CliRequest,
	warnings: unknown[],
	data: unknown
): void => {
	if (warnings.length && !request.allowWarnings) {
		throw new CliBridgeError(
			"preflight_warnings",
			"Preflight reported warnings. Review them before publishing.",
			data
		);
	}
};

const resolveNote = (plugin: NObsidian, path: string): TFile => {
	const abstractFile = plugin.app.vault.getAbstractFileByPath(path);
	if (!(abstractFile instanceof TFile) || abstractFile.extension !== "md") {
		throw new CliBridgeError("note_not_found", `Markdown note not found: ${path}`);
	}
	return abstractFile;
};

export class NotionalCliBridge {
	private server: Server | null = null;
	private connections = new Set<Socket>();
	private ownsSocket = false;
	private operationQueue: Promise<void> = Promise.resolve();
	private vaultPath = "";
	private socketPath = "";
	private auditPath = "";

	constructor(
		private plugin: NObsidian,
		private options: CliBridgeOptions = {}
	) {}

	getSocketPath(): string {
		return this.socketPath;
	}

	async start(): Promise<void> {
		if (this.server) return;
		this.vaultPath = await realpath(pluginVaultPath(this.plugin));
		const runtimeDirectory =
			this.options.runtimeDirectory ||
			process.env.XDG_RUNTIME_DIR ||
			join(tmpdir(), `notional-${process.getuid?.() ?? "user"}`);
		this.socketPath = socketPathForVault(this.vaultPath, runtimeDirectory);
		await ensurePrivateDirectory(runtimeDirectory);
		await ensurePrivateDirectory(dirname(this.socketPath));
		await this.removeStaleSocket();

		const stateDirectory =
			this.options.stateDirectory ||
			process.env.XDG_STATE_HOME ||
			join(homedir(), ".local", "state");
		this.auditPath = join(
			stateDirectory,
			"notional-vault-publisher",
			"audit.jsonl"
		);
		await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
		await ensurePrivateDirectory(dirname(this.auditPath));

		this.server = createServer((socket) => this.handleConnection(socket));
		this.server.on("error", (error) => {
			if (this.server) {
				console.error("Notional CLI bridge server error", error);
			}
		});
		await new Promise<void>((resolve, reject) => {
			const server = this.server;
			if (!server) return reject(Error("CLI server was not created."));
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				this.ownsSocket = true;
				resolve();
			});
		});
		await chmod(this.socketPath, 0o600);
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		for (const socket of this.connections) socket.destroy();
		this.connections.clear();
		if (server?.listening) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (this.socketPath && this.ownsSocket) {
			this.ownsSocket = false;
			try {
				await unlink(this.socketPath);
			} catch (error) {
				if (errnoCode(error) !== "ENOENT") throw error;
			}
		}
	}

	private async removeStaleSocket(): Promise<void> {
		try {
			const stat = await lstat(this.socketPath);
			if (!stat.isSocket()) {
				throw new CliBridgeError(
					"unsafe_socket_path",
					"Refusing to replace a non-socket runtime path."
				);
			}
			if (process.getuid && stat.uid !== process.getuid()) {
				throw new CliBridgeError(
					"unsafe_socket_path",
					"Refusing to replace a socket owned by another user."
				);
			}
			if (await this.socketIsActive()) {
				throw new CliBridgeError(
					"bridge_already_running",
					"A CLI bridge is already serving this vault."
				);
			}
			await unlink(this.socketPath);
		} catch (error) {
			if (errnoCode(error) !== "ENOENT") throw error;
		}
	}

	private socketIsActive(): Promise<boolean> {
		return new Promise((resolve) => {
			const probe = createConnection(this.socketPath);
			let settled = false;
			const finish = (active: boolean) => {
				if (settled) return;
				settled = true;
				probe.destroy();
				resolve(active);
			};
			probe.setTimeout(250, () => finish(false));
			probe.once("connect", () => finish(true));
			probe.once("error", () => finish(false));
		});
	}

	private handleConnection(socket: Socket): void {
		this.connections.add(socket);
		socket.once("close", () => this.connections.delete(socket));
		let buffer = "";
		let byteCount = 0;
		let finished = false;
		const finish = (response: CliResponse) => {
			if (finished) return;
			finished = true;
			socket.end(`${JSON.stringify(response)}\n`);
		};

		socket.setEncoding("utf8");
		socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
			finish(errorResponse("unknown", new CliBridgeError("timeout", "Request timed out.")));
		});
		socket.on("data", (chunk: string) => {
			if (finished) return;
			byteCount += Buffer.byteLength(chunk);
			if (byteCount > CLI_MAX_REQUEST_BYTES) {
				finish(
					errorResponse(
						"unknown",
						new CliBridgeError("request_too_large", "Request is too large.")
					)
				);
				return;
			}
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			socket.setTimeout(0);
			socket.pause();
			const line = buffer.slice(0, newline);
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				finish(
					errorResponse(
						"unknown",
						new CliBridgeError("invalid_json", "Request is not valid JSON.")
					)
				);
				return;
			}
			let request: CliRequest;
			try {
				request = parseCliRequest(raw);
			} catch (error) {
				const id =
					raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
						? String((raw as { id: string }).id).slice(0, 128)
						: "unknown";
				finish(errorResponse(id, error));
				return;
			}
			void this.enqueue(request).then(finish);
		});
		socket.once("error", () => {
			finished = true;
		});
	}

	private enqueue(request: CliRequest): Promise<CliResponse> {
		let resolveResponse: (response: CliResponse) => void = () => undefined;
		const response = new Promise<CliResponse>((resolve) => {
			resolveResponse = resolve;
		});
		this.operationQueue = this.operationQueue
			.then(async () => {
				let result: CliResponse;
				try {
					result = successResponse(
						request.id,
						await this.execute(request)
					);
				} catch (error) {
					result = errorResponse(request.id, error);
				}
				await this.writeAudit(request, result);
				resolveResponse(result);
			})
			.catch((error) => {
				resolveResponse(errorResponse(request.id, error));
			});
		return response;
	}

	private async execute(request: CliRequest): Promise<unknown> {
		if (request.operation === "status") {
			return {
				pluginVersion: this.plugin.manifest.version,
				protocol: CLI_PROTOCOL_VERSION,
				vaultPath: this.vaultPath,
				socketPath: this.socketPath,
				keyringStatus: this.plugin.keyringCredentialState.status,
				credentialsAvailable: this.plugin.hasValidNotionCredentials(),
				databaseConfigured: Boolean(this.plugin.settings.databaseID),
			};
		}

		const file = resolveNote(this.plugin, request.path as string);
		if (request.operation === "preflight") {
			return (await prepareNote(this.plugin, file)).summary;
		}
		if (request.operation === "publish") {
			requirePublicationApproval(request);
			if (!this.plugin.hasValidNotionCredentials()) {
				throw new CliBridgeError(
					"configuration_required",
					"Notion credentials and database configuration are required."
				);
			}
			const prepared = await prepareNote(this.plugin, file);
			requireFingerprint(request, prepared.fingerprint);
			requireWarningsApproval(
				request,
				prepared.preflight.warnings,
				prepared.summary
			);
			const result = await publishFile(this.plugin, file, prepared.preflight);
			if (result.error) {
				throw new CliBridgeError("publication_failed", result.error.message);
			}
			return { ...result.data, approvedFingerprint: prepared.fingerprint };
		}

		return this.executeRepair(request, file);
	}

	private async executeRepair(
		request: CliRequest,
		target: TFile
	): Promise<unknown> {
		const collected = await collectPublishedInboundLinks(this.plugin, target);
		if (collected.error) {
			throw new CliBridgeError("repair_preflight_failed", collected.error.message);
		}
		const prepared: PreparedNote[] = [];
		for (const file of collected.data) {
			prepared.push(await prepareNote(this.plugin, file));
		}
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify(
					prepared.map((item) => ({
						filePath: item.file.path,
						fingerprint: item.fingerprint,
					}))
				)
			)
			.digest("hex");
		const warnings = prepared.flatMap((item) =>
			item.preflight.warnings.map((warning) => ({
				filePath: item.file.path,
				...warning,
			}))
		);
		const plan = {
			targetPath: target.path,
			fingerprint,
			pages: prepared.map((item) => item.summary),
			warnings,
		};
		if (!request.confirm) return plan;
		if (!this.plugin.hasValidNotionCredentials()) {
			throw new CliBridgeError(
				"configuration_required",
				"Notion credentials and database configuration are required."
			);
		}
		requireFingerprint(request, fingerprint);
		requireWarningsApproval(request, warnings, plan);
		const result = await republishPublishedPreflights(
			this.plugin,
			prepared.map((item) => ({
				file: item.file,
				preflight: item.preflight,
			}))
		);
		if (result.error) {
			throw new CliBridgeError("repair_failed", result.error.message);
		}
		return {
			targetPath: target.path,
			approvedFingerprint: fingerprint,
			results: result.data,
		};
	}

	private async writeAudit(
		request: CliRequest,
		response: CliResponse
	): Promise<void> {
		if (!this.auditPath) return;
		const responseData = response.data as
			| { pageId?: string; results?: Array<{ pageId?: string }> }
			| undefined;
		const entry = {
			timestamp: new Date().toISOString(),
			requestId: request.id,
			operation: request.operation,
			path: request.path,
			confirmed: Boolean(request.confirm),
			warningsAccepted: Boolean(request.allowWarnings),
			ok: response.ok,
			errorCode: response.error?.code,
			pageIds: responseData?.pageId
				? [responseData.pageId]
				: responseData?.results
						?.map((result) => result.pageId)
						.filter(Boolean),
		};
		try {
			try {
				const stat = await lstat(this.auditPath);
				if (!stat.isFile()) return;
				if (process.getuid && stat.uid !== process.getuid()) return;
			} catch (error) {
				if (errnoCode(error) !== "ENOENT") return;
			}
			await appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await chmod(this.auditPath, 0o600);
		} catch {
			// Publication results must not be changed by a local audit-log failure.
		}
	}
}
