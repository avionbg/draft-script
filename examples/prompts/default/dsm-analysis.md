You are analyzing a chapter from a novel.

Extract from the provided text:
- overview: concise chapter summary, structural purpose, emotional/social function, setup/payoff role, human/technical focus, and editorial risk flags.
- characters: named people, beings, or roles that matter in the passage.
- locations: named places, routes, settlements, rooms, regions, or other meaningful spaces.
- objects: named or significant items, tools, documents, resources, devices, symbols, or artifacts.
- groups: tribes, factions, families, institutions, crews, organizations, or social groups.
- threads: new unresolved threads and lifecycle updates to known threads, including progressed, reinforced, changed, partially resolved, resolved, and reopened threads.
- timelineEvents: events with temporal significance, in order of occurrence when determinable.
- continuityNotes: persistent state changes, resource tracking, construction, technology, relationships, logistics, promises, risks, and other facts that must remain consistent.
- timeIndex: temporal evidence such as seasons, time references, chapter duration, covered span, and gap estimates.

Thread lifecycle guidance:
- Use known thread lastKnownState and unresolvedQuestion from {{context}} when deciding whether a thread progressed, changed, resolved, or only reinforced the same issue.
- If the chapter answers a known unresolvedQuestion, return that known thread with status "resolved" or "changed".
- If the chapter only confirms the same open concern, return updateType "reinforced".
- Use parentThread when a thread is a sub-task or sub-question of a broader thread.

Signal guidance:
- Use signal IDs only from {{signals}}.
- Use each available signal according to its description.

Rules:
- Do not invent information not present in the text.
- If unsure about an entry, set confidence below 0.7.
- Keep descriptions short, usually 1-2 sentences.
- roleInChapter: what this entity specifically does or represents in THIS passage.
- reference: include 1-2 short quotes or paraphrases supporting each extraction.
- aliases: list other name forms used in the text.

Chapter overview guidance:
- Keep summary factual and short.
- Do not rewrite the chapter or invent events.
- Purpose should explain the chapter's structural role in the book.
- Emotional beat should identify what changes in Marko, another character, a relationship, or the community.
- If the chapter is mostly procedural or technical, say so in riskFlags.
- If other characters gain agency or take over parts of Marko's system, include that in humanFocus.
- Use Serbian if the manuscript is Serbian.

{{context}}

{{signals}}

Pre-extracted name candidates (use as hints, not gospel):
{{candidates}}

Text:
"""
{{text}}
"""

{{schema}}
