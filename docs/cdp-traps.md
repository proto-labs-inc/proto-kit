# CDP traps: reading and pixel-verifying live pages

Hard-won facts for any work that reads a rendered page over CDP or
verifies a replica against it pixel by pixel. Both the
import-design-system and create-prototype skills point here: read this
before your first read of a live page, and again before your first
pixel diff. Every entry came from looking at real output; when a new
verified surprise recurs, it belongs in this list.

Two Chromes are involved. The visible Proto window (port 9333) holds
the product page the user signed into: it is read and captured, never
navigated, never raised. The headless Chrome (`tools/cdp/headless.mjs`,
port 9444) renders every replica; nothing it draws appears on screen.
The diff runs in node (`tools/cdp/diff.mjs`), so no third page exists.

Traps we hit, so you don't:

- display:contents wrappers report a 0x0 rect but their children render. Zero size does not mean empty. Descend anyway.
- Page bounds come from the html element's own rect. Off-screen carousels can extend thousands of pixels past the viewport, so never size anything from the max over all descendants.
- /json/new requires PUT on current Chrome, and it raises the window: never use it on the visible Chrome.
- Screenshots come back at device pixel ratio, usually 2x the CSS pixels you asked about.
- An emulated device scale factor is not a real one. `Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 2 })` on a 1x Chrome lays out in CSS pixels and snaps every fractional edge: a 1px border at left 496.328125px paints at device x 992 where the Retina window paints 993, a box at top 884.4140625 at row 1768 instead of 1769. Every component on a half pixel came out one device pixel off, which units then spent minutes proving. The headless Chrome is launched with `--force-device-scale-factor=<the window's>` (tools/cdp/headless.mjs); the same override on top of it changes nothing.
- The colour profile differs too. The Proto window on a Retina Mac draws in Display P3; headless defaults to sRGB, so `oklch(0.43627 0.11 157.5)` came out 0,99,56 against the window's ~38,98,62. `--force-color-profile=display-p3-d65` (read from `matchMedia('(color-gamut: p3)')`) fixes it; greys never showed it.
- Never pass `clip` to `Page.captureScreenshot` on a tab that is not the active one. Chrome resizes that tab's view to the clip while it waits for a new frame; on a background tab the frame sometimes never comes, and the resize outlives a capture that dies (the tab then reports the clip as its viewport until it is closed). `stableShot()` captures the whole viewport and cuts the clip in node instead.
- The macOS system font is not the same face in the two Chromes: `system-ui` at weight 600 resolved to the variable `.SF NS` instance in the visible window and to the static `.SFNS-Bold` in headless (`CSS.getPlatformFontsForNode` shows it). Once the headless Chrome runs at the window's real scale factor and colour profile (below), this is the one renderer difference left for text: a webfont declared beside the replica renders identically (zero), and system-font glyphs still differ by a few pixels (the Supabase search pill's ⌘ key: 21 to 24 pixels, all inside the glyph). A residue confined to glyph clusters of system-font text is the browsers disagreeing, not the replica; a residue anywhere else is not this trap.
- The library app's base styles (Tailwind's preflight, the shadcn theme, its Geist font) sit under every imported component, and the product's base differs: `box-sizing`, `button { font: inherit }`, `line-height`, borders zeroed. A component module that leaves any of these to inheritance renders a pixel or two off in the library and clean nowhere else. Set them in the module; the first pass's clusters (a thin strip along an edge, text a hair taller) say which one was left out.
- svg className is an object, not a string.
- The live viewport can change under you mid-task (the person resizes, a
  sibling agent emulates). A wildly wrong clip usually means the tab
  changed state, not that your replica is bad. Capture, then re-read the
  rect and innerWidth, and retry until two consecutive reads agree.
- Render the replica at the element's absolute page coordinates, not just
  the same fractional phase: dash phase accumulates from absolute position
  and Skia's gradient dithering is keyed to device position. This only
  holds with a real device scale factor on both sides: under an emulated
  one (above), the replica's fractional coordinates snapped to whole CSS
  pixels and every half-pixel edge landed one device pixel off regardless.
  Read the rect from the live element by selector at full precision
  (`getBoundingClientRect()`); a rect typed with two decimals moves every
  edge a fraction of a pixel.
- Verify only after `document.fonts.status === "loaded"`: rect probes
  taken while a woff2 is still loading report plausible-looking
  fallback-font metrics that are all slightly wrong.
- Serialized computed values round: a used line box of 31.9921875px
  serializes as "31.9999px" and tempts you to hardcode 32. Copy the
  authored value (here the unitless line-height var 1.33333), not the
  serialization.
- Computed style is not rendered truth. An element can report a fully
  opaque 1px border in computed style and still rasterize nothing (state
  the style system doesn't surface). When a read and the pixels disagree,
  the pixels win: sample colors from the capture before painting
  something the real page might not paint.
- Anything that waits on a rendering-side promise (`img.decode()`,
  `requestAnimationFrame`) can stall forever in a background or occluded
  tab. Read data, never wait on paint, in the visible window; render in
  the headless Chrome, where every tab paints.
- `document.fonts.check()` returns true for families that are not
  installed at all. It answers "would this render something", not "is
  this face available". Trust `document.fonts.status` and rendered
  pixels only.
- Clip to the element's own paint, not its line box. A text element's
  line box can overlap a neighbor's border; the diff then reports the
  neighbor. A thin full-width strip at a clip edge in the cluster output
  means the clip includes a neighbor: shrink the clip, don't chase the
  replica.
- Ancestor compositing is a paint mechanism. A sticky scroller inside a
  `contain: paint` column gets its own composited layer; the layer's
  fractional device origin snaps, SVG mask boxes snap with it, and text
  glyphs absorb the shift instead. Result: icons one device pixel off
  with identical rects and identical styles. If a 1-device-px shift
  survives every per-element fix, reproduce the ancestor stack (sticky +
  overflow + contain + real scroll height), not more styles. Sticky only
  promotes when it has room to move.
- Whitespace text nodes are real. React's `{" "}` emits a separate text
  node; merging it with adjacent text changes glyph shaping by fractions
  of a pixel. Reproduce text node splits (an HTML comment between text
  runs does it).
- Fetching a font from Google Fonts with a bare `curl` returns an HTML
  page, not a font: `fonts.googleapis.com/css2` needs a browser
  User-Agent to name woff2 files, and a guessed `fonts.gstatic.com`
  path answers with an error page. Saved as `.woff2`, the file is
  ignored and the text renders in the fallback face. Take the woff2
  URLs from the css2 response fetched with a Chrome User-Agent, and
  check each saved file with `file` before declaring it.
- A CSS transition in the Proto window never advances: the window sits behind others, nothing paints, and a transition is driven by frames. Holding `:hover` with `CSS.forcePseudoState` and waiting reads the transition's first frame (the resting colour, serialised as `oklab(…)`), and the next state's capture can catch the last one fading out. Finish them instead: `el.getAnimations({ subtree: true })`, each `CSSTransition` `.finish()`, after holding the pseudo-class and again after letting it go (`withForcedState` in tools/verify-replica.mjs).
- An inline-level component placed alone sits in a line box of the parent's line height. In the render route that was the app's 24px, so an inline link's text and underline landed 3.5px low and out of the clip. The route puts the component in a grid cell (no line box, full width), and snapshot.mjs turns an inline root into an inline-block at `line-height: normal`, whose box is the text box the live rect reports.
- `getComputedStyle` enumerates every custom property (`--tw-*`) along with the real ones: hundreds per element. Skip names starting with `--` when copying styles.
- A photo scaled by the browser (a 48px avatar drawn at 30px) is resampled differently by the window's GPU and headless's software rasteriser: a residue of a few hundred pixels confined to the photo is that, not the component.
- A stylesheet's `sourceURL` can carry the product's sign-in tokens (a redirect URL with an access token). Read sheets through the CSS domain, never print or save their headers.
- `document.fonts.check()` is not the only liar: `canvas.fillStyle` normalises what it accepts (`rgb(1, 2, 3)` reads back as `#010203`), so "did it take my colour" means comparing against the normalised read-back, and it cannot resolve relative colours (`oklch(from …)`) or bare `153deg 60% 52%` triples. Resolve colours on a probe element's computed style (in the headless Chrome, never the user's page).
- A Vite dev server reloads every open page, not just the one that changed, when a file it does not know as a module appears or changes under the root: a part's `notes.md`, a font file, a picture, `public/prototype.json`. Twelve lanes writing parts while other lanes capture render tabs saw "Inspected target navigated or closed" on every capture. The workspace template's watcher ignores non-module files, the render route accepts its own HMR update (its globs change with every new part), and the build's readers of the composed page retry a read a reload caught (`tools/replicate.mjs`).
- A module that fails to transform blocks everything imported beside it: a checked part's render tab stayed empty while `App.tsx` named a part that was not there yet, because `main.tsx` imported `App` statically. The template imports the app on its own branch, and a wait for the render route ends after 15 s with a plain failure, never a hang.
- `Page.getResourceContent` answers with the page's own cached copy of a file (an avatar behind the user's sign-in, a font); fetching the same address from node answers 401 or a sign-in page. Ask the page first, the network second.
- `getComputedStyle` on `:root` and `body` lists every custom property the page defines, with its specified value (a `var()` chain stays a chain): the page's tokens in one read, no stylesheet parsing.
