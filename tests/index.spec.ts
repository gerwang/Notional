jest.mock("obsidian");

import { runWithConcurrency } from "../service";

describe("runWithConcurrency", () => {
	it("caps active workers and preserves result order", async () => {
		let activeWorkers = 0;
		let maxActiveWorkers = 0;
		const results = await runWithConcurrency(
			[1, 2, 3, 4, 5],
			2,
			async (item) => {
				activeWorkers += 1;
				maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
				await Promise.resolve();
				activeWorkers -= 1;
				return item * 2;
			}
		);
		expect(maxActiveWorkers).toBeLessThanOrEqual(2);
		expect(results).toEqual([2, 4, 6, 8, 10]);
	});

	it("rejects invalid concurrency values", async () => {
		await expect(
			runWithConcurrency([1], 0, async (item) => item)
		).rejects.toThrow("Concurrency must be a positive integer");
	});
});
