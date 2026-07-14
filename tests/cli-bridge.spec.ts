jest.mock("obsidian");
jest.mock("main");

import { mkdir, mkdtemp, readFile, rm, stat } from "fs/promises";
import { execFile } from "child_process";
import { createConnection } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { TFile, requestUrl } from "obsidian";
import { NotionalCliBridge } from "../service/cli-bridge";
import { CLI_PROTOCOL_VERSION, CliResponse } from "../service/cli-protocol";
import { PluginSettings } from "../service/types";

const execFileAsync = promisify(execFile);

const request = (socketPath: string, body: object): Promise<CliResponse> =>
	new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.once("connect", () => {
			socket.write(`${JSON.stringify(body)}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			socket.end();
			resolve(JSON.parse(buffer.slice(0, newline)) as CliResponse);
		});
		socket.once("error", reject);
	});

const makeSettings = (): PluginSettings => ({
	notionAPIToken: "",
	notionOAuthClientId: "",
	notionOAuthClientSecret: "",
	notionOAuthRedirectUri: "",
	notionOAuthTokenExchangeUrl: "",
	notionOAuthAccessToken: "",
	notionOAuthWorkspaceId: "",
	notionOAuthWorkspaceName: "",
	notionOAuthRefreshToken: "",
	databaseID: "database-id",
	dataSourceID: "",
	databaseAlias: "obsidian-vault",
	titleProperty: "Name",
	tagsProperty: "tags",
	excludedFolders: ["01 Templates"],
	maxUploadBytes: 5 * 1024 * 1024,
	notionParentPageUrl: "",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: false,
	autoSync: false,
	autoSyncIntervalMinutes: 5,
});

describe("Notional CLI bridge", () => {
	let root: string;
	let runtimeDirectory: string;
	let stateDirectory: string;
	let bridge: NotionalCliBridge | null;
	let markdown = "Body";
	let reviewStatus = "reviewed";

	beforeEach(async () => {
		jest.clearAllMocks();
		root = await mkdtemp(join(tmpdir(), "notional-vault-"));
		runtimeDirectory = join(root, "runtime");
		stateDirectory = join(root, "state");
		await mkdir(join(root, ".obsidian"));
		bridge = null;
		markdown = "Body";
		reviewStatus = "reviewed";
	});

	afterEach(async () => {
		await bridge?.stop();
		await rm(root, { recursive: true, force: true });
	});

	const makePlugin = () => {
		const file = new TFile();
		file.path = "30 Topics/Test.md";
		file.name = "Test.md";
		file.basename = "Test";
		file.extension = "md";
		file.stat = { ctime: 1, mtime: 1, size: 4 };
		const settings = makeSettings();
		return {
			manifest: { version: "0.3.1" },
			settings,
			keyringCredentialState: { status: "loaded" },
			hasValidNotionCredentials: jest.fn().mockReturnValue(true),
			getLinkedMarkdownFile: jest.fn().mockReturnValue(null),
			getContent: jest.fn().mockImplementation(async () => ({
				__content: markdown,
				type: "topic",
				knowledge_role: "synthesis",
				review_status: reviewStatus,
			})),
			app: {
				vault: {
					adapter: { getBasePath: () => root },
					getAbstractFileByPath: jest.fn((path: string) =>
						path === file.path ? file : null
					),
					getFiles: jest.fn().mockReturnValue([]),
					read: jest.fn().mockImplementation(async () => markdown),
					readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
				},
				metadataCache: {
					resolvedLinks: {},
					getFileCache: jest.fn(),
				},
			},
		};
	};

	it("serves status and preflight through a mode-0600 socket", async () => {
		const plugin = makePlugin();
		bridge = new NotionalCliBridge(plugin as never, {
			runtimeDirectory,
			stateDirectory,
		});
		await bridge.start();
		const socketPath = bridge.getSocketPath();
		expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

		const status = await request(socketPath, {
			protocol: CLI_PROTOCOL_VERSION,
			id: "status-1",
			operation: "status",
		});
		expect(status).toMatchObject({
			ok: true,
			data: {
				pluginVersion: "0.3.1",
				keyringStatus: "loaded",
				credentialsAvailable: true,
			},
		});

		const preflight = await request(socketPath, {
			protocol: CLI_PROTOCOL_VERSION,
			id: "preflight-1",
			operation: "preflight",
			path: "30 Topics/Test.md",
		});
		expect(preflight.ok).toBe(true);
		expect(preflight.data).toMatchObject({
			filePath: "30 Topics/Test.md",
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			warnings: [],
		});
		expect(requestUrl).not.toHaveBeenCalled();

		const auditPath = join(
			stateDirectory,
			"notional-vault-publisher",
			"audit.jsonl"
		);
		expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
		expect(await readFile(auditPath, "utf8")).not.toContain("token");
	});

	it("serves the dependency-free CLI over the vault-specific socket", async () => {
		const plugin = makePlugin();
		bridge = new NotionalCliBridge(plugin as never, {
			runtimeDirectory,
			stateDirectory,
		});
		await bridge.start();

		const { stdout } = await execFileAsync(
			process.execPath,
			[join(process.cwd(), "bin", "notional-publish.mjs"), "status", "--vault", root],
			{
				env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory },
			}
		);
		expect(JSON.parse(stdout)).toMatchObject({
			ok: true,
			data: {
				pluginVersion: "0.3.1",
				vaultPath: root,
			},
		});
	});

	it("rejects publication when the preflight fingerprint becomes stale", async () => {
		const plugin = makePlugin();
		bridge = new NotionalCliBridge(plugin as never, {
			runtimeDirectory,
			stateDirectory,
		});
		await bridge.start();
		const socketPath = bridge.getSocketPath();
		const preflight = await request(socketPath, {
			protocol: CLI_PROTOCOL_VERSION,
			id: "preflight-2",
			operation: "preflight",
			path: "30 Topics/Test.md",
		});
		const fingerprint = (preflight.data as { fingerprint: string }).fingerprint;
		markdown = "Changed body";

		const publication = await request(socketPath, {
			protocol: CLI_PROTOCOL_VERSION,
			id: "publish-1",
			operation: "publish",
			path: "30 Topics/Test.md",
			confirm: true,
			fingerprint,
		});

		expect(publication).toMatchObject({
			ok: false,
			error: { code: "stale_preflight" },
		});
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("requires confirmation and explicit acceptance of preflight warnings", async () => {
		reviewStatus = "in-review";
		const plugin = makePlugin();
		bridge = new NotionalCliBridge(plugin as never, {
			runtimeDirectory,
			stateDirectory,
		});
		await bridge.start();
		const socketPath = bridge.getSocketPath();
		const preflight = await request(socketPath, {
			protocol: CLI_PROTOCOL_VERSION,
			id: "preflight-warnings",
			operation: "preflight",
			path: "30 Topics/Test.md",
		});
		const data = preflight.data as {
			fingerprint: string;
			warnings: Array<{ code: string }>;
		};
		expect(data.warnings).toContainEqual(
			expect.objectContaining({ code: "unreviewed-note" })
		);

		const unconfirmed = await request(socketPath, {
			protocol: CLI_PROTOCOL_VERSION,
			id: "publish-unconfirmed",
			operation: "publish",
			path: "30 Topics/Test.md",
			fingerprint: data.fingerprint,
		});
		expect(unconfirmed).toMatchObject({
			ok: false,
			error: { code: "confirmation_required" },
		});

		const warningsNotAccepted = await request(socketPath, {
			protocol: CLI_PROTOCOL_VERSION,
			id: "publish-warnings",
			operation: "publish",
			path: "30 Topics/Test.md",
			confirm: true,
			fingerprint: data.fingerprint,
		});
		expect(warningsNotAccepted).toMatchObject({
			ok: false,
			error: { code: "preflight_warnings" },
		});
		expect(requestUrl).not.toHaveBeenCalled();
	});
});
