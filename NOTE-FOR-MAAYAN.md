# Maayan: fix for broken Mobbin reference images (MAA-229)

**What's wrong.** On a prototype made before Oct 6, a Mobbin screenshot
saved while the prototype's dev server is running comes back as the
app's HTML page, not the picture. Chrome blocks that (ERR_BLOCKED_BY_ORB),
and the references panel stays empty. Your `project-creation-flow` is
like this right now: its live address answers HTML for
`references/databricks.webp`, `front.webp` and `v0.webp`. Its published
snapshot is fine.

**Why.** Each prototype has its own copy of `vite.config.ts`, made when
the prototype was created. The kit's template was fixed on Oct 6
(commit c1fe52b) to serve `references/` straight from disk the way it
serves `previews/`, but copies made before that never got the fix. Only
React prototypes are affected; Vue prototypes serve new pictures fine.

**Fix: pick one.**

1. **Patch your existing prototypes.** This adds `references` to the
   folders each prototype's dev server reads from disk:

   ```sh
   for f in ~/.proto/*/prototypes/*/vite.config.ts; do
     sed -i '' 's#const PUBLISHED = /^\\/(?:previews|wireframes)\\//;#const PUBLISHED = /^\\/(?:previews|wireframes|references)\\//;#' "$f"
   done
   grep -L 'previews|wireframes|references' ~/.proto/*/prototypes/*/vite.config.ts
   ```

   The last line lists any React prototype it did not change (Vue ones
   show up there too, and need nothing). A running dev server restarts
   itself when its `vite.config.ts` changes, and the pictures load on
   the next refresh. If they don't, restart that prototype's server.

2. **Or start the prototype again.** A prototype made now gets the fixed
   config, as long as your installed Proto kit is from the evening of
   Oct 6 or later (Codex: `.codex-plugin/plugin.json` version
   `0.1.0+codex.20261007002610` or newer). Kit updates are switched off
   for now (MAA-225), so update it by hand first.

**Also new: Mobbin without the Mobbin MCP.** `tools/mobbin.mjs` finds and
saves Mobbin references with no Mobbin account: the agent searches with
its own web search restricted to mobbin.com, and `save` downloads the
screen into `public/references/`. `create-variant-set` and `add-variants`
use it now. Your Mobbin MCP still works if you prefer it, but nobody
else needs one.

Please delete this file once you've done the needful.
