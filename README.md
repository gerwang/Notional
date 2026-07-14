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

## Configuration

Required:

- Notion API token or OAuth connection
- Database ID

Defaults for this vault:

- Publication alias: `obsidian-vault`
- Title property: `Name`
- Tags property: `tags`
- Excluded folder: `01 Templates`

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

Keep the plugin disabled until the publication identity and comment-preservation
checks have been reviewed on an unshared test page.

## Current limits

- Direct uploads only; files above the configured limit are rejected in preflight.
- Reordered or type-changed blocks may need replacement, so comments attached to
  those particular blocks cannot always be preserved.
- Rollback restores content on a best-effort basis; Notion has no multi-request
  transaction API.
- Notion remains derived publication state, not a second source of truth.

## License

GPL-3.0, following upstream Notional.
