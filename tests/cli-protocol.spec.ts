import {
	CLI_PROTOCOL_VERSION,
	CliBridgeError,
	parseCliRequest,
	socketPathForVault,
	validateVaultRelativeMarkdownPath,
} from "../service/cli-protocol";

describe("CLI protocol", () => {
	it("accepts a versioned single-note publication request", () => {
		expect(
			parseCliRequest({
				protocol: CLI_PROTOCOL_VERSION,
				id: "request-123",
				operation: "publish",
				path: "30 Topics/Test.md",
				confirm: true,
				allowWarnings: false,
				fingerprint: "a".repeat(64),
			})
		).toEqual({
			protocol: CLI_PROTOCOL_VERSION,
			id: "request-123",
			operation: "publish",
			path: "30 Topics/Test.md",
			confirm: true,
			allowWarnings: false,
			fingerprint: "a".repeat(64),
		});
	});

	it.each([
		"../Outside.md",
		"Folder/../../Outside.md",
		"/absolute/Note.md",
		"C:\\absolute\\Note.md",
		"image.png",
	])("rejects unsafe or non-Markdown paths: %s", (path) => {
		expect(() => validateVaultRelativeMarkdownPath(path)).toThrow(
			CliBridgeError
		);
	});

	it("normalizes harmless relative paths", () => {
		expect(validateVaultRelativeMarkdownPath("./30 Topics\\Test.md")).toBe(
			"30 Topics/Test.md"
		);
	});

	it("rejects fields that are not valid for an operation", () => {
		expect(() =>
			parseCliRequest({
				protocol: CLI_PROTOCOL_VERSION,
				id: "status-flags",
				operation: "status",
				confirm: true,
			})
		).toThrow("Unexpected request field");
	});

	it("uses a stable vault-specific socket path", () => {
		const first = socketPathForVault("/vault/one", "/run/user/1000");
		const same = socketPathForVault("/vault/one", "/run/user/1000");
		const other = socketPathForVault("/vault/two", "/run/user/1000");
		expect(first).toBe(same);
		expect(first).not.toBe(other);
		expect(first).toMatch(
			/^\/run\/user\/1000\/notional-vault-publisher\/[a-f0-9]{16}\.sock$/
		);
	});
});
