# Executable verification plan

Save a JSON object with `inventory`, `responsiveCss` (the responsive-css.mjs
report), `height` (default 900) and `scenarios`.
`inventory` contains `sourceUrl`, ISO `capturedAt`, `controls` (each has `id`,
`expected`, and `state`: enabled or disabled), `states` (nonempty unique IDs),
and numeric `breakpoints` (preserve fractional CSS values). Derive these from
the live product, before copying. Include every extracted breakpoint; add observed
JavaScript-driven transitions. For each warning or unresolved condition in the CSS
report, record the inspected behavior and coverage in `responsiveCssReview`, keyed
by its exact message. Unreviewed findings block verification.

Each discovered container condition needs responsive scenarios with `containerQuery`
set to that exact condition. Include `resize-container` steps targeting its real
container just below, at and above the threshold, asserting the source's expected
layout after each resize. Reference PNGs must depict the final constrained layout.
Use separate scenarios for distinct states; a viewport breakpoint is not a substitute.

Each scenario has a unique filename-safe `id`, `category`, `target`, local
`path` including URL state, `steps` and a final `assertion` JavaScript expression.
Expressions run with the prototype's window, document and location in scope and
must assert a visible expected outcome, not just that the page loaded.
Use `interaction` and `keyboard` scenarios for every control; use `visual`,
`responsive`, `state` and `isolation` for every state. The runner executes all
scenarios at widthsFor(inventory): 320px and 1440px endpoints, each extracted
CSS breakpoint and adjacent integer widths, and one midpoint in each interval.
Fractional CSS boundaries use their floor/ceiling and adjacent integer widths. Responsive scenarios load at an opposite width, resize
without reloading, run the actions and assertion, then resize away and back and
assert again. Write width-dependent assertions for observed layout behavior
(e.g. sidebar replaced by a menu, columns stack, text wraps, table scrolls).
An assertion that only checks page existence does not verify responsiveness.
Use the actual source behavior, including container-query transitions. Test
short viewports separately when the source has height-dependent overlays. Each visual and responsive scenario's `references` maps each
width to its captured local reference PNG. The fixed visual gate is at most 1%
mismatched pixels using the kit's existing color threshold; do not loosen it to
pass. Preserve original source screenshots, including their defects. Record small
intentional responsive repairs and visually review their before/after screenshots;
never substitute a screenshot of the copy as the source reference. If an intentional
repair still fails the pixel gate, report that specific verification limitation
accurately and retain the repaired work; do not claim the source is unusable,
undo the usability repair just to match its bug, or fabricate passing evidence.
Responsive screenshots must match those same live-page references after
resizing, even if the authored assertion passes. Read differences and correct the source.

Actions:
- `{ "kind": "resize-container", "selector": ".cards-container", "width": 400 }`
- `{ "kind": "click", "selector": "button[aria-label=Options]" }`
- `{ "kind": "key", "key": "Tab", "shift": false }` (also Enter, Escape,
  space and arrow keys). Keyboard scenarios must reach and activate the control
  through keys; do not substitute pointer clicks.
- `{ "kind": "type", "text": "sample" }` inserts text at the focused control.
- `{ "kind": "assert", "expression": "document.querySelector('[role=menu]') !== null" }`

Use intermediate assertions after opening, dismissing or validating controls.
For disabled controls, assert their disabled semantics and unchanged outcome
following attempted interaction. State checks reopen the resulting URL directly
and reload it, then rerun the final assertion. The runner additionally checks
assets, runtime errors, rig hello, overflow and clipped controls, and blocks all
external network requests. Reports and screenshots are saved to the screen cache;
passing evidence is uploaded to private storage and bound to both checksums.
Missing scenarios are failures even if every supplied scenario passes.
