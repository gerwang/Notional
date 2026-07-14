export class TFile {
	basename: string;
	name: string;
	path: string;
	extension: string;
	parent: TFolder | null = null;
	stat = {
		mtime: 0,
		size: 0,
	};
}

export class TFolder {
	path = "";
	children: Array<TFile | TFolder> = [];
	isRoot = jest.fn().mockReturnValue(false);
}

export class App {
	vault = {
		getAbstractFileByPath: jest.fn(),
		getFiles: jest.fn().mockReturnValue([]),
		readBinary: jest.fn(),
	};
	metadataCache = {
		resolvedLinks: {} as Record<string, Record<string, number>>,
		getFileCache: jest.fn(),
	};
}
export class PluginManifest {}

export const requestUrl = jest.fn();
export const normalizePath = (path: string) =>
	path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");

export default {
	requestUrl,
};
