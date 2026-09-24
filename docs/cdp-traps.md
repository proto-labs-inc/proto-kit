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
- Screenshots come back at device pixel ratio, usually 2x the CSS pixels you asked about. The headless Chrome has a ratio of 1 until you emulate the live tab's: `headlessPage()` does, from the viewport and ratio you pass it, and `verify-replica.mjs` reads both from the live tab first.
- Never pass `clip` to `Page.captureScreenshot` on a tab that is not the active one. Chrome resizes that tab's view to the clip while it waits for a new frame; on a background tab the frame sometimes never comes, and the resize outlives a capture that dies (the tab then reports the clip as its viewport until it is closed). `stableShot()` captures the whole viewport and cuts the clip in node instead.
- The macOS system font is not the same face in the two Chromes: `system-ui` at weight 600 resolved to the variable `.SF NS` instance in the visible window and to the static `.SFNS-Bold` in headless (`CSS.getPlatformFontsForNode` shows it). Identical pages then differ by a few hundred pixels inside the glyphs, maxDelta near 185. A webfont declared beside the replica renders identically in both (zero). So: geometry agrees by rects, a residue confined to glyph clusters of system-font text is the browsers disagreeing, not the replica, and chasing it is the waste the 22 run paid 40 s for.
- svg className is an object, not a string.
- The live viewport can change under you mid-task (the person resizes, a
  sibling agent emulates). A wildly wrong clip usually means the tab
  changed state, not that your replica is bad. Capture, then re-read the
  rect and innerWidth, and retry until two consecutive reads agree.
- Render the replica at the element's absolute page coordinates, not just
  the same fractional phase. Two independent discoveries forced this:
  dashed borders (dash phase accumulates from absolute position) and
  gradients (Skia's dithering is device-position-keyed). Absolute-position
  placement subsumes phase matching: make it the default.
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
