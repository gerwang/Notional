jest.mock("obsidian");
jest.mock("main");

import { App, PluginManifest, TFile, requestUrl } from "obsidian";
import NObsidian from "main";
import { preflightPublication } from "../service/publisher";

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
