# Evals

Fixed requests to run the kit's flows against, end to end, the way a person would: through the Proto website, with a coding agent doing the work. Each case keeps the inputs it was run with, so runs can be compared over time and across versions of the flow.

## Layout

`<flow>/<case>/` holds one case:

- `README.md`: the product and page, the account and state it needs, the form inputs, how to run it, and a log of runs.
- `prompt.md` and other `prompt-*.md` files: the description typed into the website, one file per wording. Each is a separate experiment.
- `reference.png`: the screenshot uploaded as the reference screen, when the flow asks for one.
- `build-prompt-run<N>.txt`: the prompt the website gave for run N, verbatim. It names a brief that only exists for that run.

## Running a case

1. **As the person:** in a normal browser signed in to Proto, choose the case's codebase, open **Create a new prototype**, and fill the form from the case's `README.md` and one of its prompts.
2. **As the agent:** open a coding agent in the codebase's source folder and paste the build prompt the website gives. Let it run, and answer its questions as the person would.
3. **Record the run:** add a row to the case's run log with the date, the proto and kit commits, the prompt file used, the brief ID, the wall time, and what came out. If the session was traced (`tools/trace.mjs`), link the trace.
