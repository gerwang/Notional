import { createHash } from "crypto";
import { isAbsolute, posix } from "path";

export const CLI_PROTOCOL_VERSION = 1;
export const CLI_MAX_REQUEST_BYTES = 64 * 1024;
export const CLI_MAX_RESPONSE_BYTES = 1024 * 1024;

export type CliOperation =
	| "status"
	| "preflight"
	| "publish"
	| "repair-links";

export type CliRequest = {
	protocol: 1;
	id: string;
	operation: CliOperation;
	path?: string;
	confirm?: boolean;
	allowWarnings?: boolean;
	fingerprint?: string;
};

export type CliErrorBody = {
	code: string;
	message: string;
	data?: unknown;
};

export type CliResponse = {
	protocol: 1;
	id: string;
	ok: boolean;
	data?: unknown;
	error?: CliErrorBody;
};

export class CliBridgeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly data?: unknown
	) {
		super(message);
		this.name = "CliBridgeError";
	}
}

const OPERATIONS = new Set<CliOperation>([
	"status",
	"preflight",
	"publish",
	"repair-links",
]);

export const validateVaultRelativeMarkdownPath = (rawPath: unknown): string => {
	if (typeof rawPath !== "string" || !rawPath.trim()) {
		throw new CliBridgeError("invalid_path", "A note path is required.");
	}
	if (rawPath.length > 4096 || rawPath.includes("\0")) {
		throw new CliBridgeError("invalid_path", "The note path is invalid.");
	}
	const slashPath = rawPath.trim().replace(/\\/g, "/");
	if (
		isAbsolute(slashPath) ||
		/^[A-Za-z]:\//.test(slashPath) ||
		slashPath.split("/").includes("..")
	) {
		throw new CliBridgeError(
			"invalid_path",
			"The note path must stay inside the vault."
		);
	}
	const normalized = posix.normalize(slashPath).replace(/^\.\//, "");
	if (!normalized.toLowerCase().endsWith(".md")) {
		throw new CliBridgeError(
			"invalid_path",
			"The target must be a Markdown file."
		);
	}
	return normalized;
};

export const parseCliRequest = (value: unknown): CliRequest => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new CliBridgeError("invalid_request", "Expected a JSON object.");
	}
	const request = value as Record<string, unknown>;
	if (request.protocol !== CLI_PROTOCOL_VERSION) {
		throw new CliBridgeError(
			"unsupported_protocol",
			`CLI protocol ${CLI_PROTOCOL_VERSION} is required.`
		);
	}
	if (
		typeof request.id !== "string" ||
		!/^[A-Za-z0-9-]{1,128}$/.test(request.id)
	) {
		throw new CliBridgeError("invalid_request", "Invalid request ID.");
	}
	if (
		typeof request.operation !== "string" ||
		!OPERATIONS.has(request.operation as CliOperation)
	) {
		throw new CliBridgeError("invalid_operation", "Unsupported operation.");
	}

	const operation = request.operation as CliOperation;
	const allowedFields = new Set([
		"protocol",
		"id",
		"operation",
		...(operation === "status" ? [] : ["path"]),
		...(operation === "publish" || operation === "repair-links"
			? ["confirm", "allowWarnings", "fingerprint"]
			: []),
	]);
	for (const field of Object.keys(request)) {
		if (!allowedFields.has(field)) {
			throw new CliBridgeError(
				"invalid_request",
				`Unexpected request field: ${field}`
			);
		}
	}
	const parsed: CliRequest = {
		protocol: CLI_PROTOCOL_VERSION,
		id: request.id,
		operation,
	};
	if (operation !== "status") {
		parsed.path = validateVaultRelativeMarkdownPath(request.path);
	}
	if (request.confirm !== undefined) {
		if (typeof request.confirm !== "boolean") {
			throw new CliBridgeError("invalid_request", "confirm must be boolean.");
		}
		parsed.confirm = request.confirm;
	}
	if (request.allowWarnings !== undefined) {
		if (typeof request.allowWarnings !== "boolean") {
			throw new CliBridgeError(
				"invalid_request",
				"allowWarnings must be boolean."
			);
		}
		parsed.allowWarnings = request.allowWarnings;
	}
	if (request.fingerprint !== undefined) {
		if (
			typeof request.fingerprint !== "string" ||
			!/^[a-f0-9]{64}$/.test(request.fingerprint)
		) {
			throw new CliBridgeError(
				"invalid_request",
				"fingerprint must be a SHA-256 digest."
			);
		}
		parsed.fingerprint = request.fingerprint;
	}
	return parsed;
};

export const socketPathForVault = (
	vaultPath: string,
	runtimeDirectory: string
): string => {
	const digest = createHash("sha256")
		.update(vaultPath)
		.digest("hex")
		.slice(0, 16);
	return posix.join(
		runtimeDirectory.replace(/\\/g, "/"),
		"notional-vault-publisher",
		`${digest}.sock`
	);
};

export const successResponse = (id: string, data: unknown): CliResponse => ({
	protocol: CLI_PROTOCOL_VERSION,
	id,
	ok: true,
	data,
});

export const errorResponse = (
	id: string,
	error: unknown
): CliResponse => {
	const normalized =
		error instanceof CliBridgeError
			? error
			: new CliBridgeError(
					"internal_error",
					error instanceof Error ? error.message : String(error)
				);
	return {
		protocol: CLI_PROTOCOL_VERSION,
		id,
		ok: false,
		error: {
			code: normalized.code,
			message: normalized.message,
			...(normalized.data === undefined ? {} : { data: normalized.data }),
		},
	};
};
