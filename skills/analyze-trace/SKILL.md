---
name: analyze-trace
description: >-
  Read a debug trace of an agent session that used Proto and say where its
  time went, where it struggled, and what in the kit would make it faster
  or more reliable. Traces live in ~/.proto/traces/<session>/ (kept by the
  kit's end-of-turn hook for every Proto session on this laptop) or come
  from a debug report downloaded from /staff/debug-reports. Use when asked
  to analyze, debug or review a trace, a session, a run or a debug report,
  to find out why a Proto flow was slow or failed, or "what happened in
  that build". For the Proto team; it changes nothing.
---

# Analyze a trace

A trace is one agent session: the harness's own transcript (every
message, every tool call with its input, output and time) plus each
subagent's, worked up by `<kit>/tools/trace.mjs` into a report. Your job
is to turn that into a short list of findings a Proto developer can act
on: **what cost time or failed, why, and which kit file to change**.

All `<kit>/tools/…` paths resolve from the kit root: prefer the
installed host's `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` or
`CURSOR_PLUGIN_ROOT`, otherwise the root above this skill's `skills/`
directory.

## 1. Find the trace

```sh
node <kit>/tools/trace.mjs list                         # newest first
node <kit>/tools/trace.mjs list --slug <prototype>      # or --codebase <cb>
```

- No trace for the session you want: `trace.mjs import <session id |
  transcript path>` builds one from the harness's files (Claude Code
  keeps them in `~/.claude/projects/`, Codex in `~/.codex/sessions/`).
- A downloaded debug report: unpack it to a folder and
  `trace.mjs import <folder>`.
- "The last run" means `latest`.

## 2. Read the report

```sh
node <kit>/tools/trace.mjs report <session | latest>
```

It refreshes the trace from the live transcript first, then prints:

- **Span**: wall clock, working time and time waiting on the person.
  Judge speed on working time; waiting on the person is not the kit's.
- **Struggles**, worst first, each naming its steps (`steps 12, 13`):
  - `subagents-gave-up`: subagents (importers, part fixers…) that came
    back restored, skipped or out of budget; their last words are in
    the Subagents table's "Ended with" column
  - `agent-noted`: the agents said, in their own words, that something
    was wrong or that they worked around it. Kit bugs that exit cleanly
    but do the wrong thing (a file saved wrong, a step silently skipped)
    often show **only** here, under "What the agents noticed"
  - `error-streak`: failures in a row
  - `repeat`: the same call again and again (loops)
  - `errors`: a tool that keeps failing
  - `slow`: one step over a minute
  - `poll-cap`: a wait loop ran every round, so what it waited for
    never matched; often the check itself is wrong (a pattern looking
    at stdout when the tool prints to stderr)
  - `timeout`: a step hit the harness's time limit
  - `polling`: sleep loops
  - `slow-model`: long thinking before a step
  - `reread` / `churn`: one file read or edited many times
  - `rejected` / `interrupted`: the person, or the harness's permission
    check, said no (high when it blocked the rest of the session)
  - `compaction` and `context`: the context grew too large
  - `unfinished`: a call that never returned
- **Where the time went**: the main session's wall clock split, with
  nothing counted twice, into the model, each tool, the person and
  background work. `proto <script>` rows are the kit's own tools
  (`tools/<script>.mjs`), `proto mcp <tool>` the Proto server's MCP
  tools. A second table adds up every subagent's own work.
- **Phases**: the stretch from each person's message or skill start to
  the next, so you can see which part of the flow took the time.
- **Tools** and **Slowest steps**.

## 3. Open the evidence

Never report a struggle from its title alone. Open its steps:

```sh
node <kit>/tools/trace.mjs show <session> 12-14 20      # input, output, what the model said first
node <kit>/tools/trace.mjs show <session> 12 --full     # nothing cut
node <kit>/tools/trace.mjs grep <session> 'timed out|ECONNREFUSED'
node <kit>/tools/trace.mjs chat <session> --from 08:21 --to 08:55
```

`chat` prints the conversation in a window of time (UTC, as the report
shows it): what the agent was trying to do and what the person said
around a struggle. It is the quickest way to understand one. Subagents' steps carry their
agent id; their full transcripts are in `subagents/`.

Proto's tools leave their own evidence beside the trace, under
`~/.proto/<codebase>/run/`: `builds/<brief>/` (the page read, parts,
`tail.jsonl`), `explain/<unit>/` and `checks/` (the live and ours
pictures and their diff). When a check says two things differ, **open
the pictures**: they often show the real cause (a colour off across the
whole box) where the tool's own explanation guessed wrong.

For each struggle, decide which of these it is, because the fix differs:

| Cause | Looks like | Fix lands in |
|---|---|---|
| Kit tool bug | a `proto <script>` step fails or returns something wrong | `tools/<script>.mjs` |
| Tool misused | the agent called a kit tool wrongly (bad arguments, a placeholder taken literally) | the skill or brief that showed it how, or a clearer usage error |
| Unclear skill | the agent guesses, retries variants, reads the skill again, does steps out of order | `skills/<skill>/SKILL.md` |
| Agent's own script | Bash the agent wrote is wrong (a poll that can never match, a bad pattern, wrong quoting) | the skill or repo doc that should have given it the command, or a helper so it needn't write one |
| Missing tool | the agent hand-writes long Bash or polls with `sleep` for something the kit could do in one call | a new or extended tool |
| Environment | Chrome/CDP not up, port taken, dev server down, auth expired | the tool's own check or a clearer error |
| Server | `proto mcp …` errors or slow answers | the Proto app (`proto/web`) |
| Harness/model | API errors, long thinking, compaction, permission prompts | usually not the kit; note it |
| Expected | waiting on the person, a build that is simply long | nothing; say so |

## 4. Report

First decide what kind of session it was. A person **using** Proto (a
setup, an import, a build) is what this skill is mostly for. A session
**developing** Proto itself has most of its fixes outside the kit
(the app, deploy tooling, repo docs): say so in the headline.

Lead with one line: the session, what the flow was, working time, and
whether it reached its goal. Then the findings, **ranked by time lost or
by how badly they broke the flow**, each one standing alone:

- what happened, in a sentence, with the step numbers
- how much time it cost (from the report, not a guess)
- the cause from the table above, with the evidence quoted briefly
- the concrete change, naming the file

End with what went well, if anything is worth keeping as it is. Don't
pad: two real findings beat ten flags restated. If a flag turns out to
be harmless (a long build that was just working, screenshots after each
click), drop it, or say in one line why it isn't a problem.

To show someone the session, `trace.mjs view <session> --open` opens
`trace.html`: a timeline with a lane per agent, the struggles, every
step with its input and output, and the conversation. It is a single
file, so it can be shared as it is.

## Comparing runs

To tell whether a change made a flow faster or more reliable, run the
flow again and compare the two `summary.json` files. Compare
`activeMs`, `counts.errors`, the `proto …` rows in `groups`, and which
struggles disappeared. Say what changed and by how much.
