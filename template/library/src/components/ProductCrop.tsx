import { useState } from "react";

const PLACEHOLDER_HEIGHT = 120;

type CrispProps = { src: string; alt: string; className?: string };

/**
 * A 2x capture shown at 1x, so it is crisp: never scaled past 1:1. The
 * 2x candidate makes a 2x display right at once; the measured width
 * keeps a 1x display from showing the capture at twice its size. Sits
 * in a frame that scrolls when the capture is wider, never clipping.
 */
export function Crisp({ src, alt, className = "" }: CrispProps) {
  const [width, setWidth] = useState<number | null>(null);
  return (
    <div className={`overflow-x-auto ${className}`}>
      <img
        src={src}
        srcSet={`${src} 2x`}
        alt={alt}
        className="mx-auto block max-w-none"
        style={{ width: width ?? undefined }}
        onLoad={(e) => setWidth(e.currentTarget.naturalWidth / 2)}
      />
    </div>
  );
}

type Props = { name: string; screenshot: string | null };

/**
 * The product's own picture of a component: the 2x crop the import
 * took from the live page. A component with no crop yet gets a blank
 * frame of the same height as a moving block, so the page does not
 * jump when one lands.
 */
export function ProductCrop({ name, screenshot }: Props) {
  if (screenshot === null) return <div className="bg-muted/60" style={{ height: PLACEHOLDER_HEIGHT }} />;
  return <Crisp src={screenshot} alt={`${name} in the product`} />;
}
