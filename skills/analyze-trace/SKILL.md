---
name: analyze-trace
description: >-
  Read a debug trace of an agent session that used Proto, flag in it what
  went wrong, what was slow and what the kit's skills or tools could do
  better, and report back. Traces live in ~/.proto/traces/<session>/ (kept
  by the kit's end-of-turn hook for every Proto session on this laptop) or
  come from a debug report downloaded from /staff/debug-reports. Use when
  asked to analyze, debug or review a trace, a session, a run or a debug
  report, to find out why a Proto flow was slow or failed, "what happened
  in that build", or to flag particular steps. For the Proto team.
---

# Analyze a trace

A trace is one agent session as the harness recorded it: every message,
every tool call with its input, output and time, and each subagent's own
transcript. Your job is to read it like a reviewer, **flag** what matters
in it, and tell the person what to change. The flags are what they will
look at: they show inline in the trace page and in a list at its top.

All `<kit>/tools/…` paths resolve from the kit root: prefer the
installed host's `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` or
`CURSOR_PLUGIN_ROOT`, otherwise the root above this skill's `skills/`
directory.

## Find it

```sh
node <kit>/tools/trace.mjs list                         # newest first; --slug <s> or --codebase <cb> to narrow
node <kit>/tools/trace.mjs import <session id | transcript path | unpacked debug report folder>
```

`latest` names the newest trace anywhere a session is asked for.

## Read it

1. `node <kit>/tools/trace.mjs report <session>`: the overview. It
   refreshes the trace from the live transcript, then prints the time
   (working, waiting on the person), the phases (one per person's
   message or skill started) with their working time, the tools by time,
   the slowest steps, the subagents and how each ended, and **signals**:
   things a rule noticed (failures, repeats, polls that never matched,
   subagents that gave up, sentences where an agent said something went
   wrong). Signals are a place to start, not findings; check each.
2. `transcript.md` in the trace folder: the whole session in order,
   nothing cut, in turns. Every step is `s12` (the twelfth tool call,
   counted by time across subagents) and every message `m3`. Read the
   phases that took the time or failed; read subagents where they gave
   up. `node <kit>/tools/trace.mjs show <session> s12 s40-44` prints
   steps with what the model said just before; `grep <session> '<regex>'`
   finds steps by their input or output.
3. Proto's tools leave evidence beside the trace, under
   `~/.proto/<codebase>/run/` (`builds/<brief>/`, `explain/<unit>/`,
   `checks/`). When a check says two pictures differ, open them.

## Flag it

Flag each thing worth the person's attention, on the step or message
that shows it, with one sentence that says what happened and, when you
know, what to change and in which file:

```sh
node <kit>/tools/trace.mjs flag <session> s103 --kind improve --by claude \
  --note "reloaded the product tab mid-import; every positional selector broke after. skills/import-design-system should forbid it"
```

Kinds: `error` (something failed or did the wrong thing), `slow` (time
lost; say how much), `improve` (a skill or tool could have made this
easier or avoided it), `note` (context worth keeping), `good` (worked
well; keep it). `session` in place of a step flags the run as a whole:
give it the one-line verdict. When the person asks you to flag specific
things, flag those. `flags <session>` lists them and `unflag <session>
f3` removes one. Flags survive every refresh of the trace.

Decide the cause before you flag, because the fix lands in different
places:

- a kit tool's bug: `tools/<script>.mjs`
- an unclear skill (the agent guessed, retried variants, went out of
  order): `skills/<name>/SKILL.md`
- a missing tool (the agent hand-wrote what the kit could do in one call)
- a tool misused: the skill or brief that showed it how
- the environment (Chrome, ports, sign-in): the tool's own check
- the server: `proto/web`
- the agent's own script (a wait loop that could never match)
- the harness (API errors, compaction, permission prompts): usually not ours

Waiting on the person, and a build that is simply long, are not problems.

## Report back

One line on the run: the flow, working time, whether it reached its
goal. Then the flags that matter most, ranked by time lost or by how
badly they broke the flow, each standing alone: what happened (with its
`s` id), the time it cost, the cause, the change and its file. End with
what went well. Point the person at the page:
`node <kit>/tools/trace.mjs view <session> --open`.

A session developing Proto itself, rather than using it, has most fixes
outside the kit; say so in the first line.

## Comparing runs

Run the flow again and compare the two `summary.json` files (`activeMs`,
`counts.errors`, the `proto …` rows in `groups`) and their flags. Say
what changed and by how much.
