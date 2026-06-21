import { requestUrl } from "obsidian";
import {
	NotionOAuthTokenResponse,
	PluginSettings,
	ServiceResult,
} from "./types";

export const NOTION_OAUTH_AUTHORIZE_URL =
	"https://api.notion.com/v1/oauth/authorize";

const errorResult = <T>(error: Error, data: unknown = null): ServiceResult<T> => ({
	data: data as T,
	error,
});

export const buildNotionOAuthUrl = (
	clientId: string,
	redirectUri: string,
	state?: string
): string => {
	const url = new URL(NOTION_OAUTH_AUTHORIZE_URL);
	url.searchParams.set("owner", "user");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	if (state) url.searchParams.set("state", state);
	return url.toString();
};

export const extractNotionOAuthCode = (input: string): string | null => {
	const trimmed = input.trim();
	if (!trimmed) return null;

	try {
		const url = new URL(trimmed);
		return url.searchParams.get("code");
	} catch {
		return trimmed;
	}
};

export const exchangeNotionOAuthCode = async (
	settings: PluginSettings,
	codeOrCallbackUrl: string
): Promise<ServiceResult<NotionOAuthTokenResponse>> => {
	const code = extractNotionOAuthCode(codeOrCallbackUrl);
	if (!code) {
		return errorResult(Error("Paste the Notion callback URL or code."));
	}

	const endpoint = settings.notionOAuthTokenExchangeUrl.trim();
	if (!endpoint) {
		return errorResult(
			Error("Set an OAuth token exchange endpoint before connecting.")
		);
	}

	try {
		const response = await requestUrl({
			url: endpoint,
			method: "POST",
			throw: false,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				code,
				redirect_uri: settings.notionOAuthRedirectUri,
			}),
		});

		if (response.status >= 400) {
			const body = response.json as { error?: string; message?: string };
			return errorResult(
				Error(
					body?.message ||
						body?.error ||
						`OAuth exchange failed with status ${response.status}`
				),
				response.json
			);
		}

		const data = response.json as Partial<NotionOAuthTokenResponse>;
		if (!data.access_token) {
			return errorResult(
				Error("OAuth exchange did not return an access token."),
				response.json
			);
		}

		return {
			data: {
				access_token: data.access_token,
				refresh_token: data.refresh_token ?? null,
				workspace_id: data.workspace_id ?? null,
				workspace_name: data.workspace_name ?? null,
				duplicated_template_id: data.duplicated_template_id ?? null,
			},
			error: null,
		};
	} catch (error) {
		return errorResult(
			Error(`Could not complete OAuth exchange: ${error}`)
		);
	}
};
