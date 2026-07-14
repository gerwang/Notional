import { TFile } from "obsidian";
import NObsidian from "main";
import { publishFile as publishVaultFile } from "./publisher";
import { ServiceResult } from "./types";

export const uploadFile = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult> => publishVaultFile(plugin, file);

export const runWithConcurrency = async <T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw Error("Concurrency must be a positive integer");
	}

	const results: R[] = [];
	let nextIndex = 0;
	const runWorker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await worker(items[index], index);
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(concurrency, items.length) },
			() => runWorker()
		)
	);
	return results;
};
