import { execFile } from "child_process";

const SECRET_TOOL_PATH = "/usr/bin/secret-tool";
const LOOKUP_ARGUMENTS = [
	"lookup",
	"application",
	"obsidian-llm-wiki",
	"variable",
	"NOTION_INTEGRATION_TOKEN",
];

export type KeyringCredentialStatus =
	| "unloaded"
	| "loaded"
	| "missing"
	| "unsupported"
	| "error";

export type KeyringCredentialState = {
	status: KeyringCredentialStatus;
	message: string;
};

let notionKeyringToken = "";
let notionKeyringState: KeyringCredentialState = {
	status: "unloaded",
	message: "The desktop keyring has not been checked yet.",
};

const updateState = (
	status: KeyringCredentialStatus,
	message: string
): KeyringCredentialState => {
	notionKeyringState = { status, message };
	return { ...notionKeyringState };
};

export const getNotionKeyringToken = (): string => notionKeyringToken;

export const getNotionKeyringState = (): KeyringCredentialState => ({
	...notionKeyringState,
});

/**
 * Load the Notion integration token through Secret Service. KDE exposes
 * KWallet through the same org.freedesktop.secrets API used by secret-tool.
 * The secret is kept only in module memory and is never included in settings.
 */
export const refreshNotionKeyringToken = async (): Promise<KeyringCredentialState> => {
	notionKeyringToken = "";
	if (process.platform !== "linux") {
		return updateState(
			"unsupported",
			"Secret Service/KWallet lookup is available only on Linux desktop."
		);
	}

	return new Promise((resolve) => {
		execFile(
			SECRET_TOOL_PATH,
			LOOKUP_ARGUMENTS,
			{
				encoding: "utf8",
				maxBuffer: 8192,
				timeout: 5000,
				windowsHide: true,
			},
			(error, stdout) => {
				if (error) {
					const code = (error as { code?: string | number }).code;
					if (code === "ENOENT") {
						resolve(
							updateState(
								"unsupported",
								"/usr/bin/secret-tool is not installed."
							)
						);
						return;
					}
					if (code === 1) {
						resolve(
							updateState(
								"missing",
								"No NOTION_INTEGRATION_TOKEN entry was found in the desktop keyring."
							)
						);
						return;
					}
					resolve(
						updateState(
							"error",
							"The desktop keyring could not be read. It may be locked or unavailable."
						)
					);
					return;
				}

				const token = stdout.trim();
				if (!token) {
					resolve(
						updateState(
							"missing",
							"The NOTION_INTEGRATION_TOKEN keyring entry is empty."
						)
					);
					return;
				}

				notionKeyringToken = token;
				resolve(
					updateState(
						"loaded",
						"Loaded NOTION_INTEGRATION_TOKEN from Secret Service/KWallet."
					)
				);
			}
		);
	});
};
