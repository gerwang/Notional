---
name: publish-obsidian-to-notion
description: Prepare, validate, install, or operate the Notional Vault Publisher for deliberate one-way Obsidian-to-Notion publication. Use for note preflight, stable in-place page updates, note-local image/PDF embeds, recursive linked-note publishing, plugin deployment, or publication failure diagnosis. Markdown remains canonical and Notion is only a publication target.
---

# Publish Obsidian to Notion

Use the `notional-vault-publisher` Obsidian plugin. Do not invent a separate
conversion or direct-API workflow.

## Safety boundary

- Read the vault's nearest `AGENTS.md` before acting.
- Never enable the plugin, invoke publication, or call the Notion API without
  explicit user authorization.
- Preserve `NotionID-<alias>` and `link-<alias>` exactly. Treat a mismatch as a
  blocker; never detach, rotate, or recreate an existing public page.
- Keep Markdown canonical. Do not rewrite a note merely to satisfy the publisher.
- Exclude configured private/template folders; `01 Templates` is excluded by
  default.
- Use AI only to explain or repair a reported source problem. Publication itself
  is deterministic and requires no agent preprocessing.

## Preflight

Before any authorized publication:

1. Confirm the target note is inside the intended vault and outside excluded
   folders.
2. Confirm its existing publication identity, if any.
3. Resolve local embeds in this order: note parent, vault root, unique basename.
4. Fail on missing or ambiguous assets and files above the configured limit.
5. Report unreviewed status and unpublished wiki-link targets as warnings.
6. Prefer the plugin command **Preflight current note (no upload)** for the final
   check. Preflight must not contact or modify Notion.

Do not create missing Markdown notes from unresolved wiki-links.

## Publication

After explicit authorization, select the narrowest plugin command:

- **Publish current note to Notion** for one page.
- **Publish current folder to Notion** for a recursive folder selection.
- **Publish current note and linked notes recursively** for a linked-note closure.

The publisher uploads assets first, compiles Notion blocks, verifies an existing
page, then reconciles blocks in place. Compatible and unchanged blocks retain
their IDs. A type change or reorder can require block replacement and may lose
comments attached to those particular blocks.

Never substitute `replace_content`, delete-and-recreate, or page archival for the
plugin's reconciliation path.

## Verify

For advisor-facing pages, compare before and after:

- Page ID and URL are unchanged.
- Images occur in the correct order and are Notion-hosted.
- Page comments remain; test inline comments on unchanged and edited blocks.
- No unexpected pages or template pages were created.
- The source Markdown body and note-local assets remain canonical.

Stop and report any failed rollback or identity mismatch.

## Build or install the plugin

Locate the repository through `$NOTIONAL_PUBLISHER_REPO`, or use
`~/Documents/git-task/Notional` when present. Run:

```bash
npm ci
npm run build
npm test -- --runInBand
npm run lint
```

For a manual install, copy only `main.js`, `manifest.json`, and `styles.css` to
`<vault>/.obsidian/plugins/notional-vault-publisher/`. Installation does not
authorize enabling or publishing.
