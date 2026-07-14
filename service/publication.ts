import { App, TAbstractFile, TFile, normalizePath } from "obsidian";
import { MarkdownWithFrontMatter } from "./types";

export const DEFAULT_DATABASE_ALIAS = "obsidian-vault";
export const DEFAULT_EXCLUDED_FOLDERS = ["01 Templates"];

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"heic",
	"tif",
	"tiff",
	"ico",
]);

const FILE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "pdf"]);

export type PublicationIdentity = {
	pageId?: string;
	pageUrl?: string;
};

export type PublicationWarning = {
	code:
		| "unpublished-link"
		| "unreviewed-note"
		| "unsupported-embed"
		| "legacy-identity";
	message: string;
};

export type ResolvedAttachment = {
	marker: string;
	original: string;
	file: TFile;
	caption: string;
	kind: "image" | "file";
};

export type PreparedPublication = {
	markdown: string;
	attachments: ResolvedAttachment[];
	warnings: PublicationWarning[];
};

export const identityKeys = (databaseAlias = DEFAULT_DATABASE_ALIAS) => ({
	pageId: `NotionID-${databaseAlias}`,
	pageUrl: `link-${databaseAlias}`,
});

export const getPublicationIdentity = (
	frontmatter: MarkdownWithFrontMatter,
	databaseAlias = DEFAULT_DATABASE_ALIAS
): PublicationIdentity => {
	const keys = identityKeys(databaseAlias);
	return {
		pageId: stringValue(frontmatter[keys.pageId]) || frontmatter.notionPageId,
		pageUrl:
			stringValue(frontmatter[keys.pageUrl]) || frontmatter.notionPageUrl,
	};
};

/**
 * Store publication identity in the vault's established fields. Existing values
 * are immutable: a mismatch is an error rather than a silent page rotation.
 */
export const applyPublicationIdentity = (
	frontmatter: MarkdownWithFrontMatter,
	identity: Required<PublicationIdentity>,
	databaseAlias = DEFAULT_DATABASE_ALIAS
): MarkdownWithFrontMatter => {
	const keys = identityKeys(databaseAlias);
	const current = getPublicationIdentity(frontmatter, databaseAlias);
	if (current.pageId && current.pageId !== identity.pageId) {
		throw Error(
			`Refusing to replace Notion page identity ${current.pageId} with ${identity.pageId}`
		);
	}
	if (current.pageUrl && current.pageUrl !== identity.pageUrl) {
		throw Error("Refusing to replace the existing Notion publication URL");
	}

	return {
		...frontmatter,
		[keys.pageId]: current.pageId || identity.pageId,
		[keys.pageUrl]: current.pageUrl || identity.pageUrl,
	};
};

export const isExcludedPublicationPath = (
	path: string,
	excludedFolders = DEFAULT_EXCLUDED_FOLDERS
): boolean => {
	const normalized = normalizePath(path);
	return excludedFolders.some((folder) => {
		const prefix = normalizePath(folder).replace(/\/$/, "");
		return normalized === prefix || normalized.startsWith(`${prefix}/`);
	});
};

export const getMimeType = (file: TFile): string => {
	const extension = file.extension.toLowerCase();
	const types: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
		heic: "image/heic",
		tif: "image/tiff",
		tiff: "image/tiff",
		ico: "image/vnd.microsoft.icon",
		pdf: "application/pdf",
	};
	return types[extension] || "application/octet-stream";
};

const stringValue = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
};

const decodePath = (value: string): string => {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
};

const parseWikiEmbed = (inner: string) => {
	const [targetWithHeading, alias = ""] = inner.split("|", 2);
	const target = decodePath(targetWithHeading.split("#", 1)[0].trim());
	return { target, caption: alias.trim() };
};

const parseMarkdownDestination = (destination: string) => {
	const trimmed = destination.trim();
	if (trimmed.startsWith("<")) {
		const end = trimmed.indexOf(">");
		if (end > 0) return decodePath(trimmed.slice(1, end));
	}
	return decodePath(trimmed.match(/^(\S+)/)?.[1] || trimmed);
};

const isExternalDestination = (path: string): boolean =>
	/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//");

const asTFile = (file: TAbstractFile | null): TFile | null =>
	file instanceof TFile ? file : null;

/** Resolve note-local assets according to the vault contract. */
export const resolveAttachment = (
	app: App,
	sourceFile: TFile,
	rawPath: string
): TFile => {
	const path = normalizePath(rawPath.replace(/^\.\//, ""));
	const parentPath = sourceFile.parent?.path || "";
	const relativePath = normalizePath(
		parentPath && parentPath !== "/" ? `${parentPath}/${path}` : path
	);

	const relative = asTFile(app.vault.getAbstractFileByPath(relativePath));
	if (relative) return relative;

	const rooted = asTFile(app.vault.getAbstractFileByPath(path));
	if (rooted) return rooted;

	const basename = path.split("/").pop();
	const matches = basename
		? app.vault.getFiles().filter((file) => file.name === basename)
		: [];
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw Error(
			`Ambiguous attachment “${rawPath}”; use a path-qualified embed`
		);
	}
	throw Error(`Attachment not found: ${rawPath}`);
};

const protectCode = (markdown: string) => {
	const protectedSegments: string[] = [];
	const content = markdown.replace(
		/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g,
		(segment) => {
			const token = `\u0000NOTIONAL_CODE_${protectedSegments.length}\u0000`;
			protectedSegments.push(segment);
			return token;
		}
	);
	return {
		content,
		restore: (value: string) =>
			protectedSegments.reduce(
				(result, segment, index) =>
					result.replace(`\u0000NOTIONAL_CODE_${index}\u0000`, segment),
				value
			),
	};
};

/**
 * Replace local embeds with stable paragraph markers. The Notion layer swaps
 * those marker blocks for uploaded file blocks before any page is mutated.
 */
export const prepareLocalAttachments = (
	app: App,
	sourceFile: TFile,
	markdown: string
): PreparedPublication => {
	const protectedCode = protectCode(markdown);
	const attachments: ResolvedAttachment[] = [];
	const warnings: PublicationWarning[] = [];
	let content = protectedCode.content;

	const addAttachment = (
		original: string,
		target: string,
		caption: string
	): string => {
		if (!target || isExternalDestination(target)) return original;
		const extension = target.split(".").pop()?.toLowerCase() || "";
		if (!FILE_EXTENSIONS.has(extension)) return original;
		const file = resolveAttachment(app, sourceFile, target);
		const marker = `NOTIONAL_ASSET_${String(attachments.length + 1).padStart(4, "0")}`;
		attachments.push({
			marker,
			original,
			file,
			caption,
			kind: IMAGE_EXTENSIONS.has(file.extension.toLowerCase())
				? "image"
				: "file",
		});
		return `\n\n${marker}\n\n`;
	};

	content = content.replace(
		/!\[\[([^\]]+)\]\]/g,
		(original: string, inner: string) => {
		const parsed = parseWikiEmbed(inner);
		return addAttachment(original, parsed.target, parsed.caption);
		}
	);

	content = content.replace(
		/!\[([^\]]*)\]\(([^)]+)\)/g,
		(original: string, caption: string, destination: string) =>
			addAttachment(
				original,
				parseMarkdownDestination(destination),
				caption.trim()
			)
	);

	return {
		markdown: protectedCode.restore(content).replace(/\n{3,}/g, "\n\n"),
		attachments,
		warnings,
	};
};

export const publicationWarnings = (
	frontmatter: MarkdownWithFrontMatter
): PublicationWarning[] => {
	const warnings: PublicationWarning[] = [];
	if (frontmatter.review_status !== "reviewed") {
		warnings.push({
			code: "unreviewed-note",
			message: `review_status is ${frontmatter.review_status || "missing"}`,
		});
	}
	return warnings;
};
