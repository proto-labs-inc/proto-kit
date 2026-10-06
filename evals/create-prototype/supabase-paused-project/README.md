# Supabase: paused project notice

Ask for variants of the "Project is paused" notice in the Supabase dashboard that display its critical information in different ways.

The original ask: create a prototype of a Supabase page, such as a project's dashboard home, and ask for variants where it says the project is paused, displaying the critical information in different ways.

## Product and page

- **Page:** https://supabase.com/dashboard/project/swghcmbhiyldanrdqxlu
- **Product:** the Supabase dashboard (Studio)
- **Source:** https://github.com/supabase/supabase, `apps/studio`. Run 1 used a shallow clone at `~/code/supabase`.
- **Proto codebase:** `supabase` in the team Proojto (codebase ID `iizza72u`)

> **Note:** Ooj was signed in to Supabase with his personal GitHub account, and this project was paused. The page shows the dashboard's paused-project state, not a running project.

What the page showed on 2026-10-06 (see `reference.png`):

- Top bar: org **Throwaway** (Free plan), project **Prooject**, branch **main** (Production), Connect, Feedback, search, icons, avatar. Left icon sidebar.
- A centered card, **Project "Prooject" is paused**, with four bullets:
  - All data, including backups and storage objects, remains safe.
  - You can resume this project from the dashboard until 09 Nov 2027.
  - After that, this project will not be resumable, but data will still be available for download.
  - To prevent future pauses, consider upgrading to Pro.
- Buttons **Resume project** and **Upgrade to Pro** (primary). An **Export your data** row with a **Download backups** menu.
- An "Explorer & Notebooks" preview popup in the bottom right, closed before the screenshot was taken.

## Form inputs

| Field | Value |
|---|---|
| Description | one of the prompt files below |
| Screen URL | `https://supabase.com/dashboard/project/swghcmbhiyldanrdqxlu` |
| Full-page screenshot | `reference.png` (1200×1189, taken from a signed-in browser at 1× with the promo popup closed). Only the screenshot-based flow asks for it (run 1). |
| Hook up real data | off |

## Prompts

- [prompt.md](prompt.md): detailed. It describes what's wrong with the current notice and names three specific variants.
- [prompt-short.md](prompt-short.md): the same request with no specifics, leaving the variants to the agent.

## Runs

| # | Date (UTC) | Flow | proto / kit | Prompt | Brief | Wall time | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-06 01:29 | screenshot-based create-prototype | `df81706` / `d114c4c` (+ a local trace-tools commit) | prompt.md | `8b33393d34` | 3m32s, stopped | Blocked before building. Abandoned when the screenshot flow was taken off `main`. |

| 2 | 2026-10-06 01:38 | live-page create-prototype (the person stays signed in, the agent opens the page) | `84dfb37` / `2bbfde1` (+ the local trace-tools commit) | prompt.md | `23b121e7f2` | 41m wall: about 19m of agent work plus 22m waiting on permissions | Done. Live, published, with 3 variants and a Resuming state. https://prototypes.fun/p/paused-project-notice |

Run 2 notes (UTC):

- **01:38:35** Build prompt pasted (`build-prompt-run2.txt`). Agent: Claude Code, Opus 5.5, auto mode, after `/clear`.
- **01:39:25** Stop 1: the Proto plugin wasn't installed, and the agent asked before installing third-party code. The person said yes.
- **01:40** Stop 2: auto mode blocked `claude plugin install`. The person ran it with `!` (marketplace `proto-labs-inc/proto-kit`, plugin at `2bbfde1`).
- **01:41** Stop 3: the plugin's tools only load after a restart. The person ran `/exit`, then `claude --continue`.
- **01:45:57** Stop 4: auto mode blocked `report-workflow.mjs` (progress reports to prototypes.fun) as data exfiltration, and reading under `~/.proto/` as credential exploration. Claude Code also refused to let another session add allow rules (self-modification). The person restarted with `claude --continue --dangerously-skip-permissions` at **02:07:54**. That cost about 22 minutes.
- **02:08** Linked codebase `iizza72u` to `~/code/supabase` with the setup skill, and kept the existing library.
- **02:10** Stop 5: there's no read-only way to list the gallery, so the agent asked whether the slug `paused-project-notice` was free. The person said yes.
- **02:10 to 02:12** Claimed the build. Reused the signed-in Supabase tab in Proto Chrome, read the page, stopped to review part names, then scaffolded, replicated and checked.
- **02:12** Stop 6: the copy gate failed, 1.94% off against the 0.5% limit, with 2 of 11 parts matched. The person chose "start building".
  - Cause, found later by the agent: a copied flex container had collapsed and clipped the whole notice card. After it fixed the width, the unchanged page was 0.38% off.
- **02:12 to 02:16** 9 part-fixers ran for 2.5 to 3.5 minutes each, and none matched. Most found no style value to change (antialiasing, colour profile). The Supabase logo had a bad image reference it couldn't fix.
- **02:13 onwards** Wrote the redesign, ran 3 variant builders in parallel, and added a "Resuming" state that reuses Studio's `RestoringState.tsx` copy.
- After the first render, the agent fixed a missing status line and the "Resume by" wording in Deadline first, an unlabelled badge icon, and a wrong Data-row icon.
- The dev server kept restarting for a while: a fixer's check had started a server on the same port.
- **02:19** Checks passed. Edge verified, snapshot published, brief marked done.
  - Live: https://paused-project-notice.totypes.pro
  - Snapshot: https://builds.totypes.pro/iizza72u/paused-project-notice/20261006T021915Z-870a/
- **Known gaps** the agent reported:
  - Dark theme only: Proto Chrome rendered the page dark, while the reference the person saw was light.
  - No pause date on the page, so the timeline's first point just says "Paused".
  - "Today" sits at the timeline's midpoint.

Run 1 notes:

- Website: prototypes.fun, signed in as ooj@prototypes.fun. The form requires the screenshot: **Copy build prompt** stays disabled without it, so the person has to take and upload it.
- Agent: Claude Code (Opus 5.5, auto mode) started in `~/code/supabase`, with the website's build prompt pasted in (`build-prompt-run1.txt`).
- The Proto plugin wasn't installed in that Claude Code. The agent ran the kit straight from the `~/Proto/proto-kit` checkout.
- The agent checked the kit version and tools, read the skill, and ran `proto-build.mjs prepare`, which stopped with "Run setup to restore this existing codebase source record". The codebase existed on the server, but this laptop had no `~/.proto/iizza72u/codebase.json`.
- Restoring the record means calling `set_codebase_source` with the folder path and git remote. Claude Code's permission check blocked that as possible data exfiltration, so the agent stopped and asked the person to confirm.
- At 01:13 UTC (deployed about 01:30) Maayan force-pushed `main`. proto `84dfb37` and kit `2bbfde1` keep the JSON brief inputs but drop the screenshot flow, so the run was left there.
