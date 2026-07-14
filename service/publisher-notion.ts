import { RequestUrlParam, RequestUrlResponse, requestUrl } from "obsidian";
import { markdownToBlocks } from "@tryfabric/martian";
import { resolveNotionToken } from "./oauth";
import { PluginSettings, ServiceResult } from "./types";
import { ResolvedAttachment } from "./publication";

export const NOTION_VERSION = "2026-03-11";
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 3;

export type NotionBlock = {
	id?: string;
	object?: string;
	type: string;
	has_children?: boolean;
	children?: NotionBlock[];
	[key: string]: unknown;
};

export type UploadedAttachment = ResolvedAttachment & {
	fileUploadId: string;
};

export type ReconcileReport = {
	unchanged: number;
	updated: number;
	inserted: number;
	deleted: number;
	rollbackAttempted: boolean;
	rollbackSucceeded: boolean;
};

type BlockChildrenResponse = {
	results?: NotionBlock[];
	has_more?: boolean;
	next_cursor?: string | null;
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => window.setTimeout(resolve, ms));

const notionRequest = async (
	options: RequestUrlParam
): Promise<RequestUrlResponse> => {
	for (let attempt = 0; ; attempt += 1) {
		const response = await requestUrl({ ...options, throw: false });
		if (response.status === undefined || response.status < 400) return response;
		if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) {
			const body = response.json as { message?: string } | undefined;
			throw Error(
				`Notion API ${response.status}: ${body?.message || "request failed"}`
			);
		}
		const retryAfter = Number(
			response.headers?.["retry-after"] || response.headers?.["Retry-After"]
		);
		await sleep(
			Number.isFinite(retryAfter) && retryAfter > 0
				? retryAfter * 1000
				: 500 * 2 ** attempt
		);
	}
};

const authHeaders = (settings: PluginSettings) => ({
	Authorization: `Bearer ${resolveNotionToken(settings)}`,
	"Notion-Version": NOTION_VERSION,
});

const jsonHeaders = (settings: PluginSettings) => ({
	...authHeaders(settings),
	"Content-Type": "application/json",
});

export const validateToken = async (
	settings: PluginSettings
): Promise<ServiceResult<{ name?: string }>> => {
	try {
		const response = await notionRequest({
			url: "https://api.notion.com/v1/users/me",
			method: "GET",
			headers: authHeaders(settings),
		});
		return {
			data: response.json as { name?: string },
			error: null,
		};
	} catch (error) {
		return {
			data: {},
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

const getChildren = (block: NotionBlock): NotionBlock[] => {
	if (Array.isArray(block.children)) return block.children;
	const typed = block[block.type] as { children?: NotionBlock[] } | undefined;
	return Array.isArray(typed?.children) ? typed.children : [];
};

const withoutChildren = (block: NotionBlock): NotionBlock => {
	const copy = { ...block };
	delete copy.children;
	const typed = copy[copy.type];
	if (typed && typeof typed === "object" && !Array.isArray(typed)) {
		const typedCopy = { ...(typed as Record<string, unknown>) };
		delete typedCopy.children;
		copy[copy.type] = typedCopy;
	}
	return copy;
};

const CREATE_KEYS = new Set(["object", "type"]);
const RESPONSE_ONLY_KEYS = new Set([
	"id",
	"parent",
	"created_time",
	"last_edited_time",
	"created_by",
	"last_edited_by",
	"has_children",
	"in_trash",
	"archived",
	"plain_text",
	"href",
]);

const sanitizeValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (RESPONSE_ONLY_KEYS.has(key)) continue;
		result[key] = sanitizeValue(item);
	}
	return result;
};

const sanitizeBlockForCreate = (block: NotionBlock): NotionBlock => {
	const clean: NotionBlock = { object: "block", type: block.type };
	for (const [key, value] of Object.entries(withoutChildren(block))) {
		if (CREATE_KEYS.has(key) || RESPONSE_ONLY_KEYS.has(key)) continue;
		clean[key] = sanitizeValue(value);
	}
	return clean;
};

const sanitizeTypedValue = (block: NotionBlock): unknown => {
	const clean = sanitizeBlockForCreate(block);
	return clean[block.type];
};

const normalizeForSignature = (block: NotionBlock): unknown => ({
	type: block.type,
	value: sanitizeTypedValue(block),
	children: getChildren(block).map(normalizeForSignature),
});

const signature = (block: NotionBlock): string =>
	JSON.stringify(normalizeForSignature(block));

const plainText = (block: NotionBlock): string => {
	const typed = block[block.type] as
		| { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> }
		| undefined;
	return (typed?.rich_text || [])
		.map((item) => item.plain_text || item.text?.content || "")
		.join("")
		.trim();
};

const convertPageMentions = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(convertPageMentions);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const text = record.text as { link?: { url?: string } } | undefined;
	const url = text?.link?.url || "";
	if (record.type === "text" && url.startsWith("notional://notion-page/")) {
		return {
			type: "mention",
			mention: {
				type: "page",
				page: { id: decodeURIComponent(url.slice(23)) },
			},
			annotations: record.annotations,
		};
	}
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		result[key] = convertPageMentions(item);
	}
	return result;
};

export const compilePublicationBlocks = (
	markdown: string,
	attachments: UploadedAttachment[]
): NotionBlock[] => {
	const byMarker = new Map(attachments.map((item) => [item.marker, item]));
	const blocks = convertPageMentions(markdownToBlocks(markdown)) as NotionBlock[];

	const transform = (items: NotionBlock[]): NotionBlock[] =>
		items.map((block) => {
			const attachment =
				block.type === "paragraph" ? byMarker.get(plainText(block)) : undefined;
			if (attachment) {
				const caption = attachment.caption
					? [
							{
								type: "text",
								text: { content: attachment.caption },
							},
						]
					: [];
				return {
					object: "block",
					type: attachment.kind,
					[attachment.kind]: {
						type: "file_upload",
						file_upload: { id: attachment.fileUploadId },
						caption,
					},
				};
			}

			const children = getChildren(block);
			if (children.length === 0) return block;
			const transformed = transform(children);
			const typed = block[block.type] as Record<string, unknown> | undefined;
			return {
				...block,
				[block.type]: { ...(typed || {}), children: transformed },
			};
		});

	return transform(blocks);
};

const buildMultipartBody = (
	filename: string,
	contentType: string,
	binary: ArrayBuffer
): { body: ArrayBuffer; boundary: string } => {
	const boundary = `----NotionalBoundary${crypto.randomUUID().replace(/-/g, "")}`;
	const safeFilename = filename.replace(/["\r\n]/g, "_");
	const encoder = new TextEncoder();
	const prefix = encoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${contentType}\r\n\r\n`
	);
	const bytes = new Uint8Array(binary);
	const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
	const output = new Uint8Array(prefix.length + bytes.length + suffix.length);
	output.set(prefix, 0);
	output.set(bytes, prefix.length);
	output.set(suffix, prefix.length + bytes.length);
	return { body: output.buffer, boundary };
};

export const uploadFile = async (
	settings: PluginSettings,
	filename: string,
	contentType: string,
	binary: ArrayBuffer
): Promise<ServiceResult<{ id: string }>> => {
	try {
		const createResponse = await notionRequest({
			url: "https://api.notion.com/v1/file_uploads",
			method: "POST",
			headers: jsonHeaders(settings),
			body: JSON.stringify({
				mode: "single_part",
				filename,
				content_type: contentType,
			}),
		});
		const created = createResponse.json as { id?: string; upload_url?: string };
		if (!created.id) throw Error("Notion did not return a file upload ID");
		const { body, boundary } = buildMultipartBody(
			filename,
			contentType,
			binary
		);
		await notionRequest({
			url:
				created.upload_url ||
				`https://api.notion.com/v1/file_uploads/${created.id}/send`,
			method: "POST",
			headers: {
				...authHeaders(settings),
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			},
			body,
		});
		return { data: { id: created.id }, error: null };
	} catch (error) {
		return {
			data: { id: "" },
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

const retrieveChildren = async (
	settings: PluginSettings,
	parentId: string
): Promise<NotionBlock[]> => {
	const blocks: NotionBlock[] = [];
	let cursor: string | null = null;
	do {
		const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
		const response = await notionRequest({
			url: `https://api.notion.com/v1/blocks/${parentId}/children${query}`,
			method: "GET",
			headers: authHeaders(settings),
		});
		const json = response.json as BlockChildrenResponse;
		for (const block of json.results || []) {
			if (block.has_children && block.id) {
				const children = await retrieveChildren(settings, block.id);
				const typed = block[block.type] as Record<string, unknown> | undefined;
				block[block.type] = { ...(typed || {}), children };
			}
			blocks.push(block);
		}
		cursor = json.has_more ? json.next_cursor || null : null;
	} while (cursor);
	return blocks;
};

const appendOne = async (
	settings: PluginSettings,
	parentId: string,
	block: NotionBlock,
	afterBlockId?: string
): Promise<NotionBlock> => {
	const body: Record<string, unknown> = {
		children: [sanitizeBlockForCreate(block)],
		position: afterBlockId
			? { type: "after_block", after_block: { id: afterBlockId } }
			: { type: "start" },
	};
	const response = await notionRequest({
		url: `https://api.notion.com/v1/blocks/${parentId}/children`,
		method: "PATCH",
		headers: jsonHeaders(settings),
		body: JSON.stringify(body),
	});
	const result = (response.json as BlockChildrenResponse).results?.[0];
	if (!result?.id) throw Error("Notion did not return the inserted block ID");
	const children = getChildren(block);
	let childAnchor: string | undefined;
	for (const child of children) {
		const inserted = await appendOne(
			settings,
			result.id,
			child,
			childAnchor
		);
		childAnchor = inserted.id;
	}
	return result;
};

const deleteBlock = async (settings: PluginSettings, blockId: string) => {
	await notionRequest({
		url: `https://api.notion.com/v1/blocks/${blockId}`,
		method: "DELETE",
		headers: authHeaders(settings),
	});
};

const REPLACE_ONLY_TYPES = new Set([
	"table",
	"table_row",
	"column",
	"column_list",
	"synced_block",
]);

const canUpdateInPlace = (oldBlock: NotionBlock, newBlock: NotionBlock) =>
	oldBlock.type === newBlock.type && !REPLACE_ONLY_TYPES.has(oldBlock.type);

const updateBlock = async (
	settings: PluginSettings,
	blockId: string,
	block: NotionBlock
) => {
	await notionRequest({
		url: `https://api.notion.com/v1/blocks/${blockId}`,
		method: "PATCH",
		headers: jsonHeaders(settings),
		body: JSON.stringify({ [block.type]: sanitizeTypedValue(block) }),
	});
};

const reconcileChildren = async (
	settings: PluginSettings,
	parentId: string,
	oldBlocks: NotionBlock[],
	newBlocks: NotionBlock[],
	report: ReconcileReport
): Promise<void> => {
	let prefix = 0;
	while (
		prefix < oldBlocks.length &&
		prefix < newBlocks.length &&
		signature(oldBlocks[prefix]) === signature(newBlocks[prefix])
	) {
		report.unchanged += 1;
		prefix += 1;
	}

	let suffix = 0;
	while (
		suffix < oldBlocks.length - prefix &&
		suffix < newBlocks.length - prefix &&
		signature(oldBlocks[oldBlocks.length - 1 - suffix]) ===
			signature(newBlocks[newBlocks.length - 1 - suffix])
	) {
		report.unchanged += 1;
		suffix += 1;
	}

	const oldMiddle = oldBlocks.slice(prefix, oldBlocks.length - suffix);
	const newMiddle = newBlocks.slice(prefix, newBlocks.length - suffix);
	let anchor = prefix > 0 ? oldBlocks[prefix - 1].id : undefined;
	const paired = Math.min(oldMiddle.length, newMiddle.length);

	for (let index = 0; index < paired; index += 1) {
		const oldBlock = oldMiddle[index];
		const newBlock = newMiddle[index];
		if (oldBlock.id && canUpdateInPlace(oldBlock, newBlock)) {
			await updateBlock(settings, oldBlock.id, newBlock);
			report.updated += 1;
			await reconcileChildren(
				settings,
				oldBlock.id,
				getChildren(oldBlock),
				getChildren(newBlock),
				report
			);
			anchor = oldBlock.id;
			continue;
		}

		const inserted = await appendOne(settings, parentId, newBlock, anchor);
		report.inserted += 1;
		anchor = inserted.id;
		if (oldBlock.id) {
			await deleteBlock(settings, oldBlock.id);
			report.deleted += 1;
		}
	}

	for (const block of newMiddle.slice(paired)) {
		const inserted = await appendOne(settings, parentId, block, anchor);
		report.inserted += 1;
		anchor = inserted.id;
	}

	for (const block of oldMiddle.slice(paired)) {
		if (!block.id) continue;
		await deleteBlock(settings, block.id);
		report.deleted += 1;
	}
};

const replaceAll = async (
	settings: PluginSettings,
	pageId: string,
	blocks: NotionBlock[]
) => {
	const current = await retrieveChildren(settings, pageId);
	for (const block of current) {
		if (block.id) await deleteBlock(settings, block.id);
	}
	let anchor: string | undefined;
	for (const block of blocks) {
		const inserted = await appendOne(settings, pageId, block, anchor);
		anchor = inserted.id;
	}
};

export const reconcilePage = async (
	settings: PluginSettings,
	pageId: string,
	newBlocks: NotionBlock[]
): Promise<ServiceResult<ReconcileReport>> => {
	const report: ReconcileReport = {
		unchanged: 0,
		updated: 0,
		inserted: 0,
		deleted: 0,
		rollbackAttempted: false,
		rollbackSucceeded: false,
	};
	let snapshot: NotionBlock[] = [];
	try {
		snapshot = await retrieveChildren(settings, pageId);
		await reconcileChildren(settings, pageId, snapshot, newBlocks, report);
		return { data: report, error: null };
	} catch (error) {
		report.rollbackAttempted = true;
		try {
			await replaceAll(settings, pageId, snapshot);
			report.rollbackSucceeded = true;
		} catch {
			report.rollbackSucceeded = false;
		}
		return {
			data: report,
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

export const retrievePage = async (
	settings: PluginSettings,
	pageId: string
): Promise<ServiceResult<Record<string, unknown>>> => {
	try {
		const response = await notionRequest({
			url: `https://api.notion.com/v1/pages/${pageId}`,
			method: "GET",
			headers: authHeaders(settings),
		});
		return { data: response.json as Record<string, unknown>, error: null };
	} catch (error) {
		return {
			data: {},
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

export const resolveDataSourceId = async (
	settings: PluginSettings
): Promise<ServiceResult<string>> => {
	if (settings.dataSourceID) return { data: settings.dataSourceID, error: null };
	try {
		const response = await notionRequest({
			url: `https://api.notion.com/v1/databases/${settings.databaseID}`,
			method: "GET",
			headers: authHeaders(settings),
		});
		const database = response.json as {
			data_sources?: Array<{ id?: string }>;
		};
		const id = database.data_sources?.[0]?.id;
		if (!id) throw Error("The Notion database has no discoverable data source");
		return { data: id, error: null };
	} catch (error) {
		return {
			data: "",
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

export const createPage = async (
	settings: PluginSettings,
	title: string,
	tags: string[]
): Promise<ServiceResult<{ id: string; url: string }>> => {
	const sourceResult = await resolveDataSourceId(settings);
	if (sourceResult.error) {
		return { data: { id: "", url: "" }, error: sourceResult.error };
	}
	try {
		const properties: Record<string, unknown> = {
			[settings.titleProperty]: {
				type: "title",
				title: [{ type: "text", text: { content: title } }],
			},
		};
		if (settings.allowTags) {
			properties[settings.tagsProperty] = {
				type: "multi_select",
				multi_select: tags.map((name) => ({ name })),
			};
		}
		const response = await notionRequest({
			url: "https://api.notion.com/v1/pages",
			method: "POST",
			headers: jsonHeaders(settings),
			body: JSON.stringify({
				parent: {
					type: "data_source_id",
					data_source_id: sourceResult.data,
				},
				properties,
			}),
		});
		const page = response.json as { id?: string; url?: string };
		if (!page.id || !page.url) throw Error("Notion did not return page identity");
		return { data: { id: page.id, url: page.url }, error: null };
	} catch (error) {
		return {
			data: { id: "", url: "" },
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};
