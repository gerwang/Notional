# nObsidian

nObsidian is a maintained fork of the abandoned Nobsidion plugin for syncing
Obsidian notes with Notion pages.

The goal is a functional, usable, two-way sync tool that keeps Obsidian and
Notion aligned without surprising overwrites — backed by timestamp-based
conflict detection.

## Features

- **Sync side panel** — a dockable panel (ribbon icon or the `Open sync panel`
  command) showing the active note's connection status, link state, last-synced
  time, and whether each side has changed, with one-click Sync / Push / Pull,
  explicit conflict resolution, and a rolling activity log.
- Upload the current Obsidian note to Notion.
- Upload the entire vault to Notion with bounded parallelism.
- Create Notion pages for linked Obsidian notes when needed.
- Convert Obsidian wiki-links into Notion internal page mentions.
- Upload content with nested blocks deeper than Notion's two-level append
  request limit.
- Pull the current Notion page back into the linked Obsidian note.
- Sync the current note in the direction implied by stored sync timestamps.
- Stop before overwriting when both Notion and Obsidian changed since the last
  recorded sync.

## Status

Pre-release (`1.1.0-beta.1`). Obsidian-to-Notion upload is the most mature path.
Notion-to-Obsidian pull/sync works but is conservative and command/panel driven
— see [Current Limitations](#current-limitations) before relying on it for
important notes.

## Installation

nObsidian is not yet in the Obsidian community plugin store. Install it one of
two ways:

**Via BRAT (recommended — handles updates)**

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. In BRAT, choose *Add Beta Plugin*, enter `bryanbans/nObsidian`, and allow
   pre-releases so you receive betas.
3. Enable **nObsidian** under *Community Plugins*.

**Manual**

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest
   [release](https://github.com/bryanbans/nObsidian/releases).
2. Copy them into `<vault>/.obsidian/plugins/nobsidian/`.
3. Reload Obsidian and enable **nObsidian** under *Community Plugins*.

After enabling, set your Notion API token and database ID in the plugin
settings (see [Settings](#settings)).

## Sync panel

Click the **sync** ribbon icon (or run `Open sync panel`) to dock the panel in
the right sidebar. It always reflects the active note and lets you:

- See connection status and whether the note is linked to a Notion page.
- See last-synced time and whether the local file and/or Notion page changed.
- **Sync** (safe, direction inferred from timestamps), **Push** (overwrite the
  Notion page), or **Pull** (update the note, stops on conflict).
- Resolve conflicts explicitly with **Keep local → Notion** or
  **Keep Notion → local**.
- Review a rolling log of recent sync activity.

## Commands

Use Obsidian's command palette:

- `Upload current note to Notion`
- `Upload entire vault to Notion`
- `Pull current note from Notion`
- `Sync current note with Notion`
- `Open sync panel`

## Settings

Required:

- **Notion API Token** — your Notion integration token.
- **Database ID** — the Notion database new pages are created in.

Optional:

- **Banner URL** — image URL used as a page banner.
- **Notion Workspace ID** — formats share links as
  `https://<workspace>.notion.site/`.
- **Convert tags** — copy Obsidian tags into a Notion `Tags` column (the column
  must already exist).
- **Bidirectional sync (experimental)** — currently has **no effect**. The
  pull/sync commands and the sync panel work regardless of this toggle; it is a
  placeholder reserved for the planned automatic background sync.

## Sync Metadata

nObsidian stores Notion sync metadata in each note's YAML front matter:

```yaml
notionPageId: ...
notionPageUrl: ...
notionLastEditedTime: ...
obsidianLastSyncedAt: ...
```

These fields let the plugin decide whether a Notion page changed, whether the
local Obsidian file changed, and whether a pull or push would risk overwriting
work.

## Current Limitations

- Notion-to-Obsidian conversion supports a conservative block subset:
  paragraphs, headings, bullets, numbered lists, todos, quotes, code blocks,
  and dividers.
- Automatic background sync is not enabled yet. Syncing is driven from the sync
  panel or the command palette.
- Conflict resolution is a "keep one side" choice (push or force-pull); there is
  no line-level merge UI.
- Notion blocks outside the supported subset are skipped during pull.

## Roadmap

Recently landed:

- Parallel vault upload, deep block nesting, and wiki-link → Notion page
  mentions.
- Two-way sync foundation: pull/sync commands with timestamp conflict detection.
- Sync side panel with one-click actions and explicit conflict resolution.

Planned, roughly in priority order:

- [ ] **Automatic background sync** — debounced on save plus periodic polling,
      deferring to the panel's conflict resolution instead of overwriting.
- [ ] **Wider Notion → Obsidian block coverage** — tables, callouts, toggles,
      nested lists, and images, to reduce content loss on pull.
- [ ] **Front-matter preservation hardening** with round-trip tests.
- [ ] Wire up or remove the unused *Bidirectional sync* setting.
- [ ] A dedicated sync-state store instead of ad hoc front-matter fields.
- [ ] Submit to the Obsidian community plugin store after a guideline audit.

Have a request? Open an issue on
[GitHub](https://github.com/bryanbans/nObsidian/issues).

## Development

Requires Node.js (the CI builds on Node 20). Install dependencies and run the
checks:

```bash
npm install
npm run build
npm run lint
npm test
```

The build outputs `main.js`; releases bundle `main.js`, `manifest.json`, and
`styles.css`. Tagging a commit whose name matches the `manifest.json` version
(no `v` prefix) triggers the release workflow, which drafts a GitHub release
with those assets.

## Acknowledgements

This project is a fork of
[Obsidian to Notion](https://github.com/EasyChris/obsidian-to-notion/) by
[EasyChris](https://github.com/EasyChris), with additional work from the
original Nobsidion fork by Quan Phan.

## License

nObsidian is released under the [GNU General Public License v3.0](LICENSE).
