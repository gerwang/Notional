jest.mock("obsidian");

import { requestUrl } from "obsidian";
import {
	buildNotionOAuthUrl,
	exchangeNotionOAuthCode,
	extractNotionOAuthCode,
} from "../service/oauth";
import { PluginSettings } from "../service/types";

const settings: PluginSettings = {
	notionAPIToken: "",
	notionOAuthClientId: "client-id",
	notionOAuthRedirectUri: "https://example.com/notion/callback",
	notionOAuthTokenExchangeUrl: "https://example.com/api/notion/oauth/token",
	notionOAuthWorkspaceId: "",
	notionOAuthWorkspaceName: "",
	notionOAuthRefreshToken: "",
	databaseID: "",
	notionParentPageUrl: "",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: false,
	autoSync: false,
	autoSyncIntervalMinutes: 5,
};

beforeEach(() => {
	jest.clearAllMocks();
});

describe("buildNotionOAuthUrl", () => {
	it("builds Notion's authorization URL", () => {
		const url = new URL(
			buildNotionOAuthUrl(
				"client-id",
				"https://example.com/notion/callback",
				"state-value"
			)
		);

		expect(url.origin + url.pathname).toBe(
			"https://api.notion.com/v1/oauth/authorize"
		);
		expect(url.searchParams.get("owner")).toBe("user");
		expect(url.searchParams.get("client_id")).toBe("client-id");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://example.com/notion/callback"
		);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("state")).toBe("state-value");
	});
});

describe("extractNotionOAuthCode", () => {
	it("extracts a code from a callback URL", () => {
		expect(
			extractNotionOAuthCode(
				"https://example.com/notion/callback?code=abc123&state=ignored"
			)
		).toBe("abc123");
	});

	it("accepts a bare code", () => {
		expect(extractNotionOAuthCode("abc123")).toBe("abc123");
	});
});

describe("exchangeNotionOAuthCode", () => {
	it("exchanges a callback URL through the configured endpoint", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 200,
			json: {
				access_token: "oauth-token",
				refresh_token: "refresh-token",
				workspace_id: "workspace-id",
				workspace_name: "Workspace",
			},
		});

		const result = await exchangeNotionOAuthCode(
			settings,
			"https://example.com/notion/callback?code=abc123"
		);

		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: settings.notionOAuthTokenExchangeUrl,
				method: "POST",
				body: JSON.stringify({
					code: "abc123",
					redirect_uri: settings.notionOAuthRedirectUri,
				}),
			})
		);
		expect(result.error).toBeNull();
		expect(result.data.access_token).toBe("oauth-token");
		expect(result.data.workspace_name).toBe("Workspace");
	});

	it("requires a configured exchange endpoint", async () => {
		const result = await exchangeNotionOAuthCode(
			{ ...settings, notionOAuthTokenExchangeUrl: "" },
			"abc123"
		);

		expect(result.error?.message).toContain("exchange endpoint");
		expect(requestUrl).not.toHaveBeenCalled();
	});
});
