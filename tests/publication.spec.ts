jest.mock("obsidian");

import { App, TFile, TFolder } from "obsidian";
import {
	applyPublicationIdentity,
	getPublicationIdentity,
	isExcludedPublicationPath,
	prepareLocalAttachments,
	resolveAttachment,
} from "../service/publication";
import { MarkdownWithFrontMatter } from "../service/types";

const makeFile = (path: string, size = 100): TFile => {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() || path;
	file.basename = file.name.replace(/\.[^.]+$/, "");
	file.extension = file.name.split(".").pop() || "";
	file.stat.size = size;
	return file;
};

describe("publication identity", () => {
	it("uses and preserves the vault's established page identity fields", () => {
		const frontmatter = {
			__content: "body",
			"NotionID-obsidian-vault": "stable-page-id",
			"link-obsidian-vault": "https://notion.so/stable-page-id",
		} as MarkdownWithFrontMatter;

		expect(getPublicationIdentity(frontmatter)).toEqual({
			pageId: "stable-page-id",
			pageUrl: "https://notion.so/stable-page-id",
		});
		expect(
			applyPublicationIdentity(frontmatter, {
				pageId: "stable-page-id",
				pageUrl: "https://notion.so/stable-page-id",
			})
		).toMatchObject(frontmatter);
	});

	it("refuses to rotate an existing page ID", () => {
		const frontmatter = {
			__content: "body",
			"NotionID-obsidian-vault": "advisor-page-id",
		} as MarkdownWithFrontMatter;
		expect(() =>
			applyPublicationIdentity(frontmatter, {
				pageId: "different-id",
				pageUrl: "https://notion.so/different-id",
			})
		).toThrow("Refusing to replace Notion page identity");
	});
});

describe("publication path policy", () => {
	it("excludes templates but not similarly named folders", () => {
		expect(isExcludedPublicationPath("01 Templates/Paper.md")).toBe(true);
		expect(isExcludedPublicationPath("01 Templates.md")).toBe(false);
		expect(isExcludedPublicationPath("20 Papers/Paper.md")).toBe(false);
	});
});

describe("note-local attachment preparation", () => {
	let app: App;
	let source: TFile;
	let parent: TFolder;

	beforeEach(() => {
		app = new App();
		parent = new TFolder();
		parent.path = "50 Projects/Test";
		source = makeFile("50 Projects/Test/Experiment.md");
		source.parent = parent;
	});

	it("resolves beside the note before vault-root and basename fallbacks", () => {
		const local = makeFile("50 Projects/Test/Experiment/figure.png");
		const rooted = makeFile("Experiment/figure.png");
		(app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
			(path: string) => {
				if (path === local.path) return local;
				if (path === rooted.path) return rooted;
				return null;
			}
		);

		expect(resolveAttachment(app, source, "Experiment/figure.png")).toBe(
			local
		);
		expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith(local.path);
	});

	it("rejects ambiguous basename compatibility matches", () => {
		(app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
		(app.vault.getFiles as jest.Mock).mockReturnValue([
			makeFile("A/figure.png"),
			makeFile("B/figure.png"),
		]);
		expect(() => resolveAttachment(app, source, "figure.png")).toThrow(
			"Ambiguous attachment"
		);
	});

	it("turns adjacent page-bundle embeds into ordered block markers", () => {
		const first = makeFile("50 Projects/Test/Experiment/one.png");
		const second = makeFile("50 Projects/Test/Experiment/two.png");
		(app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
			(path: string) =>
				[first, second].find((file) => file.path === path) || null
		);

		const prepared = prepareLocalAttachments(
			app,
			source,
			"![[Experiment/one.png]]![[Experiment/two.png]]"
		);

		expect(prepared.attachments.map((item) => item.file)).toEqual([
			first,
			second,
		]);
		expect(prepared.markdown).toContain("NOTIONAL_ASSET_0001");
		expect(prepared.markdown).toContain("NOTIONAL_ASSET_0002");
	});

	it("does not interpret embed examples inside inline or fenced code", () => {
		const prepared = prepareLocalAttachments(
			app,
			source,
			"`![[Experiment/example.png]]`\n\n```md\n![[Experiment/example.png]]\n```"
		);
		expect(prepared.attachments).toHaveLength(0);
		expect(prepared.markdown).toContain("![[Experiment/example.png]]");
	});
});
