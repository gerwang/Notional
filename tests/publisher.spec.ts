jest.mock("obsidian");
jest.mock("main");

import { App, PluginManifest, TFile, requestUrl } from "obsidian";
import NObsidian from "main";
import {
	collectPublishedInboundLinks,
	preflightPublication,
	republishPublishedFiles,
} from "../service/publisher";

describe("publication preflight", () => {
	it("does not call Notion or mutate Markdown", async () => {
		const plugin = new NObsidian(new App(), {} as PluginManifest);
		const file = new TFile();
		file.path = "20 Papers/Test.md";
		file.name = "Test.md";
		file.basename = "Test";
		file.extension = "md";

		const result = await preflightPublication(plugin, file);

		expect(result.error).toBeNull();
		expect(requestUrl).not.toHaveBeenCalled();
		expect(plugin.updateMarkdownFile).not.toHaveBeenCalled();
	});

	it("blocks excluded template paths", async () => {
		const plugin = new NObsidian(new App(), {} as PluginManifest);
		const file = new TFile();
		file.path = "01 Templates/Paper Note Template.md";
		file.name = "Paper Note Template.md";
		file.basename = "Paper Note Template";
		file.extension = "md";

		const result = await preflightPublication(plugin, file);

		expect(result.error?.message).toContain("Publication is disabled");
		expect(requestUrl).not.toHaveBeenCalled();
	});
});

describe("published inbound-link repair collection", () => {
	const makeFile = (path: string) => {
		const file = new TFile();
		file.path = path;
		file.name = path.split("/").pop() || path;
		file.basename = file.name.replace(/\.md$/, "");
		file.extension = "md";
		return file;
	};

	it("selects only published notes with ordinary wiki-links to the target", async () => {
		const app = new App();
		const plugin = new NObsidian(app, {} as PluginManifest);
		const target = makeFile("40 Concepts/Target.md");
		const published = makeFile("30 Topics/Published.md");
		const unpublished = makeFile("30 Topics/Unpublished.md");
		const transclusion = makeFile("30 Topics/Transclusion.md");
		app.metadataCache.resolvedLinks = {
			[published.path]: { [target.path]: 1 },
			[unpublished.path]: { [target.path]: 1 },
			[transclusion.path]: { [target.path]: 1 },
		};
		(app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
			(path: string) =>
				[published, unpublished, transclusion].find(
					(file) => file.path === path
				) || null
		);
		(app.metadataCache.getFileCache as jest.Mock).mockImplementation(
			(file: TFile) => ({
				links:
					file === transclusion
						? []
						: [{ original: "[[Target]]", link: "Target" }],
			})
		);
		(plugin.getLinkedMarkdownFile as jest.Mock).mockReturnValue(target);
		(plugin.getContent as jest.Mock).mockImplementation(async (file: TFile) => ({
			__content: "",
			...(file !== unpublished && {
				"NotionID-obsidian-vault": `${file.basename}-page-id`,
			}),
		}));

		const result = await collectPublishedInboundLinks(plugin, target);

		expect(result.error).toBeNull();
		expect(result.data).toEqual([published]);
	});

	it("requires the target to have a publication identity", async () => {
		const plugin = new NObsidian(new App(), {} as PluginManifest);
		const target = makeFile("40 Concepts/Target.md");
		(plugin.getContent as jest.Mock).mockResolvedValue({ __content: "" });

		const result = await collectPublishedInboundLinks(plugin, target);

		expect(result.error?.message).toContain("Publish 40 Concepts/Target.md");
	});

	it("refuses the entire repair selection before writing if a source lost its identity", async () => {
		const plugin = new NObsidian(new App(), {} as PluginManifest);
		const published = makeFile("30 Topics/Published.md");
		const unpublished = makeFile("30 Topics/Unpublished.md");
		(plugin.getContent as jest.Mock).mockImplementation(async (file: TFile) => ({
			__content: "Body",
			...(file === published && { notionPageId: "published-page-id" }),
		}));

		const result = await republishPublishedFiles(plugin, [
			published,
			unpublished,
		]);

		expect(result.error?.message).toContain("is not published");
		expect(requestUrl).not.toHaveBeenCalled();
	});
});
