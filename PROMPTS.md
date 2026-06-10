# DSM Prompt Runner

The Prompt Runner lets you define custom LLM prompts — developmental edit, beta reader, continuity check, pacing analysis, or anything else — and run them on any chapter directly from the Navigator. Each prompt is a plain Markdown file with a YAML header that controls what context to inject and how to call the LLM.

---

## How it works

1. Create a `.md` file in `.draft-script/prompts/`, or run **DSM: Install Starter Prompts** to copy built-in starters into the project.
2. Open any of the three commands from the Command Palette or by right-clicking a chapter heading in the Navigator.
3. A QuickPick lists all available prompts. Pick one — DSM assembles the context blocks, renders the final prompt string, then performs the requested action.

Prompts are hot-reloaded. Saving or deleting a file in `.draft-script/prompts/` updates the list immediately with no restart.

The file `dsm-analysis.md` is reserved for the DSM extraction prompt. It is never shown in the QuickPick.

---

## More than analysis

Prompt Runner is not limited to manuscript analysis.

Because prompts can generate arbitrary output and optionally save results directly to files, they can also be used for:

* Chapter translation
* Character sheets
* World-building documentation
* Series encyclopedias
* Marketing copy
* Publishing exports
* Research summaries
* Custom project-specific workflows

For example, a translation prompt can read a chapter and write the translated version directly to:

```yaml
output:
  path: translations/en/{{chapterId}}.md
```

Likewise, a character card prompt can generate structured character profiles, or a world-building prompt can produce reference documents from the indexed project data.

Prompt Runner is designed as a general-purpose author workflow system, not just a manuscript analysis tool.

---

## Commands

All commands share the same prompt picker and context assembly pipeline. They diverge only in what they do with the rendered prompt.

| Command | What it does |
|---|---|
| *DSM: Preview Prompt* | Opens a read-only document showing context block stats (chars, words, tokens) and the full rendered prompt. No LLM call. |
| *DSM: Copy Prompt to Clipboard* | Copies the rendered prompt to the clipboard. Shows a notification with the estimated token count. No LLM call. |
| *DSM: Run Prompt* | Sends the rendered prompt to the configured LLM and opens the result in a tab. Shows a token-count warning if the prompt exceeds `draftScript.promptWarningTokens` (default 10,000). |
| *DSM: Run And Save Output* | Like *Run Prompt*, but writes the result directly to a file instead of opening a tab. Only prompts that define an `output.path` appear in this picker. |

**Preview Prompt** is the recommended starting point when writing a new prompt. It lets you inspect exactly what will be sent — which context blocks are included, how large each one is, and the full assembled text — before making any LLM calls.

### Translation example

```yaml
---
id: translate-en
title: Translate to English
scope: chapter

output:
  path: ../translations/en/{{chapterId}}.md

context:
  - chapterText
---

Translate the chapter into natural contemporary English.

{{chapterText}}
```

---

## Token estimates

Token counts are estimated as `ceil(characters / 4)`. This is a rough approximation suitable for detecting unexpectedly large prompts. It is not a precise tokenizer count. Treat the numbers as informational.

The preview document shows estimates per context block, so you can see at a glance which block is consuming the most prompt space.

---

## File format

```markdown
---
id: my-prompt
title: My Prompt Title
scope: chapter
description: One-line description shown in the picker
context:
  - chapterText
  - characters
  - activeThreads
limits:
  characters: 20
  threads: 15
---

Your prompt body here. Use {{placeholders}} to insert context.

{{context}}

Chapter text:

{{chapterText}}
```

Everything between the first `---` and the second `---` is the YAML header. Everything after is the prompt body sent to the LLM.

---

## YAML header fields

### Required

| Field | Type | Description |
|---|---|---|
| `id` | string | Stable identifier. Must be unique across all prompts in the folder. Used as the virtual document key. |
| `title` | string | Shown in the QuickPick list and as the heading in the result document. |

### Optional

| Field | Type | Default | Description |
|---|---|---|---|
| `scope` | string | `chapter` | What the prompt operates on. See [Scope](#scope) below. |
| `visibility` | string | `all` | Knowledge horizon filter. See [Visibility](#visibility) below. |
| `description` | string | — | One-line detail shown below the title in the QuickPick. |
| `menuTitle` | string | *(title)* | Override the label shown in the QuickPick only, without changing `title`. |
| `provider` | string | *(workspace setting)* | Override the LLM provider for this prompt: `vscode-lm`, `openai`, `ollama`. Falls back to `draftScript.dsmProvider` if omitted. |
| `output` | string or object | `markdown` | Output format (`markdown` or `json`) when given as a string — informational only. When given as an object with a `path` key, enables **Run And Save Output**: the LLM result is written to that file. See [Save output to a file](#save-output-to-a-file). |
| `context` | string[] | *(scope default)* | List of [context block IDs](#context-blocks) to inject. If omitted, a sensible default is chosen based on `scope`. |
| `limits` | object | — | Cap the number of items injected per context block. See [Limits](#limits). |
| `window` | object | — | Include text from adjacent chapters (reserved — not implemented in v1). |
| `enabled` | boolean | `true` | Set to `false` to temporarily hide a prompt without deleting the file. |

---

## Scope

`scope` controls which text is available and what default context blocks are used.

| Value | What is loaded | Use for |
|---|---|---|
| `chapter` | Full chapter text, chapter metadata, index data | Most prompts — developmental edit, beta reader, continuity, pacing |
| `selection` | Selected text in the active editor (falls back to full chapter if nothing is selected) | Close reading of a specific passage, targeted annotation |
| `manuscript` | Index data only, no chapter text | Novel-level overview prompts — character arcs, orphaned threads, timeline gaps, signal distribution |

When no chapter context is available (no active Markdown editor and no Navigator item selected), the command shows a warning.

Prompt files with an unrecognised `scope` value are skipped with a warning in the VS Code Output panel.

---

## Visibility

`visibility` controls which indexed data is exposed to context blocks. This lets you simulate a reader who only knows what has been revealed so far, without creating separate prompts or duplicate context block types.

| Value | What is included | Use for |
|---|---|---|
| `all` | All indexed data, no filtering | Manuscript reviews, project-wide audits, index validation, canon checks |
| `upToChapter` | Items first seen ≤ current chapter | Developmental editing, beta reader, pacing analysis — *recommended default for chapter prompts* |
| `previousChapters` | Items first seen < current chapter | Continuity checking, contradiction detection, new entity detection |
| `currentChapterOnly` | Items first seen = current chapter | Chapter extraction audit, scene review, chapter-specific analysis |

**What is filtered:** characters, locations, objects, groups, threads, continuity items, timeline events, references.

**What is never filtered:** `signals` (aggregate statistics), `chapterText`, `selectedText`, `chapterMeta`, `projectInstructions`.

The visibility mode is shown in the **Preview Prompt** header so you can confirm the filter before running.

### Examples

`visibility: upToChapter` — reviewing Chapter 20:

- Characters, threads, and continuity items first introduced in chapters 1–20 are visible.
- Anything introduced in chapter 21+ is hidden.
- The chapter text itself is always visible.

`visibility: previousChapters` — checking Chapter 20 against prior canon:

- Only information from chapters 1–19 is in context.
- The LLM sees what a reader knew *before* opening chapter 20, making it ideal for contradiction detection.

`visibility: currentChapterOnly` — auditing what Chapter 20 introduces:

- Only entities and events that first appear in chapter 20 are in context.

---

## Context blocks

Context blocks are pre-rendered Markdown sections assembled from the DSM indexes before the prompt is sent. Each block has a heading and formatted content.

Specify which blocks to include with the `context` list in the YAML header. If you omit `context`, a default set is chosen based on `scope`.

| ID | Heading | Content |
|---|---|---|
| `chapterText` | Chapter Text | Full text of the selected chapter or section |
| `selectedText` | Selected Text | Text selected in the editor (only with `scope: selection`) |
| `chapterMeta` | Chapter Info | Chapter number, title, and filename |
| `overview` | Chapter Overview | DSM overview for the selected chapter: summary, purpose, emotional beat, function, setup/payoff notes, focus areas, risks, and book impact |
| `previousChapterOverview` | Previous Chapter Overview | DSM overview for the previous chapter, when available |
| `nextChapterOverview` | Next Chapter Overview | DSM overview for the next chapter, when available |
| `characters` | Characters | All indexed characters with last seen chapter and appearance count |
| `locations` | Locations | All indexed locations with appearance count |
| `objects` | Objects | All indexed objects with appearance count |
| `groups` | Groups / Factions | All indexed groups with appearance count |
| `activeThreads` | Active Open Threads | Open threads last seen within `limits.dormantThreshold` chapters |
| `dormantThreads` | Dormant Threads | Open threads not seen for more than `limits.dormantThreshold` chapters |
| `activeContinuity` | Active Continuity Items | Continuity notes with `status: active` |
| `signals` | Signal Frequency | All signals ranked by occurrence count, with descriptions |
| `timeline` | Timeline | Timeline events in chapter order (last N, configurable via limits) |
| `references` | References | Quoted and paraphrased text references from: the current chapter, plus any thread/continuity items already included in context. Sorted by chapter number. |
| `projectInstructions` | Project Instructions | Content of `.draft-script/project.md` or `.draft-script/instructions.md` |

Blocks that have no data (empty index, no text selected, etc.) are silently omitted — they produce no heading and no empty section.

`chapterSummary` is reserved but not yet implemented. Including it has no effect in v1.

---

## Placeholders

The prompt body supports `{{placeholder}}` substitution. Placeholders are replaced before the prompt is sent to the LLM.

| Placeholder | Replaced with |
|---|---|
| `{{context}}` | All requested context blocks *except* `chapterText` and `selectedText`, formatted as `### Heading` sections separated by `---` rules. `chapterMeta` is included if listed in `context`. |
| `{{chapterText}}` | Raw text of the chapter or section |
| `{{selectedText}}` | Raw selected text (scope: selection) |
| `{{chapterMeta}}` | Chapter number, title, filename as plain text |
| `{{overview}}` | Chapter Overview block content only |
| `{{previousChapterOverview}}` | Previous Chapter Overview block content only |
| `{{nextChapterOverview}}` | Next Chapter Overview block content only |
| `{{characters}}` | Characters block content only |
| `{{locations}}` | Locations block content only |
| `{{objects}}` | Objects block content only |
| `{{groups}}` | Groups / Factions block content only |
| `{{activeThreads}}` | Active Open Threads block content only |
| `{{dormantThreads}}` | Dormant Threads block content only |
| `{{activeContinuity}}` | Active Continuity Items block content only |
| `{{signals}}` | Signal Frequency block content only |
| `{{timeline}}` | Timeline block content only |
| `{{references}}` | References block content only |
| `{{projectInstructions}}` | Project Instructions block content only |

If a placeholder refers to a context block that is not in the `context` list, or that produced no data, it is replaced with `[blockId: not available]`.

You can use `{{context}}` as a single catch-all, or reference individual blocks for precise placement. Both approaches can be mixed in one prompt.

---

## Limits

The `limits` object caps the number of items injected per context block. This prevents the prompt from growing too long for large projects.

```yaml
limits:
  characters: 20
  locations: 15
  objects: 10
  groups: 10
  threads: 20
  continuity: 20
  timeline: 30
  references: 20
  dormantThreshold: 8
```

| Key | Default | Description |
|---|---|---|
| `characters` | 50 | Max characters injected |
| `locations` | 30 | Max locations injected |
| `objects` | 20 | Max objects injected |
| `groups` | 20 | Max groups injected |
| `threads` | 30 | Max threads injected (active and dormant share this limit) |
| `continuity` | 30 | Max continuity items injected |
| `timeline` | 50 | Max timeline events injected (takes the last N events) |
| `references` | 30 | Max references injected |
| `dormantThreshold` | 10 | Chapters since last appearance before a thread is considered dormant |

---

## Default context per scope

When `context` is omitted, these defaults are used:

| Scope | Default context blocks |
|---|---|
| `selection` | `selectedText`, `chapterMeta` |
| `chapter` | `chapterText`, `chapterMeta`, `characters`, `activeThreads`, `activeContinuity`, `signals` |
| `manuscript` | `characters`, `locations`, `objects`, `groups`, `activeThreads`, `activeContinuity`, `timeline`, `signals` |

---

## Project instructions

If your workspace contains `.draft-script/project.md` or `.draft-script/instructions.md`, add `projectInstructions` to the `context` list (or reference `{{projectInstructions}}` directly) to inject it into the prompt. This is the right place to store novel-level context that every prompt should know: genre, tone, POV, language rules, character names and their canonical spellings.

---

## Complete example

```markdown
---
id: continuity-check
title: Continuity Check
scope: chapter
visibility: previousChapters
description: Flag contradictions with the established index
context:
  - chapterText
  - chapterMeta
  - characters
  - locations
  - objects
  - activeThreads
  - dormantThreads
  - activeContinuity
limits:
  characters: 30
  threads: 25
  continuity: 25
  dormantThreshold: 8
---

You are a continuity checker for a novel.

Established record:

{{context}}

---

Chapter to check:

{{chapterText}}

---

Report your findings:

### Possible continuity violations
List anything in the chapter that contradicts the established record.
Quote the offending line and explain the conflict.

### New entities
Characters, locations, or objects that appear here but are NOT in the record.

### Clean if nothing found
Write "None found" for any section with no issues.
```

---

## Save output to a file

When `output` is an object with a `path` key, the *DSM: Run And Save Output* command writes the LLM result directly to the given file instead of opening a tab.

```yaml
output:
  path: en/{{chapterId}}.md
  format: markdown     # optional — informational
```

The path is relative to the directory containing the chapter file. Directories are created automatically if they don't exist. Existing files are overwritten without prompting.

### Path template variables

| Variable | Replaced with |
|---|---|
| `{{chapterId}}` | DSM chapter ID from the index (e.g. `chapter-0017`). Falls back to the filename without extension if the chapter is not in the index. |
| `{{chapterNumber}}` | Chapter number from the index (e.g. `17`) |
| `{{chapterTitle}}` | Chapter title, sanitized for use in a filename |
| `{{promptId}}` | The prompt's `id` field |

After a successful save, a notification appears with the relative path and an **Open File** button.

---

## Includes

Common prompt fragments can be extracted into shared files and included in any prompt with `{{include:name}}`.

```markdown
{{include:0-rule}}
{{include:continuity-rules}}
```

Include files live in `.draft-script/prompts/_includes/`. The directive is replaced with the full file content before any context substitution or token counting — so the rendered prompt and token estimate always reflect the included text.

Include directives are resolved in this order relative to the rest of the rendering pipeline:

1. Include directives expanded (this step)
2. `{{context}}` and `{{characterText}}` placeholders substituted
3. Token count computed on the final result

Includes support nesting. A file referenced by `{{include:0-rule}}` can itself contain `{{include:no-spice}}`, and so on to any depth.

### Circular include detection

If include A includes B and B includes A, the extension shows an error and blocks rendering:

```
Circular include:
  0-rule
   -> continuity-rules
   -> 0-rule
```

### Missing include handling

If the referenced file does not exist the error is shown inline in the Preview and Run is blocked:

```
Missing include: _includes/no-spice.md
```

### Preview UI

The **Preview Prompt** document shows an **Included Files** section with the full dependency tree:

```
✓ 0-rule.md
  └─ ✓ no-spice.md
✓ continuity-rules.md
✗ missing-file.md *(not found)*
```

The token breakdown shows include tokens separately:

```
Total tokens:    4,620
Context tokens:  3,200
Include tokens:    420
Template tokens:   1,000
```

---

## Folder structure

```
.draft-script/
  prompts/
    dsm-analysis.md          ← reserved — DSM extraction prompt (not shown in QuickPick)
    continuity-check.md      ← your custom prompts
    developmental-editor.md
    beta-reader.md
    pacing-analysis.md
    _includes/               ← shared prompt fragments
      0-rule.md
      continuity-rules.md
      beta-reader-rules.md
```

Starter prompts can be installed with **DSM: Install Starter Prompts**. Draft-Script copies them into `.draft-script/prompts/`, where you can edit them like any other project prompt. The repository also keeps example prompt files under `examples/prompts/` for reference.
