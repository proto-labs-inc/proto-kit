---
name: implement-pr-plan
description: Implement one or more entries from an existing Proto PR plan as focused pull requests and link them back to Proto. Use when the user asks to create or continue implementation PRs; use create-pr-plan to decompose work.
---

# Implement PR plan entries

Implement selected entries from an existing prototype `prPlan` as reviewable code changes, then link each result back to the plan in Proto. This skill does not create or revise the plan; use `create-pr-plan` for decomposition. It does not create or modify the prototype itself.

## Read the plan and choose the work

1. Locate the prototype workspace and read `public/prototype.json`. Confirm the requested entries, their `state`, `targetId`, descriptions, and order. Treat the plan as the scope; if it is missing or the requested work is not represented, stop and direct the user to `create-pr-plan` rather than silently changing the plan.
2. Read the repository's `AGENTS.md`, relevant skills, and project guidance. Inspect the current branch and worktree before editing. Preserve unrelated user changes.
3. Implement the requested entry or entries in dependency order. Use separate branches and focused commits for independently reviewable PRs. If entries depend on one another, make the base relationship explicit (stacked PRs when appropriate) and preserve that order; do not merge unrelated upstream history merely to stack work.
4. Verify proportionally to the change and report checks that could not run. Do not claim tests passed if they were not run.

## Publish only with authorization

Creating branches, pushing, opening or updating PRs, and publishing previews affect external systems. Perform only the actions the user requested and only against the repository and destination they specified or clearly established. Before pushing or opening a PR, inspect the configured remotes, repository, base branch, and outgoing diff so the exact destination and payload are known. If an approval or safety gate blocks publication, stop; explain what was blocked and ask the user to authorize that exact destination and action. Do not route around the gate through another tool, API, browser, or indirect write.

Reuse an existing PR when the request is to continue that PR; don't create a duplicate. Keep its scope and base relationship aligned with the plan. If the existing branch's base or history differs materially, stop before rewriting or force-pushing and present the concrete options.

## Link completed work back in Proto

After a PR is successfully created or updated, edit the prototype's `public/prototype.json` entry for that plan item:

- `pullRequestUrl`: the canonical URL of the created or updated PR.
- `branchUrl`: a URL that opens the actual source branch in the hosting service.
- `status`: the verified current PR state: `"draft"` for a draft PR, `"in-review"` for an open non-draft PR, `"merged"` for a merged PR, or `"closed"` for a closed unmerged PR.
- `previewUrl`: the deployed preview URL, only when a usable preview exists; omit it otherwise.

Read the PR state from the hosting service at the same time you verify its URL, and update `status` whenever you refresh the PR or branch links. Preserve the entry's title, description, state, wireframe, target, and ordering. Link only verified URLs; never invent a PR, branch, or preview URL. Save and serve/register the updated prototype using the repo's established workflow so the links and status appear in the PR Plan UI. If the prototype manifest is not in a writable workspace or registration cannot be completed, report the exact manifest change needed and why it remains unapplied.

Finish with a compact per-entry summary: PR URL, branch URL, status, preview URL if available, verification performed, and any remaining blocker. A local commit or pushed branch without a PR is not a completed pull request.
