jest.mock("obsidian");
jest.mock("@tryfabric/martian", () => ({
	markdownToBlocks: jest.fn(),
}));

import { markdownToBlocks } from "@tryfabric/martian";
import { requestUrl, TFile } from "obsidian";
import {
	compilePublicationBlocks,
	reconcilePage,
	uploadFile,
} from "../service/publisher-notion";
import { PluginSettings } from "../service/types";

const settings: PluginSettings = {
	notionAPIToken: "test-token",
	notionOAuthClientId: "",
	notionOAuthClientSecret: "",
	notionOAuthRedirectUri: "",
	notionOAuthTokenExchangeUrl: "",
	notionOAuthAccessToken: "",
	notionOAuthWorkspaceId: "",
	notionOAuthWorkspaceName: "",
	notionOAuthRefreshToken: "",
	databaseID: "database-id",
	dataSourceID: "data-source-id",
	databaseAlias: "obsidian-vault",
	titleProperty: "Name",
	tagsProperty: "tags",
	excludedFolders: ["01 Templates"],
	maxUploadBytes: 5 * 1024 * 1024,
	notionParentPageUrl: "",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: true,
	autoSync: false,
	autoSyncIntervalMinutes: 5,
};

const paragraph = (content: string, id?: string) => ({
	object: "block",
	id,
	type: "paragraph",
	paragraph: {
		rich_text: [
			{
				type: "text",
				text: { content },
				plain_text: content,
				href: null,
			},
		],
	},
});

describe("compilePublicationBlocks", () => {
	it("replaces an asset marker with a Notion-hosted image block", () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([
			paragraph("NOTIONAL_ASSET_0001"),
		]);
		const file = new TFile();
		file.path = "Note/figure.png";
		file.name = "figure.png";
		file.extension = "png";

		const blocks = compilePublicationBlocks("NOTIONAL_ASSET_0001", [
			{
				marker: "NOTIONAL_ASSET_0001",
				original: "![[Note/figure.png]]",
				file,
				caption: "result",
				kind: "image",
				fileUploadId: "upload-id",
			},
		]);

		expect(blocks[0]).toEqual({
			object: "block",
			type: "image",
			image: {
				type: "file_upload",
				file_upload: { id: "upload-id" },
				caption: [
					{ type: "text", text: { content: "result" } },
				],
			},
		});
	});
});

describe("reconcilePage", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("leaves identical blocks and their IDs untouched", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 200,
			json: { results: [paragraph("same", "block-1")], has_more: false },
		});

		const result = await reconcilePage(settings, "page-id", [
			paragraph("same"),
		]);

		expect(result.error).toBeNull();
		expect(result.data.unchanged).toBe(1);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it("updates compatible blocks in place instead of deleting them", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				status: 200,
				json: {
					results: [paragraph("before", "block-1")],
					has_more: false,
				},
			})
			.mockResolvedValue({ status: 200, json: {} });

		const result = await reconcilePage(settings, "page-id", [
			paragraph("after"),
		]);

		expect(result.error).toBeNull();
		expect(result.data.updated).toBe(1);
		const calls = (requestUrl as jest.Mock).mock.calls.map(([request]) => request);
		expect(calls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: "PATCH",
					url: "https://api.notion.com/v1/blocks/block-1",
				}),
			])
		);
		expect(calls.some((request) => request.method === "DELETE")).toBe(false);
	});

	it("inserts a new block between unchanged anchors", async () => {
		(requestUrl as jest.Mock).mockImplementation((request) => {
			if (request.method === "GET") {
				return Promise.resolve({
					status: 200,
					json: {
						results: [paragraph("A", "a"), paragraph("C", "c")],
						has_more: false,
					},
				});
			}
			return Promise.resolve({
				status: 200,
				json: { results: [{ id: "b", type: "paragraph" }] },
			});
		});

		const result = await reconcilePage(settings, "page-id", [
			paragraph("A"),
			paragraph("B"),
			paragraph("C"),
		]);

		expect(result.error).toBeNull();
		expect(result.data.inserted).toBe(1);
		const append = (requestUrl as jest.Mock).mock.calls
			.map(([request]) => request)
			.find(
				(request) =>
					request.method === "PATCH" &&
					request.url.endsWith("/page-id/children")
			);
		expect(JSON.parse(append.body).position).toEqual({
			type: "after_block",
			after_block: { id: "a" },
		});
	});

	it("preserves a nested file-upload ID while removing a block response ID", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				status: 200,
				json: { results: [], has_more: false },
			})
			.mockResolvedValueOnce({
				status: 200,
				json: { results: [{ id: "inserted", type: "image" }] },
			});

		const result = await reconcilePage(settings, "page-id", [
			{
				object: "block",
				id: "response-only-block-id",
				type: "image",
				image: {
					type: "file_upload",
					file_upload: { id: "upload-id" },
					caption: [],
				},
			},
		]);

		expect(result.error).toBeNull();
		const append = (requestUrl as jest.Mock).mock.calls[1][0];
		const child = JSON.parse(append.body).children[0];
		expect(child.id).toBeUndefined();
		expect(child.image.file_upload.id).toBe("upload-id");
	});
});

describe("uploadFile", () => {
	it("uses Notion's direct file upload lifecycle", async () => {
		jest.clearAllMocks();
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({
				status: 200,
				json: {
					id: "upload-id",
					upload_url:
						"https://api.notion.com/v1/file_uploads/upload-id/send",
				},
			})
			.mockResolvedValueOnce({ status: 200, json: { status: "uploaded" } });

		const result = await uploadFile(
			settings,
			"figure.png",
			"image/png",
			new Uint8Array([1, 2, 3]).buffer
		);

		expect(result).toEqual({ data: { id: "upload-id" }, error: null });
		const create = (requestUrl as jest.Mock).mock.calls[0][0];
		expect(JSON.parse(create.body)).toMatchObject({
			mode: "single_part",
			filename: "figure.png",
			content_type: "image/png",
		});
		const send = (requestUrl as jest.Mock).mock.calls[1][0];
		expect(send.headers["Content-Type"]).toContain("multipart/form-data");
		expect(send.body).toBeInstanceOf(ArrayBuffer);
	});
});
