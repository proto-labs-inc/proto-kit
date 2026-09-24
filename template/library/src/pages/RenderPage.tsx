import { useEffect, useState } from "react";
import { Rendered, moduleOf, statesOf } from "@/components/Rendered";
import type { ComponentState, Library } from "@/library";
import type { Placement } from "@/route";

type Props = { slug: string; state: string; placement: Placement; library: Library };

type Lookup =
  | { kind: "loading" }
  | { kind: "missing"; why: string }
  | { kind: "ready"; module: string; look: ComponentState };

/**
 * One component in one state, alone on the product's surface, at the
 * absolute coordinates of the instance it is compared with: the
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
    statesOf(slug).then((states) => {
      if (!current) return;
      const look = states?.find((s) => s.name === state);
      if (!look) setLookup({ kind: "missing", why: `no state "${state}" in src/components/${slug}/states.json` });
      else setLookup({ kind: "ready", module, look });
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
        <div data-render="ok" style={{ position: "absolute", left: placement.x, top: placement.y, width: placement.width ?? undefined }}>
          <Rendered name={name} module={lookup.module} state={lookup.look} />
        </div>
      );
  }
}
