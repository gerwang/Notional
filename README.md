# Notional Vault Publisher

An auditable, deliberate Obsidian → Notion publisher for research vaults where
Markdown is canonical and Notion is a publication target.

This is a fork of [Notional](https://github.com/bryanbans/Notional). It removes
two-way sync and automatic publication from the active plugin surface. Publishing
only happens through an explicit command.

## Safety model

- Existing `NotionID-<alias>` and `link-<alias>` values are immutable external
  identities. The default alias is `obsidian-vault`.
- Existing pages are updated in place. Compatible blocks are patched by block ID;
  unchanged blocks are left untouched so their inline comments survive.
- Conversion and attachment resolution finish before a page is changed.
- A failed reconciliation attempts to restore the pre-publication content snapshot.
- `01 Templates` is excluded by default.
- The plugin never pulls Notion content into Markdown and has no autosync mode.
- Unresolved wiki-links are reported and rendered as text; the plugin never creates
  local Markdown files implicitly.
- CLI requests use a vault-specific Unix socket readable only by the desktop user.
  The Notion credential remains inside the running Obsidian plugin.

## Note-local assets

The publisher supports Obsidian embeds such as:

```markdown
![[Note title/figure.png]]
```

Resolution follows the vault contract:

1. Relative to the note's parent directory.
2. Relative to the vault root.
3. Unique basename compatibility fallback.

Ambiguous or missing files fail preflight. Images and PDFs up to the configured
limit (5 MiB by default) use Notion's direct file-upload API and become
Notion-hosted blocks.

## Commands

- **Preflight current note (no upload)** — resolve assets and links without a
  Notion write.
- **Publish current note to Notion** — update or create one page.
- **Publish current folder to Notion** — recursively publish Markdown files in the
  active note's folder, excluding configured folders.
- **Publish current note and linked notes recursively** — preflight the linked-note
  closure, establish missing page identities, then publish dependencies first.
- **Repair published links to current note** — find already-published notes with
  ordinary wiki-links to the active note, preflight them, request confirmation,
  and republish them in place. It never publishes an unpublished source note.

## CLI and AI agents

With Obsidian running and the plugin enabled, the same single-note workflow is
available without GUI interaction:

```bash
notional-publish status
notional-publish preflight "30 Topics/Example.md"
notional-publish publish "30 Topics/Example.md" \
  --confirm --fingerprint <SHA-256-from-preflight>
```

All responses are JSON. Preflight is read-only and never contacts Notion. A
publish request must repeat the exact preflight fingerprint, so a note, resolved
asset, or relevant setting changed after review is rejected as stale. Warnings
block publication unless the caller adds `--allow-warnings`; an agent should only
do that after reporting the warnings and receiving explicit approval.

Repairing inbound links uses the same two-step protocol:

```bash
notional-publish repair-links "30 Topics/Published target.md"
notional-publish repair-links "30 Topics/Published target.md" \
  --confirm --fingerprint <SHA-256-from-repair-plan>
```

The bridge serializes writes and records a token-free audit log at
`$XDG_STATE_HOME/notional-vault-publisher/audit.jsonl` (normally
`~/.local/state/notional-vault-publisher/audit.jsonl`). Its vault-specific socket
lives below `$XDG_RUNTIME_DIR/notional-vault-publisher/`, with a private `/tmp`
fallback. Both are local desktop interfaces; the bridge does not listen on TCP.

Exit status `0` means success, `2` is CLI misuse, `3` is a bridge/protocol error,
`4` means review or a fresh preflight is required, and `5` is a publication or
configuration failure. Use `--vault PATH` or `NOTIONAL_VAULT` when the current
directory is not inside the intended vault.

## Configuration

Required:

- Notion API token or OAuth connection
- Database ID

Defaults for this vault:

- Publication alias: `obsidian-vault`
- Title property: `Name`
- Tags property: `tags`
- Excluded folder: `01 Templates`

### Desktop keyring

On Linux desktop, the publisher loads `NOTION_INTEGRATION_TOKEN` from Secret
Service/KWallet by running `/usr/bin/secret-tool` without a shell:

```text
application = obsidian-llm-wiki
variable = NOTION_INTEGRATION_TOKEN
```

The token stays in memory and is never copied into plugin `data.json`. OAuth has
priority when configured; the keyring has priority over the explicitly labeled
plaintext fallback. A successful keyring load removes any duplicate manual token
from saved plugin settings. This makes the plugin desktop-only.

With Notion API `2026-03-11`, new pages require a data source ID. Set it directly
or let the plugin discover the database's first data source.

## Build and test

```bash
npm ci
npm run build
npm test -- --runInBand
npm run lint
```

Build output is `main.js`. For manual installation, copy `main.js`,
`manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/notional-vault-publisher/
```

Install the companion CLI somewhere on `PATH`, for example:

```bash
install -m 0755 bin/notional-publish.mjs ~/bin/notional-publish
```

Keep the plugin disabled until the publication identity and comment-preservation
checks have been reviewed on an unshared test page.

## Current limits

- Direct uploads only; files above the configured limit are rejected in preflight.
- Reordered or type-changed blocks may need replacement, so comments attached to
  those particular blocks cannot always be preserved.
- Rollback restores content on a best-effort basis; Notion has no multi-request
  transaction API.
- Notion remains derived publication state, not a second source of truth.
- Publishing a formerly-unpublished link target does not silently cascade writes;
  run **Repair published links to current note** when those inbound links should
  become native Notion page mentions.
- Folder publication and linked-note recursive publication remain GUI commands;
  the CLI deliberately exposes only one-note publication and bounded link repair.

## License

GPL-3.0, following upstream Notional.
