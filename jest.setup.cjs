// Provide a window global for the node test env so window.setTimeout works.
if (typeof globalThis.window === "undefined") {
	globalThis.window = globalThis;
}
