jest.mock("obsidian");

import { requestUrl } from "obsidian";
import {
	NOTION_OAUTH_TOKEN_URL,
	buildNotionOAuthUrl,
	completeNotionOAuth,
	createPkcePair,
	extractNotionOAuthCode,
	generateOAuthState,
	resolveNotionToken,
} from "../service/oauth";
import { PluginSettings } from "../service/types";

const settings: PluginSettings = {
	notionAPIToken: "",
	notionOAuthClientId: "client-id",
	notionOAuthRedirectUri: "https://example.com/notion/callback",
	notionOAuthTokenExchangeUrl: "",
	notionOAuthAccessToken: "",
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
	it("builds Notion's authorization URL with PKCE + state", () => {
		const url = new URL(
			buildNotionOAuthUrl({
				clientId: "client-id",
				redirectUri: "https://example.com/notion/callback",
				codeChallenge: "challenge-value",
				state: "state-value",
			})
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
		expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("state")).toBe("state-value");
	});

	it("omits PKCE params when no challenge is supplied", () => {
		const url = new URL(
			buildNotionOAuthUrl({
				clientId: "client-id",
				redirectUri: "https://example.com/notion/callback",
			})
		);
		expect(url.searchParams.has("code_challenge")).toBe(false);
		expect(url.searchParams.has("code_challenge_method")).toBe(false);
	});
});

describe("createPkcePair", () => {
	it("derives the S256 challenge from the verifier (RFC 7636 vector)", async () => {
		// RFC 7636 Appendix B reference vector.
		const verifier =
			"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		const encoder = new TextEncoder();
		const digest = await crypto.subtle.digest(
			"SHA-256",
			encoder.encode(verifier)
		);
		let binary = "";
		for (const byte of new Uint8Array(digest)) {
			binary += String.fromCharCode(byte);
		}
		const expected = btoa(binary)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=/g, "");
		expect(expected).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	it("produces a verifier and challenge within PKCE length bounds", async () => {
		const { codeVerifier, codeChallenge } = await createPkcePair();
		expect(codeVerifier).toMatch(/^[A-Za-z0-9\-_]+$/);
		expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
		expect(codeVerifier.length).toBeLessThanOrEqual(128);
		expect(codeChallenge).toMatch(/^[A-Za-z0-9\-_]+$/);
	});

	it("generates a fresh verifier each call", async () => {
		const a = await createPkcePair();
		const b = await createPkcePair();
		expect(a.codeVerifier).not.toBe(b.codeVerifier);
	});
});

describe("generateOAuthState", () => {
	it("produces a url-safe random value", () => {
		expect(generateOAuthState()).toMatch(/^[A-Za-z0-9\-_]+$/);
		expect(generateOAuthState()).not.toBe(generateOAuthState());
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

describe("resolveNotionToken", () => {
	it("prefers the OAuth access token", () => {
		expect(
			resolveNotionToken({
				...settings,
				notionOAuthAccessToken: "oauth-token",
				notionAPIToken: "manual-token",
			})
		).toBe("oauth-token");
	});

	it("falls back to the manual API token", () => {
		expect(
			resolveNotionToken({
				...settings,
				notionOAuthAccessToken: "",
				notionAPIToken: "manual-token",
			})
		).toBe("manual-token");
	});
});

describe("completeNotionOAuth", () => {
	it("exchanges directly with Notion via PKCE when no endpoint is set", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 200,
			json: {
				access_token: "oauth-token",
				refresh_token: "refresh-token",
				workspace_id: "workspace-id",
				workspace_name: "Workspace",
			},
		});

		const result = await completeNotionOAuth(settings, {
			codeOrCallbackUrl:
				"https://example.com/notion/callback?code=abc123",
			codeVerifier: "verifier-123",
		});

		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: NOTION_OAUTH_TOKEN_URL,
				method: "POST",
				body: JSON.stringify({
					grant_type: "authorization_code",
					code: "abc123",
					redirect_uri: settings.notionOAuthRedirectUri,
					client_id: settings.notionOAuthClientId,
					code_verifier: "verifier-123",
				}),
			})
		);
		// No client secret / Authorization header is sent in the PKCE path.
		const call = (requestUrl as jest.Mock).mock.calls[0][0];
		expect(call.headers.Authorization).toBeUndefined();
		expect(result.error).toBeNull();
		expect(result.data.access_token).toBe("oauth-token");
		expect(result.data.workspace_name).toBe("Workspace");
	});

	it("routes through a hosted endpoint when one is configured", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 200,
			json: { access_token: "hosted-token" },
		});

		const result = await completeNotionOAuth(
			{
				...settings,
				notionOAuthTokenExchangeUrl:
					"https://example.com/api/notion/oauth/token",
			},
			{
				codeOrCallbackUrl: "abc123",
				codeVerifier: "verifier-123",
			}
		);

		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/api/notion/oauth/token",
				method: "POST",
				body: JSON.stringify({
					code: "abc123",
					redirect_uri: settings.notionOAuthRedirectUri,
				}),
			})
		);
		expect(result.error).toBeNull();
		expect(result.data.access_token).toBe("hosted-token");
	});

	it("requires a code", async () => {
		const result = await completeNotionOAuth(settings, {
			codeOrCallbackUrl: "   ",
			codeVerifier: "verifier-123",
		});
		expect(result.error?.message).toContain("callback URL or code");
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("requires a PKCE verifier when exchanging directly", async () => {
		const result = await completeNotionOAuth(settings, {
			codeOrCallbackUrl: "abc123",
			codeVerifier: "",
		});
		expect(result.error?.message).toContain("PKCE verifier");
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("surfaces an error status from Notion", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 400,
			json: { error: "invalid_grant" },
		});

		const result = await completeNotionOAuth(settings, {
			codeOrCallbackUrl: "abc123",
			codeVerifier: "verifier-123",
		});
		expect(result.error?.message).toContain("invalid_grant");
	});
});
