import { TFile } from "obsidian";
import NObsidian from "main";
import { fromYamlFrontMatterToMarkdown } from "./utils";
import {
	PreparedPublication,
	PublicationWarning,
	applyPublicationIdentity,
	getMimeType,
	getPublicationIdentity,
	isExcludedPublicationPath,
	prepareLocalAttachments,
	publicationWarnings,
} from "./publication";
import {
	ReconcileReport,
	UploadedAttachment,
	compilePublicationBlocks,
	createPage,
	reconcilePage,
	retrievePage,
	uploadFile as uploadNotionFile,
} from "./publisher-notion";
import { MarkdownWithFrontMatter, ServiceResult } from "./types";

export type PublicationPreflight = PreparedPublication & {
	frontmatter: MarkdownWithFrontMatter;
	pageId?: string;
	pageUrl?: string;
	linkedFiles: TFile[];
};

export type PublicationResult = {
	filePath: string;
	pageId: string;
	pageUrl?: string;
	warnings: PublicationWarning[];
	attachmentsUploaded: number;
	reconcile: ReconcileReport;
};

/**
 * Find already-published notes whose ordinary wiki-links resolve to `target`.
 * Embeds are intentionally excluded: note transclusion is not a page-link repair.
 */
export const collectPublishedInboundLinks = async (
	plugin: NObsidian,
	target: TFile
): Promise<ServiceResult<TFile[]>> => {
	try {
		const targetFrontmatter = await plugin.getContent(target);
		const targetIdentity = getPublicationIdentity(
			targetFrontmatter,
			plugin.settings.databaseAlias
		);
		if (!targetIdentity.pageId) {
			throw Error(`Publish ${target.path} before repairing links to it`);
		}

		const inbound: TFile[] = [];
		for (const [sourcePath, destinations] of Object.entries(
			plugin.app.metadataCache.resolvedLinks
		)) {
			if (sourcePath === target.path || !destinations[target.path]) continue;
			if (
				isExcludedPublicationPath(
					sourcePath,
					plugin.settings.excludedFolders
				)
			) {
				continue;
			}

			const source = plugin.app.vault.getAbstractFileByPath(sourcePath);
			if (!(source instanceof TFile) || source.extension !== "md") continue;
			const cache = plugin.app.metadataCache.getFileCache(source);
			const hasOrdinaryWikiLink = cache?.links?.some((link) => {
				if (!link.original.trimStart().startsWith("[[")) return false;
				const linkPath = link.link.split("#", 1)[0].trim();
				return (
					plugin.getLinkedMarkdownFile(linkPath, source.path)?.path ===
					target.path
				);
			});
			if (!hasOrdinaryWikiLink) continue;

			const frontmatter = await plugin.getContent(source);
			const identity = getPublicationIdentity(
				frontmatter,
				plugin.settings.databaseAlias
			);
			if (identity.pageId) inbound.push(source);
		}

		inbound.sort((left, right) => left.path.localeCompare(right.path));
		return { data: inbound, error: null };
	} catch (error) {
		return {
			data: [],
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

const protectCode = (markdown: string) => {
	const segments: string[] = [];
	const content = markdown.replace(
		/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g,
		(segment) => {
			const marker = `\u0000NOTIONAL_LINK_CODE_${segments.length}\u0000`;
			segments.push(segment);
			return marker;
		}
	);
	return {
		content,
		restore: (value: string) =>
			segments.reduce(
				(result, segment, index) =>
					result.replace(`\u0000NOTIONAL_LINK_CODE_${index}\u0000`, segment),
				value
			),
	};
};

const convertWikiLinks = async (
	plugin: NObsidian,
	sourceFile: TFile,
	markdown: string
): Promise<{
	markdown: string;
	linkedFiles: TFile[];
	warnings: PublicationWarning[];
}> => {
	const protectedCode = protectCode(markdown);
	const linkedFiles = new Map<string, TFile>();
	const warnings: PublicationWarning[] = [];
	const replacements = new Map<
		string,
		{ replacement: string; file?: TFile; warning?: PublicationWarning }
	>();
	const regex = /(?<!!)\[\[([^\]]+)\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(protectedCode.content)) !== null) {
		const inner = match[1];
		if (replacements.has(inner)) continue;
		const [targetWithHeading, alias] = inner.split("|", 2);
		const [target] = targetWithHeading.split("#", 2);
		const display = (alias || target.split("/").pop() || target).trim();
		const file = plugin.getLinkedMarkdownFile(target.trim(), sourceFile.path);
		if (!file) {
			replacements.set(inner, {
				replacement: display,
				warning: {
					code: "unpublished-link",
					message: `Unresolved wiki-link: [[${inner}]]`,
				},
			});
			continue;
		}
		linkedFiles.set(file.path, file);
		const targetFrontmatter = await plugin.getContent(file);
		const identity = getPublicationIdentity(
			targetFrontmatter,
			plugin.settings.databaseAlias
		);
		if (!identity.pageId) {
			replacements.set(inner, {
				replacement: display,
				file,
				warning: {
					code: "unpublished-link",
					message: `Linked note is not published yet: ${file.path}`,
				},
			});
			continue;
		}
		replacements.set(inner, {
			replacement: `[${display}](notional://notion-page/${encodeURIComponent(
				identity.pageId
			)})`,
			file,
		});
	}

	let converted = protectedCode.content.replace(
		regex,
		(_full: string, inner: string) => {
		const replacement = replacements.get(inner);
		if (replacement?.warning) warnings.push(replacement.warning);
		return replacement?.replacement || inner;
		}
	);
	converted = protectedCode.restore(converted);

	return {
		markdown: converted,
		linkedFiles: [...linkedFiles.values()],
		warnings,
	};
};

export const preflightPublication = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult<PublicationPreflight>> => {
	try {
		if (
			isExcludedPublicationPath(file.path, plugin.settings.excludedFolders)
		) {
			throw Error(`Publication is disabled for ${file.path}`);
		}
		const frontmatter = await plugin.getContent(file);
		const prepared = prepareLocalAttachments(
			plugin.app,
			file,
			frontmatter.__content
		);
		for (const attachment of prepared.attachments) {
			if (attachment.file.stat.size > plugin.settings.maxUploadBytes) {
				throw Error(
					`${attachment.file.path} is ${(attachment.file.stat.size / 1024 / 1024).toFixed(
						2
					)} MiB; the configured upload limit is ${(
						plugin.settings.maxUploadBytes /
						1024 /
						1024
					).toFixed(2)} MiB`
				);
			}
		}
		const links = await convertWikiLinks(plugin, file, prepared.markdown);
		const identity = getPublicationIdentity(
			frontmatter,
			plugin.settings.databaseAlias
		);
		return {
			data: {
				...prepared,
				markdown: links.markdown,
				frontmatter,
				pageId: identity.pageId,
				pageUrl: identity.pageUrl,
				linkedFiles: links.linkedFiles,
				warnings: [
					...publicationWarnings(frontmatter),
					...prepared.warnings,
					...links.warnings,
				],
			},
			error: null,
		};
	} catch (error) {
		return {
			data: {} as PublicationPreflight,
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

const uploadAttachments = async (
	plugin: NObsidian,
	preflight: PublicationPreflight
): Promise<UploadedAttachment[]> => {
	const uploadedByPath = new Map<string, string>();
	const uploaded: UploadedAttachment[] = [];
	for (const attachment of preflight.attachments) {
		let fileUploadId = uploadedByPath.get(attachment.file.path);
		if (!fileUploadId) {
			const binary = await plugin.app.vault.readBinary(attachment.file);
			const result = await uploadNotionFile(
				plugin.settings,
				attachment.file.name,
				getMimeType(attachment.file),
				binary
			);
			if (result.error) throw result.error;
			fileUploadId = result.data.id;
			uploadedByPath.set(attachment.file.path, fileUploadId);
		}
		uploaded.push({ ...attachment, fileUploadId });
	}
	return uploaded;
};

const ensurePageIdentity = async (
	plugin: NObsidian,
	file: TFile,
	preflight: PublicationPreflight
): Promise<{ pageId: string; pageUrl?: string }> => {
	if (preflight.pageId) {
		const page = await retrievePage(plugin.settings, preflight.pageId);
		if (page.error) throw page.error;
		return {
			pageId: preflight.pageId,
			pageUrl:
				preflight.pageUrl ||
				(typeof page.data.url === "string" ? page.data.url : undefined),
		};
	}

	const tags = Array.isArray(preflight.frontmatter.tags)
		? preflight.frontmatter.tags.map(String)
		: [];
	const created = await createPage(plugin.settings, file.basename, tags);
	if (created.error) throw created.error;
	const withIdentity = applyPublicationIdentity(
		preflight.frontmatter,
		{ pageId: created.data.id, pageUrl: created.data.url },
		plugin.settings.databaseAlias
	);
	await plugin.updateMarkdownFile(
		file,
		fromYamlFrontMatterToMarkdown(withIdentity)
	);
	return { pageId: created.data.id, pageUrl: created.data.url };
};

export const publishFile = async (
	plugin: NObsidian,
	file: TFile,
	providedPreflight?: PublicationPreflight
): Promise<ServiceResult<PublicationResult>> => {
	try {
		const preflightResult = providedPreflight
			? { data: providedPreflight, error: null }
			: await preflightPublication(plugin, file);
		if (preflightResult.error) throw preflightResult.error;
		const preflight = preflightResult.data;
		const uploaded = await uploadAttachments(plugin, preflight);
		const blocks = compilePublicationBlocks(preflight.markdown, uploaded);
		const identity = await ensurePageIdentity(plugin, file, preflight);
		const reconciled = await reconcilePage(
			plugin.settings,
			identity.pageId,
			blocks
		);
		if (reconciled.error) throw reconciled.error;
		return {
			data: {
				filePath: file.path,
				pageId: identity.pageId,
				pageUrl: identity.pageUrl,
				warnings: preflight.warnings,
				attachmentsUploaded: new Set(
					uploaded.map((attachment) => attachment.file.path)
				).size,
				reconcile: reconciled.data,
			},
			error: null,
		};
	} catch (error) {
		return {
			data: {} as PublicationResult,
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

/**
 * Republish only pages that already have stable publication identities.
 * Unlike `publishFiles`, this path can never create a new Notion page.
 */
export const republishPublishedFiles = async (
	plugin: NObsidian,
	files: TFile[]
): Promise<ServiceResult<PublicationResult[]>> => {
	try {
		const preflights = new Map<string, PublicationPreflight>();
		for (const file of files) {
			const preflight = await preflightPublication(plugin, file);
			if (preflight.error) throw preflight.error;
			if (!preflight.data.pageId) {
				throw Error(
					`Refusing link repair because ${file.path} is not published`
				);
			}
			preflights.set(file.path, preflight.data);
		}

		const results: PublicationResult[] = [];
		for (const file of files) {
			const result = await publishFile(plugin, file, preflights.get(file.path));
			if (result.error) throw result.error;
			results.push(result.data);
		}
		return { data: results, error: null };
	} catch (error) {
		return {
			data: [],
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

export const collectLinkedPublicationClosure = async (
	plugin: NObsidian,
	root: TFile
): Promise<ServiceResult<TFile[]>> => {
	const ordered: TFile[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const walk = async (file: TFile): Promise<void> => {
		if (visited.has(file.path) || visiting.has(file.path)) return;
		if (isExcludedPublicationPath(file.path, plugin.settings.excludedFolders)) {
			return;
		}
		visiting.add(file.path);
		const preflight = await preflightPublication(plugin, file);
		if (preflight.error) throw preflight.error;
		for (const linked of preflight.data.linkedFiles) await walk(linked);
		visiting.delete(file.path);
		visited.add(file.path);
		ordered.push(file);
	};

	try {
		await walk(root);
		return { data: ordered, error: null };
	} catch (error) {
		return {
			data: [],
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

/**
 * Preflight the full graph, establish missing page identities, then publish in
 * dependency order so all resolvable wiki-links become Notion page mentions.
 */
export const publishLinkedClosure = async (
	plugin: NObsidian,
	root: TFile
): Promise<ServiceResult<PublicationResult[]>> => {
	try {
		const closure = await collectLinkedPublicationClosure(plugin, root);
		if (closure.error) throw closure.error;
		return publishFiles(plugin, closure.data);
	} catch (error) {
		return {
			data: [],
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};

/** Preflight a selection, create all missing identities, then publish it. */
export const publishFiles = async (
	plugin: NObsidian,
	files: TFile[]
): Promise<ServiceResult<PublicationResult[]>> => {
	try {
		const selected = files.filter(
			(file) =>
				!isExcludedPublicationPath(
					file.path,
					plugin.settings.excludedFolders
				)
		);
		const initial = new Map<string, PublicationPreflight>();
		for (const file of selected) {
			const preflight = await preflightPublication(plugin, file);
			if (preflight.error) throw preflight.error;
			initial.set(file.path, preflight.data);
		}

		for (const file of selected) {
			const preflight = initial.get(file.path);
			if (preflight) await ensurePageIdentity(plugin, file, preflight);
		}

		const results: PublicationResult[] = [];
		for (const file of selected) {
			const refreshed = await preflightPublication(plugin, file);
			if (refreshed.error) throw refreshed.error;
			const result = await publishFile(plugin, file, refreshed.data);
			if (result.error) throw result.error;
			results.push(result.data);
		}
		return { data: results, error: null };
	} catch (error) {
		return {
			data: [],
			error: error instanceof Error ? error : Error(String(error)),
		};
	}
};
