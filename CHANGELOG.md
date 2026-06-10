# Changelog

## 0.2.9

### Added

- Added a simple export pipeline:
  - **Draft-Script: Build Manuscript Markdown** creates `exports/manuscript.md` without requiring external tools.
  - **Draft-Script: Export with Pandoc...** exports DOCX, EPUB, HTML, or PDF through an external Pandoc installation.
  - **Draft-Script: Configure Pandoc Path** lets users pick a local Pandoc executable such as `pandoc.exe`.
  - Added export settings for output directory, Pandoc path, default format, PDF engine, auto-open, reference DOCX, EPUB cover, and PDF template.
  - Added optional `.draft-script/export.json` project config for metadata and export options.
- Added friendly Pandoc/PDF-engine failure handling and a **Draft-Script Export** output channel.
- Added repetition line-edit review improvements:
  - Batch line-edit suggestions for repeated phrases in the current chapter.
  - Per-suggestion **Open Diff** review using readonly virtual documents.
  - **Open Diff for Accepted** to compare all currently accepted suggestions at once.
  - Review-state preservation while opening/closing diff views.
  - Output logging for invalid line-edit JSON and failed LLM calls.
- Added chapter overview extraction to DSM analysis:
  - Summary, purpose, emotional beat, chapter function, setup/payoff notes, human/technical focus, risk flags, and book impact.
  - New Prompt Runner context blocks: `overview`, `previousChapterOverview`, and `nextChapterOverview`.
- Added Repetition panel locking, matching the Novel Statistics lock behavior, so repetition analysis can stay pinned to the full novel.
- Added user-created canon entries backed by overrides, so manually created canon entries can survive index/canon regeneration.
- Added bundled internal prompt files for DSM analysis and line-edit defaults, with user project prompts still overriding defaults.
- Added packaged starter Prompt Runner prompts and **DSM: Install Starter Prompts**, so new users can start without copying files from the repository.

### Improved

- Improved Canon/Characters behavior so character data relies on effective canon entries and overrides instead of `characters.md`.
- Improved character mention counting and navigation to use aliases and configured inflection matching consistently.
- Improved chapter creation logic for single-file vs split-file projects, while respecting ignored folders such as translation folders.
- Improved line-edit source navigation so clicking suggestion text selects the existing manuscript editor when possible instead of opening an unwanted tab in the suggestion group.
- Improved Canon Editor and Index Explorer navigation responsiveness by suppressing expensive sidebar refreshes during programmatic jumps.
- Improved repetition overlap filtering performance so enabling overlap filtering no longer slows down the rest of the UI as much.
- Improved DSM prompt organization by moving hardcoded analysis prompt/schema text into physical bundled prompt/resource files.
- Updated README, User Guide, and Prompt Runner docs for export, repetition line edits, starter prompts, chapter overview context blocks, thread review, prompt behavior, dashboards, and settings.

### Fixed

- Fixed prompt result/diff/navigation behavior where webviews could steal the editor group and open the manuscript in the wrong tab.
- Fixed manual line-edit review edits being lost after opening a diff.
- Fixed adding a new chapter in single-file projects so it appends a heading to the manuscript instead of creating a separate file.
- Fixed character/canon navigation delays when clicking chapter references.
- Fixed stale DSM chapter scan state refresh behavior after manual mark-as-scanned and index regeneration.
- Fixed line-edit JSON/error reporting so remote/provider failures are visible in an output channel instead of only surfacing as terse UI failures.

### Removed

- Removed the Canon Editor debug bar and the `draftScript.debugMode` setting.
- Removed an obsolete rendered prompt example artifact from `examples/prompts/`.

### Notes

- Pandoc is not bundled with Draft-Script. DOCX, EPUB, HTML, and PDF export require installing Pandoc separately.
- PDF export may also require a TeX/PDF engine such as `xelatex`.

## 0.2.8

### Added

- Added a dedicated thread review workflow in **DSM: Open Index Explorer**.
  - Review bar with review count, **Show only review**, and **Next** controls.
  - Inline **Review** actions for uncertain threads and suggested lifecycle changes.
  - Support for confirming/rejecting suggestions, setting thread status, and dismissing invalid threads.
- Added clickable chapter links in the sidebar dashboard for:
  - **Threads Needing Review**
  - **Dormant Threads**
  - **Active Threads**
- Added **Copy to Clipboard** to chapter and file context menus in the Navigator.
- Added extension icon metadata and refreshed marketplace keywords.

### Improved

- Prompt results now open in a locked Markdown preview, so clicking back into the manuscript no longer replaces the prompt output preview.
- Thread review behavior is now documented in the User Guide.
- README now includes dashboard screenshots and a clearer User Guide link.

### Fixed

- Prevented prompt result previews from being hijacked by the active Markdown editor.
