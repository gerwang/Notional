import { extractNotionId } from "../service/utils";

describe("extractNotionId", () => {
	it("extracts the id from a page URL with a title slug", () => {
		expect(
			extractNotionId(
				"https://www.notion.so/My-Page-Title-1234567890abcdef1234567890abcdef"
			)
		).toBe("12345678-90ab-cdef-1234-567890abcdef");
	});

	it("ignores the view id in a database URL query string", () => {
		expect(
			extractNotionId(
				"https://www.notion.so/ws/abcdef1234567890abcdef1234567890?v=11111111111111111111111111111111"
			)
		).toBe("abcdef12-3456-7890-abcd-ef1234567890");
	});

	it("passes through an already-hyphenated id", () => {
		expect(extractNotionId("12345678-90ab-cdef-1234-567890abcdef")).toBe(
			"12345678-90ab-cdef-1234-567890abcdef"
		);
	});

	it("normalizes a bare 32-char id", () => {
		expect(extractNotionId("1234567890abcdef1234567890abcdef")).toBe(
			"12345678-90ab-cdef-1234-567890abcdef"
		);
	});

	it("returns null when there is no id", () => {
		expect(extractNotionId("https://example.com/not-a-notion-link")).toBeNull();
		expect(extractNotionId("")).toBeNull();
	});
});
