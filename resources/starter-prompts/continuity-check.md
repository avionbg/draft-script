---
id: continuity-check
title: Continuity Check
scope: chapter
visibility: previousChapters
description: Flag continuity violations, dropped threads, and contradictions with the index
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
  locations: 20
  objects: 15
  threads: 25
  continuity: 25
  dormantThreshold: 8
---

You are a continuity checker for a novel. Your job is to find inconsistencies between a chapter and the established record of characters, locations, objects, threads, and world-state.

Established record:

{{context}}

---

Chapter to check:

{{chapterText}}

---

Report your findings in these sections:

### Possible continuity violations
List anything in the chapter that contradicts the established record. For each: quote the offending line, describe the conflict, and suggest a fix.

### Dormant threads referenced
List any threads from the dormant list that appear in this chapter. Flag whether they are being properly re-introduced.

### New entities
List any characters, locations, or objects that appear in this chapter but are NOT in the established record. These may need to be added to the index.

### Continuity items that should appear but don't
Based on active continuity items, are there any world-state facts that should logically affect this chapter but seem to be ignored?

### Clean bill of health
If no issues are found in a section, write "None found" rather than omitting it.

Be precise. Quote the text. Do not invent issues that aren't there.
