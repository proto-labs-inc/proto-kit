---
name: create-pr-plan
description: Decompose a prototype's implementation into focused, ordered pull-request slices and record the plan in Proto. Use when the user asks to split prototype work into PRs; use implement-pr-plan to build them.
---

# Create a PR plan

Create or revise only the implementation plan for an existing Proto prototype. This skill does not create a prototype, implement code changes, create branches, or open pull requests. When the user asks to implement planned entries, hand off to `implement-pr-plan`.

## Inspect the prototype

1. Locate the prototype workspace and read `public/prototype.json`. Review the rendered page, registered preview states, and component markers so each planned slice maps to real UI and a useful review state.
2. Read the relevant codebase guidance, especially `AGENTS.md` and any product or design context. Preserve unrelated workspace changes.
3. If the prototype is missing or its page, states, or target markers cannot be inspected, stop and ask for the missing context; do not invent a plan from a title alone.

## Decompose the work

- Split by cohesive user-visible capability and implementation responsibility, not arbitrary file count. Keep each entry small enough to review independently.
- Order entries by dependency. Prefer independent slices; when one depends on another, describe that dependency so the implementation PRs can be stacked intentionally.
- For each entry, provide a concise title and implementation-oriented description, an existing state id that demonstrates the area, an existing `data-proto-id` as `targetId`, and a contextual wireframe asset path.
- Create simple wireframes in `public/wireframes/` that show the affected region in enough page context to orient a reviewer and highlight that region consistently with the Proto accent color.
- Validate every referenced state, target marker, and asset path. Preserve unrelated prototype metadata and entry ordering unless the user asks to revise them.

Write the entries to `prPlan.entries` in `public/prototype.json`, then use the prototype's established serve/register workflow so the plan appears in the Frame. Do not create implementation branches or PRs in this skill. Report the planned slices and their dependency order; point implementation requests to `implement-pr-plan`.
