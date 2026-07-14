---
name: publish-obsidian-to-notion
description: Prepare, validate, install, or operate the Notional Vault Publisher and its local CLI for deliberate one-way Obsidian-to-Notion publication. Use for note preflight, agent-driven single-note publication, stable in-place page updates, note-local image/PDF embeds, recursive linked-note publishing, plugin deployment, or publication failure diagnosis. Markdown remains canonical and Notion is only a publication target.
---

# Publish Obsidian to Notion

Use the `notional-vault-publisher` Obsidian plugin. Do not invent a separate
conversion or direct-API workflow.

For CLI or AI-agent work, use `notional-publish`. It talks to the enabled plugin
over a private, vault-specific Unix socket, so Obsidian must be running. The CLI
does not receive the Notion token and does not bypass the publisher.

## Safety boundary

- Read the vault's nearest `AGENTS.md` before acting.
- Never enable the plugin, invoke publication, or call the Notion API without
  explicit user authorization.
- Preserve `NotionID-<alias>` and `link-<alias>` exactly. Treat a mismatch as a
  blocker; never detach, rotate, or recreate an existing public page.
- Keep Markdown canonical. Do not rewrite a note merely to satisfy the publisher.
- Prefer the Linux Secret Service/KWallet credential named
  `NOTION_INTEGRATION_TOKEN` under application `obsidian-llm-wiki`. The plugin
  retrieves it at load time and keeps it only in memory; do not copy it into
  plugin settings when the keyring is available.
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
6. For an agent, run the local CLI preflight as the final check. A human may use
   the equivalent **Preflight current note (no upload)** command in Obsidian.
   Preflight must not contact or modify Notion.

```bash
notional-publish status --vault "$vault"
notional-publish preflight "$note" --vault "$vault"
```

The output is JSON. Save `data.fingerprint` from the successful preflight and
report `data.warnings` before requesting publication approval. Do not infer that
an earlier request to edit or inspect a note authorizes publication.

Do not create missing Markdown notes from unresolved wiki-links.

## Publication

After explicit authorization, select the narrowest plugin command:

- **Publish current note to Notion** for one page.
- **Publish current folder to Notion** for a recursive folder selection.
- **Publish current note and linked notes recursively** for a linked-note closure.
- **Repair published links to current note** after publishing a formerly
  unpublished target. It only republishes already-published inbound-link sources
  and asks for confirmation before writing.

For one CLI-controlled page, use the fingerprint from the immediately preceding
preflight:

```bash
notional-publish publish "$note" --vault "$vault" \
  --confirm --fingerprint "$fingerprint"
```

- If the bridge returns `stale_preflight`, rerun preflight and review the new
  result; never reuse or fabricate a fingerprint.
- If preflight reports warnings, stop and report them. Add `--allow-warnings`
  only when the user explicitly accepts those specific warnings.
- Never call the Notion API directly as a fallback when the bridge is unavailable.
- Folder and linked-note recursive publication remain deliberate GUI operations.

Inbound-link repair is also two-stage. First obtain the plan without `--confirm`,
review its pages and warnings, then use its fingerprint only after explicit
authorization:

```bash
notional-publish repair-links "$note" --vault "$vault"
notional-publish repair-links "$note" --vault "$vault" \
  --confirm --fingerprint "$repair_fingerprint"
```

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

Install the CLI separately and keep it executable:

```bash
install -m 0755 bin/notional-publish.mjs ~/bin/notional-publish
```

After replacing plugin files, Obsidian must reload the plugin before the new
bridge is available. A CLI `status` request is a safe readiness check.
