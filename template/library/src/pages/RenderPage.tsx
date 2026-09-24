import { Rendered } from "@/components/Rendered";
import type { Library } from "@/library";
import type { Placement } from "@/route";

type Props = { slug: string; state: string; placement: Placement; library: Library };

/**
 * One component in one state, alone on the product's surface, at the
 * absolute coordinates of the instance it is compared with: the
 * fidelity check renders this route headlessly and diffs the clip
 * against the live page (docs/cdp-traps.md on why position matters).
 * No app chrome, nothing else painted.
 */
export function RenderPage({ slug, state, placement, library }: Props) {
  const component = library.manifest.components.find((c) => c.slug === slug);
  const look = component?.states.find((s) => s.name === state);
  if (!component || !look) {
    const missing = `no state "${state}" of "${slug}" in the manifest`;
    return <p data-render={missing} className="m-0 p-4 text-sm text-muted-foreground">{missing}</p>;
  }
  return (
    <div data-render="ok" style={{ position: "absolute", left: placement.x, top: placement.y, width: placement.width ?? undefined }}>
      <Rendered component={component} state={look} />
    </div>
  );
}
