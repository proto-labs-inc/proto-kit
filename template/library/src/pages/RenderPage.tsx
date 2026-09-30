import { useEffect, useState } from "react";
import { Rendered, moduleOf } from "@/components/Rendered";
import type { ComponentState, Library } from "@/library";
import type { Placement } from "@/route";

type Props = { slug: string; state: string; placement: Placement; library: Library };

type Lookup =
  | { kind: "loading" }
  | { kind: "missing"; why: string }
  | { kind: "ready"; module: string; look: ComponentState; backdrop: string | null };

// The unit's own component.json: its states, each with the colour it
// sat on in the product where that differs from the component's own
// (a look read from another part of the page), and that backdrop, when
// the product painted one. Read from the folder, not the manifest, so
// a unit verifies before anything is landed; fetched as a file rather
// than imported as a module, so the import rewriting it while render
// tabs are open (the writer fits sizes in rounds) never reloads them.
type Unit = { states: ComponentState[]; backdrop?: string };

async function unitOf(slug: string): Promise<Unit | null> {
  const response = await fetch(`/src/components/${encodeURIComponent(slug)}/component.json?t=${Date.now()}`);
  if (!response.ok) return null;
  try {
    return (await response.json()) as Unit;
  } catch {
    return null;
  }
}

/**
 * One component in one state, alone on the product's surface, at the
 * absolute coordinates of the instance it is compared with, painted on
 * the backdrop it sat on in the product (a translucent control reads
 * differently on the page colour than on its card): the
 * fidelity check renders this route headlessly and diffs the clip
 * against the live page (docs/cdp-traps.md on why position matters).
 * The module and the state come from the unit's own folder, not the
 * manifest, so a unit verifies before anything is landed. No app
 * chrome, nothing else painted; data-render tells the tool what it got.
 */
export function RenderPage({ slug, state, placement, library }: Props) {
  const [lookup, setLookup] = useState<Lookup>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    const module = moduleOf(slug);
    if (!module) {
      setLookup({ kind: "missing", why: `no module in src/components/${slug}/` });
      return;
    }
    unitOf(slug).then((unit) => {
      if (!current) return;
      const look = unit?.states.find((s) => s.name === state);
      if (!look) setLookup({ kind: "missing", why: `no state "${state}" in src/components/${slug}/component.json` });
      else setLookup({ kind: "ready", module, look, backdrop: look.backdrop ?? unit?.backdrop ?? null });
    });
    return () => {
      current = false;
    };
  }, [slug, state]);

  const name = library.manifest.components.find((c) => c.slug === slug)?.name ?? slug;
  switch (lookup.kind) {
    case "loading":
      return null;
    case "missing":
      return <p data-render={lookup.why} className="m-0 p-4 text-sm text-muted-foreground">{lookup.why}</p>;
    case "ready":
      return (
        <div
          data-render="ok"
          style={{
            position: "absolute",
            left: placement.x,
            top: placement.y,
            width: placement.width ?? undefined,
            background: lookup.backdrop ?? undefined,
            // A grid cell, not a line: an inline-level root would otherwise
            // sit on the app's own line height, a few pixels low, and the
            // cell stretches the root to the width it had in the product.
            display: "grid",
            alignItems: "start",
          }}
        >
          <Rendered name={name} module={lookup.module} state={lookup.look} />
        </div>
      );
  }
}
