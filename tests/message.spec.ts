import { NoticeMsg } from "../static/message";
import { NoticeMessageConfig } from "../service/utils";

// Notice keys that main.ts looks up at runtime via this.message[...].
// If a language table omits one (as the en table once did for "open-file"),
// users see an empty Notice. These tests guard against that regression.
const REQUIRED_KEYS = [
	"config-settings",
	"open-file",
	"all-sync-success",
	"sync-success",
];

describe("NoticeMsg tables", () => {
	const languages = Object.keys(NoticeMsg);

	it("exposes every language used by the plugin", () => {
		expect(languages).toContain("en");
		expect(languages).toContain("zh");
	});

	it.each(languages)(
		"defines all runtime-required notice keys for %s",
		(lang) => {
			const table = NoticeMessageConfig(lang);
			for (const key of REQUIRED_KEYS) {
				expect(typeof table[key]).toBe("string");
				expect(table[key].length).toBeGreaterThan(0);
			}
		}
	);

	it("keeps the same key set across all languages", () => {
		const keySets = languages.map((lang) =>
			Object.keys(NoticeMsg[lang]).sort()
		);
		for (const keys of keySets) {
			expect(keys).toEqual(keySets[0]);
		}
	});
});
