---
name: application-prototype
description: Create and iterate on a route in the customer's connected React application, select alternates, and prepare selected implementations for a PR. Copied standalone prototypes keep their existing skills.
---

# Application prototype

The connected customer repository supplies the page. Proto creates one branch
and worktree for each prototype from that repository's local `main`. This
permission applies only to customer prototype worktrees. Keep the Kit and
cloud repositories on their already checked-out branches.

New work begins with a route and request. Run
`node tools/application-workspace.mjs --codebase <id> --slug <id> --route /path --title <title> --request <request> [--app-root <relative-package-path>]`.
The command records the branch, base commit, route, request, worktree and
alternate storage in Proto's local folder, and registers the same prototype
in the cloud. A retry with the same identity reuses the worktree. Do not write
alternate implementations into the customer checkout.

Run `node tools/application-preview.mjs <codebase> <slug>` to start the
customer's own dev script and get the local application and Frame URLs. It
generates the small `public/prototype.json` bridge contract in the prototype
worktree. The first integration is Next.js App Router. In the worktree, connect
the route to `ProtoRig` in a client provider, passing that manifest. Keep the
existing app layout, data access, CSS and React instance. The provider and
manifest are recorded preview wiring, not product implementation. Confirm
the route loads at the returned application URL and the Frame URL.
The Frame remembers that local application origin for this prototype in the
maker's browser, so later gallery visits can reopen the same route. A new
preview port updates it when the maker follows the new Frame URL.

For each targeted client-renderable component instance, choose a stable call
site key such as `app/billing/page.tsx#BillingPage:SummaryCard`. The key names
the particular render call, not a title, DOM selector or line number. Call
`node tools/application-alternates.mjs begin --codebase <id> --slug <id>
--targetKey <key> --title <title>`. Repeated requests for the same key return
the same set. Independently targeted calls get separate sets. Do not target
arbitrary Server Components in this first integration.

Write each alternate React module, styles and assets in a staging folder
inside the prototype record's `alternateStorage`. Import the customer app's
real components and tokens where appropriate. Call
`node tools/application-alternates.mjs save --codebase <id> --slug <id>
--setId <uuid> --title <title> --staging <absolute-path>`.
This stores an immutable, content-addressed bundle outside the checkout and
registers its source revision. Expose the saved modules to the customer's
bundler through a recorded alias in its Next config and a matching TypeScript
`paths` entry, then statically import them at the targeted call site. Next 16
uses Turbopack by default: use `turbopack.resolveAlias` and set
`turbopack.root` to the common parent of the worktree and alternate storage.
For a project explicitly using webpack, use its `webpack` alias instead.
Do not add a webpack-only config to a Turbopack project. The Kit links the
alternate storage to the app's installed dependencies so external JSX uses
the app's React instance; do not add TypeScript aliases from `react/jsx-runtime`
to declaration files. Wrap that call with
`ProtoAlternateBoundary`, passing its original render as `baseline`, the
saved modules as `versions`, and the component's normal props. Mark the visible
root of the baseline and each alternate with `data-proto-id` equal to the set
ID so the Frame can identify the same region. Do not portal replacements.
Check the real Next build after wiring. Vite may use the same React boundary
with a Vite alias; do not assume Next config works there.

Call `node tools/application-alternates.mjs finish --codebase <id> --slug <id>
--setId <uuid>` to refresh the app's manifest from registered versions. The
Frame owns cards and the shared selection. Read `get_prototype_context`
before any agent action that depends on the selected versions. Use
`select_alternate` for agent-driven choices with the current selection
revision. A revision conflict means read the context again and reconcile the
person's current choice before continuing.

## PR preparation from any agent conversation

Use this workflow when the person asks to implement or open a PR, even if the
request arrives directly in chat rather than through a Proto PR plan. First
stop concurrent edits to the selected bundles. Stage any new preview wiring
files so their diff can be recorded, then run
`node tools/application-pr.mjs prepare_selected_for_pr <codebase> <slug>
<wiring-path>...`. The result pins the shared selection, source revisions and
exact local bundle paths. Apply only those selected implementations to ordinary
product code. Remove provider, boundary, alias, manifest and marker wiring
from the submitted changes. Preserve the original component behavior where
no alternate was selected.

Run `node tools/application-pr.mjs verify_pr_ready <codebase> <slug>` after
the ordinary app builds. It checks for preview wiring and re-reads the shared
selection before and after the build. Run it again immediately before push.
If selection or source changed, reconcile and repeat preparation. Commit and
push only after the person requests them. After PR preparation is settled, run
`node tools/application-pr.mjs resume_prototype <codebase> <slug>` to reapply
the recorded preview boundary against current product code. Resolve any patch
conflict against the current app; never replace current product code with an
old snapshot. Old alternate IDs, source revisions and originals remain saved.

Existing copied prototypes and published artifacts keep their earlier
workflow. Application prototypes have no states, state map, comments, indexed
screens, replicated starter, prepared sample or staff onboarding step.
