import { useEffect, useState } from "react";
import { Fit } from "./Fit";

export const PLACEHOLDER_HEIGHT = 120;

type CrispProps = { src: string; alt: string; className?: string };

// A published library packs its check pictures into sheets and names
// each by its region: "sheet-1.png#xywh=0,120,240,52" (a media fragment,
// in the file's own pixels). The live library names each file whole.
type Region = { x: number; y: number; width: number; height: number };

function regionOf(src: string): { file: string; region: Region | null } {
  const [file, fragment = ""] = src.split("#");
  const match = /^xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(fragment);
  if (!match) return { file, region: null };
  const [x, y, width, height] = match.slice(1).map(Number);
  return { file, region: { x, y, width, height } };
}

/**
 * The width a 2x file has at its natural size, in CSS px: half its
 * pixels, measured once it loads; null until then. (A srcset density
 * would make the browser report a corrected size on some displays and
 * not others.)
 */
function useFileWidth(file: string | null): number | null {
  const [measured, setMeasured] = useState<{ file: string; width: number } | null>(null);
  useEffect(() => {
    if (file === null) return;
    const img = new Image();
    img.onload = () => setMeasured({ file, width: img.naturalWidth / 2 });
    img.src = file;
  }, [file]);
  if (file === null || measured?.file !== file) return null;
  return measured.width;
}

/** The width a capture shows at its natural size, in CSS px (a region of a sheet, the region's); null until known. */
export function usePictureWidth(src: string | null): number | null {
  const fileWidth = useFileWidth(src === null ? null : regionOf(src).file);
  if (src === null) return null;
  const { region } = regionOf(src);
  if (region !== null) return region.width / 2;
  return fileWidth;
}

/**
 * A 2x capture at its natural size, half the file's pixels, so it is
 * crisp; wider than its frame, it is scaled down to fit, with its own
 * size a click away for a pixel-for-pixel look (Fit). A region of a
 * sheet shows just that region, the same way.
 */
export function Crisp({ src, alt, className = "" }: CrispProps) {
  const { file, region } = regionOf(src);
  const fileWidth = useFileWidth(file);
  // Hidden until measured: at the file's own pixels it would show twice its size for a frame.
  const hidden = fileWidth === null ? "hidden" : undefined;
  if (region !== null) {
    return (
      <Fit width={region.width / 2} align="center" className={className}>
        <div role="img" aria-label={alt} className="relative overflow-hidden" style={{ width: region.width / 2, height: region.height / 2 }}>
          <img src={file} alt="" className="absolute block max-w-none" style={{ left: -region.x / 2, top: -region.y / 2, width: fileWidth ?? undefined, visibility: hidden }} />
        </div>
      </Fit>
    );
  }
  return (
    <Fit width={fileWidth ?? undefined} align="center" className={className}>
      <img src={src} alt={alt} className="block max-w-none" style={{ width: fileWidth ?? undefined, visibility: hidden }} />
    </Fit>
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
