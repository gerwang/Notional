jest.mock("child_process", () => ({ execFile: jest.fn() }));

import { execFile } from "child_process";
import {
	getNotionKeyringState,
	getNotionKeyringToken,
	refreshNotionKeyringToken,
} from "../service/credentials";
import { resolveNotionToken } from "../service/oauth";
import { PluginSettings } from "../service/types";

const execFileMock = execFile as unknown as jest.Mock;

describe("Secret Service/KWallet credential retrieval", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("loads the fixed keyring entry without invoking a shell", async () => {
		execFileMock.mockImplementation(
			(
				_path: string,
				_args: string[],
				_options: object,
				callback: (error: Error | null, stdout: string) => void
			) => callback(null, "keyring-token\n")
		);

		const state = await refreshNotionKeyringToken();

		expect(execFileMock).toHaveBeenCalledWith(
			"/usr/bin/secret-tool",
			[
				"lookup",
				"application",
				"obsidian-llm-wiki",
				"variable",
				"NOTION_INTEGRATION_TOKEN",
			],
			expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
			expect.any(Function)
		);
		expect(state.status).toBe("loaded");
		expect(getNotionKeyringToken()).toBe("keyring-token");
		expect(
			resolveNotionToken({
				notionOAuthAccessToken: "",
				notionAPIToken: "manual-token",
			} as PluginSettings)
		).toBe("keyring-token");
		expect(
			resolveNotionToken({
				notionOAuthAccessToken: "oauth-token",
				notionAPIToken: "manual-token",
			} as PluginSettings)
		).toBe("oauth-token");
		expect(JSON.stringify(getNotionKeyringState())).not.toContain(
			"keyring-token"
		);
	});

	it("reports a missing entry and clears a previously loaded token", async () => {
		execFileMock.mockImplementationOnce(
			(
				_path: string,
				_args: string[],
				_options: object,
				callback: (error: Error | null, stdout: string) => void
			) => callback(null, "old-token\n")
		);
		await refreshNotionKeyringToken();
		execFileMock.mockImplementationOnce(
			(
				_path: string,
				_args: string[],
				_options: object,
				callback: (error: Error & { code?: number }, stdout: string) => void
			) => callback(Object.assign(Error("missing"), { code: 1 }), "")
		);

		const state = await refreshNotionKeyringToken();

		expect(state.status).toBe("missing");
		expect(getNotionKeyringToken()).toBe("");
		expect(
			resolveNotionToken({
				notionOAuthAccessToken: "",
				notionAPIToken: "manual-token",
			} as PluginSettings)
		).toBe("manual-token");
	});
});
