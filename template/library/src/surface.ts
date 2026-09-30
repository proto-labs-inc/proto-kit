/**
 * The page wears the product's surface colour (MAA-161): the token
 * with role "surface" becomes the background, the token with role
 * "text" the foreground when it reads on that surface, otherwise
 * whichever of black and white reads better. Every other shadcn
 * colour is mixed from those two, so the library's own UI stays
 * legible on a light, dark or saturated surface.
 */
import type { ThemeId, Token } from "./library";

type Rgb = { r: number; g: number; b: number };

function parseColor(value: string): Rgb | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) digits = digits.split("").map((d) => d + d).join("");
    const n = parseInt(digits, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgb = value.trim().match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return null;
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

const NEUTRAL: Record<ThemeId, Surface> = {
  light: { background: "#ffffff", foreground: "#171717" },
  dark: { background: "#171717", foreground: "#fafafa" },
};

export function surfaceFromTokens(tokens: Token[], theme: ThemeId = "light"): Surface {
  const surface = tokens.find((t) => t.role === "surface");
  if (!surface || !parseColor(surface.value)) return NEUTRAL[theme];
  const text = tokens.find((t) => t.role === "text");
  if (text && contrast(surface.value, text.value) >= READABLE) {
    return { background: surface.value, foreground: text.value };
  }
  let foreground = "#000000";
  if (contrast(surface.value, "#ffffff") > contrast(surface.value, "#000000")) foreground = "#ffffff";
  return { background: surface.value, foreground };
}

/** The stable CSS custom property an imported component uses for a manifest token. */
export function tokenVariable(name: string): string {
  return `--proto-token-${name}`;
}

export function paintSurface(
  root: HTMLElement,
  { background, foreground }: Surface,
  tokens: Token[] = [],
): void {
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

  // A theme owns the entire token namespace. Remove the previous theme's
  // names before applying the next one so a partial import cannot leave a
  // light value behind after switching to dark (or vice versa).
  for (const name of [...root.style]) {
    if (name.startsWith("--proto-token-")) root.style.removeProperty(name);
  }
  for (const token of tokens) {
    root.style.setProperty(tokenVariable(token.name), token.value);
  }
}
