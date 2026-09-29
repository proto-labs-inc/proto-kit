import type { ReactNode } from "react";

/** What a stage is holding: the component itself, or a picture of it from the product. */
export type Holds = "component" | "picture";

type Props = {
  holds: Holds;
  /** The colour the component sat on in the product; the page's own surface when the import read none. */
  backdrop: string | undefined;
  className?: string;
  children: ReactNode;
};

/**
 * The frame a component sits in, on the overview and on its page,
 * painted with the component's own backdrop so a dark component on
 * a dark product looks the way it did there, not blacker on a grey
 * card. A frame holding the component itself has a solid edge; one
 * holding only a picture of it from the product has a dashed edge, the
 * plain sign of a place kept for something not there yet: it says
 * "not built" at a glance without a mark laid over the product's own
 * pixels, and it stays readable on any backdrop.
 */
export function Stage({ holds, backdrop, className = "", children }: Props) {
  const edge = holds === "component" ? "ring-1 ring-foreground/10" : "outline-1 outline-dashed outline-foreground/30 -outline-offset-1";
  return (
    <div className={`relative overflow-hidden rounded-xl ${edge} ${className}`} style={{ background: backdrop ?? "var(--background)" }}>
      {children}
    </div>
  );
}
