import { useState } from "react";

export const PLACEHOLDER_HEIGHT = 120;

type CrispProps = { src: string; alt: string; className?: string };

/**
 * A 2x capture shown at its natural size, half the file's pixels, so
 * it is crisp and never scaled: the width is measured once it loads
 * (a srcset density would make the browser report a corrected size on
 * some displays and not others). Sits in a frame that scrolls when the
 * capture is wider than the page, never clipping or stretching it.
 */
export function Crisp({ src, alt, className = "" }: CrispProps) {
  const [width, setWidth] = useState<number | null>(null);
  return (
    <div className={`overflow-x-auto ${className}`}>
      <img
        src={src}
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
 * took from the live page, at the size the component has in the
 * product, on the same padding the built component gets. A component
 * with no crop yet gets a blank frame of the same height as a moving
 * block, so the page does not jump when one lands.
 */
export function ProductCrop({ name, screenshot }: Props) {
  if (screenshot === null) return <div style={{ height: PLACEHOLDER_HEIGHT }} />;
  return <Crisp src={screenshot} alt={`${name} in the product`} className="p-5" />;
}
