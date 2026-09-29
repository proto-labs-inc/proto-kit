/**
 * The page wears the product's surface colour (MAA-161): the token
 * with role "surface" becomes the background, the token with role
 * "text" the foreground when it reads on that surface, otherwise
 * whichever of black and white reads better. Every other shadcn
 * colour is mixed from those two, so the library's own UI stays
 * legible on a light, dark or saturated surface.
 */
import type { Token } from "./library";

type Rgb = { r: number; g: number; b: number };

let pixel: CanvasRenderingContext2D | null = null;

/**
 * The browser resolves the colour, so any syntax it paints (hex, rgb,
 * hsl, oklch, oklab, color(), relative colours) reads the same here as
 * on the page. The value is painted on one sRGB pixel and read back.
 */
function parseColor(value: string): Rgb | null {
  if (!CSS.supports("color", value)) return null;
  pixel ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!pixel) return null;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = value;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    if (s <= 0.03928) return s / 12.92;
    return ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return 1;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const READABLE = 4.5;

export type Surface = { background: string; foreground: string };

const NEUTRAL: Surface = { background: "#ffffff", foreground: "#171717" };

export function surfaceFromTokens(tokens: Token[]): Surface {
  const surface = tokens.find((t) => t.role === "surface");
  if (!surface || !parseColor(surface.value)) return NEUTRAL;
  const text = tokens.find((t) => t.role === "text");
  if (text && contrast(surface.value, text.value) >= READABLE) {
    return { background: surface.value, foreground: text.value };
  }
  let foreground = "#000000";
  if (contrast(surface.value, "#ffffff") > contrast(surface.value, "#000000")) foreground = "#ffffff";
  return { background: surface.value, foreground };
}

export function paintSurface(root: HTMLElement, { background, foreground }: Surface): void {
  const mix = (amount: number, base = "transparent") =>
    `color-mix(in oklab, ${foreground} ${amount}%, ${base})`;
  const vars: Record<string, string> = {
    "--background": background,
    "--foreground": foreground,
    "--card": mix(2, background),
    "--card-foreground": foreground,
    "--popover": background,
    "--popover-foreground": foreground,
    "--primary": foreground,
    "--primary-foreground": background,
    "--secondary": mix(6, background),
    "--secondary-foreground": foreground,
    "--muted": mix(6, background),
    "--muted-foreground": mix(62, background),
    "--accent": mix(6, background),
    "--accent-foreground": foreground,
    "--border": mix(12),
    "--input": mix(12),
    "--ring": mix(40),
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}
