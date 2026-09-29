/**
 * The page wears the product's surface colour (MAA-161): the token
 * with role "surface" becomes the background, the token with role
 * "text" the foreground when it reads on that surface, otherwise
 * whichever of black and white reads better. Every other shadcn
 * colour is mixed from those two, so the library's own UI stays
 * legible on a light, dark or saturated surface. Before the surface
 * token exists the page keeps the stylesheet's own neutral, which
 * follows the reader's colour scheme and is dark by default
 * (styles.css), so the library never flashes light inside a dark
 * setup dialog.
 */
import type { Token } from "./library";

type Rgba = { r: number; g: number; b: number; a: number };

let pixel: CanvasRenderingContext2D | null = null;

/**
 * The browser resolves the colour, so any syntax it paints (hex, rgb,
 * hsl, oklch, lab, color(), color-mix(), relative colours) reads the
 * same here as on the page. The value is painted on one cleared sRGB
 * pixel and read back, alpha included.
 */
function parseColor(value: string): Rgba | null {
  if (!CSS.supports("color", value)) return null;
  pixel ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!pixel) return null;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = value;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a };
}

const byte = (n: number) => n.toString(16).padStart(2, "0");

/**
 * A colour as hex, the way the palette shows every value whatever
 * syntax the product wrote it in: "#1a1a1a", or "#1a1a1a80" when it
 * is translucent. The value itself when the browser cannot paint it.
 */
export function hexOf(value: string): string {
  const c = parseColor(value);
  if (!c) return value;
  const rgb = `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;
  if (c.a === 255) return rgb;
  return `${rgb}${byte(c.a)}`;
}

function luminance({ r, g, b }: Rgba): number {
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

/** The product's surface, or null while the import has not read one. */
export function surfaceFromTokens(tokens: Token[]): Surface | null {
  const surface = tokens.find((t) => t.role === "surface");
  if (!surface || !parseColor(surface.value)) return null;
  const text = tokens.find((t) => t.role === "text");
  if (text && contrast(surface.value, text.value) >= READABLE) {
    return { background: surface.value, foreground: text.value };
  }
  let foreground = "#000000";
  if (contrast(surface.value, "#ffffff") > contrast(surface.value, "#000000")) foreground = "#ffffff";
  return { background: surface.value, foreground };
}

const PAINTED = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--ring",
];

/** Paint the product's surface over the stylesheet's neutral, or take it off again. */
export function paintSurface(root: HTMLElement, surface: Surface | null): void {
  if (surface === null) {
    for (const name of PAINTED) root.style.removeProperty(name);
    return;
  }
  const { background, foreground } = surface;
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
