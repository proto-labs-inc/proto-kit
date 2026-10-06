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

## The rebuild copy against the freeze copy (2026-10-06)

Every run went through the website as a user would: the new-prototype form, Copy build prompt, paste into Claude Code (Opus 5.5, permissions bypassed after run 2's stops), `/clear` between runs, every multiple-choice question answered with its recommended option. Times are the agent's working time from its trace (`tools/trace.mjs`, stage split), without the person's answers. "Copy vs live" renders the prototype's Current option and the live page in Proto Chrome at the same viewport and diffs them with the kit's diff.

| Run | Kit | Brief | Prototype | Working | Copy | Build | Variants | Checks + publish | Tool calls | Subagents (gave up) | Copy vs live |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|
| A1 | rebuild (published kit 2bbfde1) | `1d18842c99` | [paused-project-notice-2](https://prototypes.fun/p/paused-project-notice-2) | 11m42s | 1m04s | 2m19s | 3m39s | 3m21s | 323 | 12 (4) | 0.06% (926 px) |
| A2 | rebuild (published kit 2bbfde1) | `fca5b20276` | [paused-project-notice-3](https://prototypes.fun/p/paused-project-notice-3) | 13m51s | 47.3s | 1m60s | 2m34s | 7m24s | 318 | 12 (5) | 0.06% (926 px) |
| A3 | rebuild (published kit 2bbfde1) | `a5a366438b` | [paused-project-resume-notice](https://prototypes.fun/p/paused-project-resume-notice) | 14m03s | 45.8s | 1m55s | 2m55s | 7m29s | 352 | 12 (4) | 0.06% (926 px) |
| B1 | freeze (kit cca9c8e) | `dc8091bf6f` | [paused-project-notice-4](https://prototypes.fun/p/paused-project-notice-4) | 13m32s | 11.4s | 1m15s | 3m47s | 6m13s | 209 | 3 (0) | 0.01% (97 px) |
| B2 | freeze (kit c88070e) | `51e71a7622` | [paused-project-resume-deadline](https://prototypes.fun/p/paused-project-resume-deadline) | 12m07s | 12.2s | 52.1s | 3m24s | 7m00s | 175 | 3 (0) | 0.01% (97 px) |
| B3 | freeze (kit c88070e) | `a7e0e02bdb` | [paused-project-at-a-glance](https://prototypes.fun/p/paused-project-at-a-glance) | 7m55s | 11.5s | 53.1s | 3m37s | 2m23s | 184 | 3 (0) | 0.01% (97 px) |
| B4 | freeze + Sonnet variant builders (kit cd41adc) | `6476483028` | [paused-project-status-card](https://prototypes.fun/p/paused-project-status-card) | 12m02s | 12.2s | 45.1s | 6m04s | 4m11s | 140 | 3 (0) | 0.01% (97 px) |

Averages over three runs each (B4 aside): rebuild 13m12s, freeze 11m11s. Copy 52 s and a gate question against 12 s and none; build 2m05s against 1m00s; 331 tool calls against 189; 12 subagents (4 to 5 gave up) against 3.

Findings:

- The freeze makes the copy cheap and exact (0.01% off, no gate, no fixers). The rebuild's copy failed its gate every run (1.94%, 2 of 11 parts), its 9 part-fixers matched nothing, and every run repaired a container the rebuild had collapsed to 80 px.
- Most of every run is now variants and checks: the main agent reviews the previews and rewrites the variant builders' work. Sonnet builders (B4) cost as much time as they saved.
- Interactivity is the same in both: the copied page is static (Download backups does nothing); the agent's Resume flow works in every run.
- Every run spent 40 s to 2 min on the gallery slug check and asked the person, because no tool lists a codebase's prototypes.

Kit fixes made between runs: relative frozen asset paths and file types from bytes (after B1's refused publishes, `c88070e`); frozen-aware variant builders on Sonnet (`cd41adc`).

Runs' recordings (terminal every 15 s, website screenshots, judge renders) and the canvas: `~/Proto/experiments/supabase-runs/` on the Mac mini; canvas at https://claude.ai/artifact/HMWzFCWy8GEuSCDzLT6Yvd.
