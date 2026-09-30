# The build's read, curation and copy

What a prototype build keeps on the laptop and what each tool reads and
writes, from the one read of the reference page to the composed copy in
the workspace. The tools are `tools/build-stream.mjs` (`read`, `curate`,
`name`), `tools/scaffold.mjs` and `tools/replicate.mjs`; the agent runs
them in that order and reviews between them, it never reads the live
page itself. The events these tools send are the site's build events
contract (`web/src/lib/build-events.ts` in the proto repo).

## The build folder

`~/.proto/<codebase>/run/builds/<briefId>/`

```
tree.json        the boxes the site shows (below), plus `curation` once named
read.json        every element of the page with its computed style, the
                 page's tokens, fonts and images (below)
assets/          the page's font files and images, as the page served them
curation.json    the curation `curate` drafted and the agent reviewed
workspace.json   { slug, path, port, framework, tailwind, title } from scaffold
checks/<slug>/   every check of a part: <n>-live.png, <n>.png, <n>-diff.png
checks/page.png, page-diff.png   the whole composed page against the frame
dev.log          the workspace dev server's output while replicate ran
events.jsonl, captures/          only with --no-send: what would have gone to the site
```

## One read

`build-stream.mjs read` attaches to the reference tab in the Proto
window and, under the window's lock (`tools/cdp/live.mjs`), takes the
run's resting frame and runs one page-side read (`tools/read-page.mjs`).
Nothing reads the live page again until the checks, which cut resting
states from the frame.

`tree.json`: `{ viewport: { width, height, dpr }, url, nodes: [...] }`.
Each node: `id` (n1, n2, … parent before child), `parent`, `depth`,
`raw` (tag.class chain), `rect` (clipped to the viewport, rounded),
`selector`, `element` (its index in read.json), `tag`, `aria`, `role`,
`heading` (the first heading inside it), `classes` (the ones that read
as names, utilities left out), `ownText`, `text` (its first line),
`interactive`, `backdrop` (its painted ancestors composited), `room`
(its parent's content width), and for a box that folds its children,
`collapsed: "repeats"` with `count`. Boxes are chosen largest first
within a budget of 160, and siblings of one kind and one size, four or
more, are one box: a list, a grid of cards or a strip of glyphs is read
whole as one part rather than spending the budget on each copy.

`read.json`: `{ props, pool, elements, page, images, faces, assets }`.
`props` is the computed style's property list (custom properties left
out), `pool` the distinct values; an element's `style` is an array of
pool indices in `props` order, as are its `pseudo["::before"]`,
`["::after"]` (only where they paint) and `["::placeholder"]` (fields).
Each element: `i`, `tag`, `svg`, `parent`, `attrs`, `children`
(`{ node }` or `{ text }`), `value`, `rect` (full precision).
`page`: `url`, `title`, `lang`, `icon`, `htmlAttrs`, `tokens: { root, body }`
(every custom property as computed on `:root` and `body`), `html` and
`body` (their own face and colours), `rootFontSize`. `faces`: the
page's @font-face rules with `files` (url → path in assets/). `assets`:
image url → path. Files come from the page's own cache
(`Page.getResourceContent`), so an image behind the user's sign-in is
theirs; the network is the fallback.

`tools/read-page.mjs` `instanceFromRead(read, element, { backdrop, room })`
is the instance the snapshot writer takes, cut from the read.

## The curation

`build-stream.mjs curate` drafts `curation.json` from the tree alone
(`tools/curate.mjs`): `[{ id, name, role, marker? }]` in tree order.

Roles: the root, any box over a tenth of the viewport, and a box that
spans the page (nine tenths of its width or height) holding two or more
parts is a `section`; an interactive control, a folded list, a box with
nothing under it, or any other box up to a tenth of the viewport is a
`leaf`; the same box as its parent, its parent's only box, or anything
inside a leaf is `packaging`. A chain of wrappers gives its role to the
outermost box.

Names, in order of trust: the aria label; a landmark with its heading
("Usage page", "Usage header"); a control with its words ("Feedback
button"); a heading the box owns (the outermost box holding no other
part with it); a class that reads as a name; the box's own words; its
role; what kind of element it is; last, "Group", "Block" or "Wrapper".
A box holding only a chain of wrappers borrows the best name along it.
Markers are the names in kebab case, unique, shared only by repeated
siblings (same parent, same label, same size), as list rows share a
`data-proto-id`.

Against the three hand curations of 2026-09-30, roles agree on 43 of
49, 50 of 54 and 132 of 140 nodes; the rest are chain outer-versus-inner
choices. The agent reviews the draft (names first), then `name` sends it.

## The workspace

`tools/scaffold.mjs <slug> --codebase <id> --brief <briefId>` writes
`~/.proto/<codebase>/prototypes/<slug>/` from the template and the read:
`src/tokens.css` (the page's custom properties), `src/fonts.css` with
`src/fonts/`, `src/styles.css` (the body's own base, Tailwind's import
when the source uses it), a free port in both files, the rig's paths.
Install comes from pnpm's shared store with the template's lockfile.

Parts live in `src/parts/<slug>/`, in the library's component shape
(`<Slug>.tsx`, `<Slug>.module.css`, `component.json`, fonts and images
beside them, `notes.md`); the root carries `data-proto-id="<marker>"`
and takes a `className` for its place in the page. The dev-only render
route `#/render/<slug>/<state>?x=&y=&w=` (`src/render.tsx`) mounts one
part alone the way the library's route does, so the same check runs
against a workspace; a production build carries none of it.

`src/App.tsx` is the composed page: the page's own boxes from `<body>`
down to each part, each with the computed style the read captured (what
differs from the workspace's base, in `src/App.module.css`), the parts
as their components, sections carrying their markers, tree boxes
carrying `data-node="<id>"` so the page can be fitted against the read.
Images outside every part sit in `src/page/`. `prototype.json` lists
the one `default` state; the change built on top adds its own.

## The copy

`tools/replicate.mjs <briefId> --codebase <id> [--lanes 12] [--no-send] [--keep-dev]`

For each leaf, heaviest first, twelve at a time: a library component
whose `shape` fingerprint (component.json) matches is adopted and
checked; otherwise the part is written from the read by the snapshot
writer (fitted against the workspace's render route) and checked. Each
pass sends `pass { id, pass, mismatch }`; a part that matches sends
`matched { id, image, rect }` with its replica crop. Then the page is
composed, fitted (up to three rounds) and diffed whole against the
frame, and the new parts that matched are copied into the library
(`library.mjs inventory` and `status done`, states without this page's
selectors, `unverified` saying they were checked in the build).

Prints `{ seconds, matched, toFix: [{ id, slug, states }], failed,
reused, page: { verdict, mismatch, pct, clusters }, learned, fitted,
timings }`. The verdicts are `tools/verify-replica.mjs`'s; `toFix` is
what the agent's own passes take on next.
