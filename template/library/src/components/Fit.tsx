import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** How the content is shown: scaled to the frame's width, or at its own size, scrolling sideways. */
export type Size = "fit" | "actual";
/** Where content narrower than the frame sits: at its start, like a component on its stage, or in the middle, like a picture. */
export type Align = "start" | "center";

type Props = {
  /**
   * The content's own width in CSS px: a component's width in the
   * product, a picture's natural size. Measured from what the content
   * spills to when not known.
   */
  width?: number;
  align?: Align;
  className?: string;
  children: ReactNode;
};

/**
 * Content at its own size, scaled down to the width of the frame it sits
 * in when it is wider (MAA-215): a 1200px header shows whole in a 700px
 * column, laid out as it is in the product, never cut off or reflowed.
 * Scaling loses the one-to-one pixels a comparison needs, so a scaled
 * frame says how far it is scaled and a click shows it at its own size,
 * scrolling sideways, and back.
 */
export function Fit({ width, align = "start", className = "", children }: Props) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>("fit");
  const [box, setBox] = useState<{ scale: number; height: number }>({ scale: 1, height: 0 });

  useLayoutEffect(() => {
    const frame = outer.current;
    const content = inner.current;
    if (!frame || !content) return;
    const measure = () => {
      const room = frame.clientWidth;
      // scrollWidth is the content's own layout, untouched by its scale.
      const natural = Math.max(width ?? 0, content.scrollWidth);
      const scale = room > 0 && natural > room + 0.5 ? room / natural : 1;
      setBox({ scale, height: content.offsetHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);
    // A lazily loaded component replaces its placeholder inside the
    // content without resizing the content's own box.
    const mutations = new MutationObserver(measure);
    mutations.observe(content, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [width]);

  const scaled = box.scale < 1;
  const actual = size === "actual" || !scaled;
  const scale = actual ? 1 : box.scale;
  return (
    <div className={`relative ${className}`}>
      <div ref={outer} className={actual ? "overflow-x-auto" : "overflow-hidden"} style={{ height: actual ? undefined : Math.ceil(box.height * scale) }}>
        <div ref={inner} style={{ width: width ?? "100%", marginInline: align === "center" && !scaled ? "auto" : undefined, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: "top left" }}>
          {children}
        </div>
      </div>
      {scaled && <SizeToggle size={size} scale={box.scale} onToggle={() => setSize(size === "fit" ? "actual" : "fit")} />}
    </div>
  );
}

function SizeToggle({ size, scale, onToggle }: { size: Size; scale: number; onToggle: () => void }) {
  const percent = `${Math.round(scale * 100)}%`;
  return (
    <Button
      size="xs"
      variant="outline"
      className="absolute top-2 right-2 z-10 bg-background/90 text-muted-foreground shadow-sm"
      onClick={onToggle}
      title={size === "fit" ? `Shown at ${percent} to fit; show it at full size` : "Scale it to fit"}
    >
      {size === "fit" ? (
        <>
          <Maximize2Icon /> {percent}
        </>
      ) : (
        <>
          <Minimize2Icon /> Fit
        </>
      )}
    </Button>
  );
}
