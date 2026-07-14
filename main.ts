/*
    Originally created by EasyChris (2022)
    Modified by Quan Phan (2023)

    This file is part of Notional and is licensed under the GNU General Public License v3.0.
    Modifications by the Notional maintainers are tracked in the project's Git history.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import {
	App,
	Notice,
	ObsidianProtocolData,
	Plugin,
	PluginManifest,
	TFile,
	TFolder,
} from "obsidian";
import {
	PluginSettings,
	MarkdownWithFrontMatter,
	NotionOAuthTokenResponse,
	ServiceResult,
} from "service/types";
import {
	buildNotionOAuthUrl,
	completeNotionOAuth,
	generateOAuthState,
	hasNotionCredentials,
	isMatchingOAuthState,
} from "./service/oauth";
import { NObsidianSettingTab } from "settingTab";
import {
	NoticeMessageConfig,
	parseFrontMatter,
} from "service/utils";
import { uploadFile } from "service";
import {
	preflightPublication,
	publishFiles,
	publishLinkedClosure,
} from "./service/publisher";

// Define your default settings
const DEFAULT_SETTINGS: PluginSettings = {
	notionAPIToken: "",
	notionOAuthClientId: "",
	notionOAuthClientSecret: "",
	notionOAuthRedirectUri: "https://bryanbans.github.io/Notional/oauth-callback.html",
	notionOAuthTokenExchangeUrl: "",
	notionOAuthAccessToken: "",
	notionOAuthWorkspaceId: "",
	notionOAuthWorkspaceName: "",
	notionOAuthRefreshToken: "",
	databaseID: "",
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
};

// obsidian://notional-oauth?code=… — the static redirect page bounces the
// Notion callback here so the connect flow stays inside Obsidian.
const OAUTH_PROTOCOL_ACTION = "notional-oauth";

export default class NObsidian extends Plugin {
	settings: PluginSettings;
	message: { [key: string]: string };

	// In-flight OAuth: the CSRF state lives only in memory for the duration of
	// a single connect, never on disk.
	private pendingOAuthState: string | null = null;
	// Set by the settings tab so a callback that lands while it is open can
	// re-render the connection status.
	oauthRefresh: (() => void) | null = null;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.settings = DEFAULT_SETTINGS;
		this.message = NoticeMessageConfig("en");
	}

	async onload() {
		// Retrieve settings from settings tab
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			((await this.loadData()) as Partial<PluginSettings>)
		);

		// Publication is explicit. The fork never pulls from Notion or publishes
		// merely because a note changed.
		this.addRibbonIcon("upload-cloud", "Publish current note to Notion", () => {
			void this.uploadCurrentNote();
		});

		// Add commands to vault
		this.addCustomCommands();

		// Add settings tab to plugin (before optional wiring, so a failure in
		// later registration can never leave the settings pane blank).
		this.addSettingTab(new NObsidianSettingTab(this.app, this));

		// Capture the OAuth redirect (obsidian://notional-oauth?code=…) so the
		// user never has to copy a code back into Obsidian by hand.
		try {
			this.registerObsidianProtocolHandler(
				OAUTH_PROTOCOL_ACTION,
				(params) => {
					void this.handleOAuthCallback(params);
				}
			);
		} catch (error) {
			console.error("Notional: could not register OAuth protocol handler", error);
		}
	}

	/**
	 * Begins the OAuth flow: generates a CSRF state, remembers it in memory for
	 * the callback, and opens Notion's authorization page.
	 */
	startNotionOAuth(): ServiceResult<string> {
		const { notionOAuthClientId, notionOAuthRedirectUri } = this.settings;
		if (!notionOAuthClientId || !notionOAuthRedirectUri) {
			return {
				data: "",
				error: Error(
					"Set the OAuth client ID and redirect URI under Advanced first."
				),
			};
		}

		const state = generateOAuthState();
		this.pendingOAuthState = state;

		const url = buildNotionOAuthUrl({
			clientId: notionOAuthClientId,
			redirectUri: notionOAuthRedirectUri,
			state,
		});
		window.open(url, "_blank", "noopener,noreferrer");
		return { data: url, error: null };
	}

	/**
	 * Completes OAuth from a pasted callback URL/code. Used as a manual fallback
	 * when the protocol handler does not fire (e.g. the redirect opened a
	 * different vault).
	 */
	async finishNotionOAuthFromInput(
		input: string
	): Promise<ServiceResult<NotionOAuthTokenResponse>> {
		return this.completeOAuth(input);
	}

	private async handleOAuthCallback(
		params: ObsidianProtocolData
	): Promise<void> {
		if (params.error) {
			new Notice(`Notion authorization was declined: ${params.error}`);
			return;
		}

		// Claim the in-flight request up front. The redirect can fire the
		// handler more than once; since Notion consumes the code on first use, a
		// duplicate would otherwise attempt a second exchange and surface a
		// spurious "code revoked" error after we have already connected.
		const pendingState = this.pendingOAuthState;
		this.pendingOAuthState = null;
		if (!pendingState) {
			return;
		}
		if (!isMatchingOAuthState(pendingState, params.state)) {
			new Notice(
				"The Notion callback did not match the pending request. Please connect again."
			);
			return;
		}
		if (!params.code) {
			new Notice("The Notion callback did not include an authorization code.");
			return;
		}

		await this.completeOAuth(params.code);
	}

	private async completeOAuth(
		codeOrCallbackUrl: string
	): Promise<ServiceResult<NotionOAuthTokenResponse>> {
		const result = await completeNotionOAuth(
			this.settings,
			codeOrCallbackUrl
		);
		if (result.error) {
			new Notice(`Notion connection failed: ${result.error.message}`);
			return result;
		}

		const data = result.data;
		this.settings.notionOAuthAccessToken = data.access_token;
		this.settings.notionOAuthRefreshToken = data.refresh_token || "";
		this.settings.notionOAuthWorkspaceId = data.workspace_id || "";
		this.settings.notionOAuthWorkspaceName = data.workspace_name || "";
		this.pendingOAuthState = null;
		await this.saveSettings();

		const workspace = data.workspace_name;
		new Notice(
			workspace
				? `Connected to Notion workspace “${workspace}”.`
				: "Connected to Notion."
		);
		this.oauthRefresh?.();
		return result;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	addCustomCommands() {
		this.addCommand({
			id: "share-to-notion",
			name: "Publish current note to Notion",
			editorCallback: async () => {
				void this.uploadCurrentNote();
			},
		});

		this.addCommand({
			id: "bulk-share-to-notion",
			name: "Publish current folder to Notion",
			callback: async () => {
				void this.uploadCurrentFolder();
			},
		});

		this.addCommand({
			id: "preflight-current-note",
			name: "Preflight current note (no upload)",
			editorCallback: async () => {
				void this.preflightCurrentNote();
			},
		});

		this.addCommand({
			id: "publish-linked-notes",
			name: "Publish current note and linked notes recursively",
			editorCallback: async () => {
				void this.publishCurrentNoteClosure();
			},
		});
	}

	async preflightCurrentNote() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice(this.message["open-file"]);
			return;
		}
		const result = await preflightPublication(this, file);
		if (result.error) {
			new Notice(`Preflight failed: ${result.error.message}`, 8000);
			return;
		}
		new Notice(
			`Preflight passed: ${result.data.attachments.length} embeds, ${result.data.linkedFiles.length} linked notes, ${result.data.warnings.length} warnings.`,
			8000
		);
		if (result.data.warnings.length) {
			console.warn("Notional publication warnings", result.data.warnings);
		}
	}

	async publishCurrentNoteClosure() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice(this.message["open-file"]);
			return;
		}
		const result = await publishLinkedClosure(this, file);
		if (result.error) {
			new Notice(`Recursive publication failed: ${result.error.message}`, 10000);
			return;
		}
		new Notice(`Published ${result.data.length} linked notes in place.`, 8000);
	}

	async uploadCurrentNote() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return null;
		}

		void this.uploadFile(nowFile);
	}

	async uploadCurrentFolder() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return;
		}

		const markdownFiles = this.collectUploadScope(nowFile);
		const result = await publishFiles(this, markdownFiles);
		if (result.error) {
			new Notice(`Folder publication failed: ${result.error.message}`, 10000);
			return;
		}
		new Notice(`Published ${result.data.length} notes in place.`, 8000);
	}

	getLinkedMarkdownFile(linkPath: string, sourcePath: string): TFile | null {
		return this.app.metadataCache.getFirstLinkpathDest(
			linkPath,
			sourcePath
		);
	}

	private collectUploadScope(file: TFile): TFile[] {
		const folder = file.parent;
		if (!folder || folder.isRoot()) return [file];

		return this.collectFolderNotes(folder);
	}

	private collectFolderNotes(folder: TFolder | null): TFile[] {
		if (!folder) return [];

		const markdownFiles: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === "md") {
				markdownFiles.push(child);
			} else if (child instanceof TFolder) {
				markdownFiles.push(...this.collectFolderNotes(child));
			}
		}

		return markdownFiles;
	}

	hasValidNotionCredentials() {
		return hasNotionCredentials(this.settings);
	}

	async uploadFile(file: TFile): Promise<ServiceResult> {
		const uploadResult = await uploadFile(this, file);
		this.displayResult(uploadResult, file.basename);
		return uploadResult;
	}

	async getContent(file: TFile): Promise<MarkdownWithFrontMatter> {
		const content = await this.app.vault.read(file);
		const contentWithFrontMatter = parseFrontMatter(content);
		return contentWithFrontMatter;
	}

	async updateMarkdownFile(file: TFile, newContent: string): Promise<void> {
		await file.vault.modify(file, newContent);
	}

	displayResult(uploadResult: ServiceResult, pageName: string) {
		if (uploadResult.error) {
			const errorMessage = uploadResult.error.message;
			new Notice(`${errorMessage}${pageName}`, 5000);
			return;
		}

		new Notice(`${this.message["sync-success"]}${pageName}`);
	}
}
