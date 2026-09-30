/**
 * Pack a built library's check pictures into a few sheets per
 * component, for publishing (tools/publish-library.mjs).
 *
 * Every check a component made is kept, and each makes three pictures
 * (the product, our copy, the difference): an exhaustive import makes
 * hundreds, more files than a publish may carry. The live library keeps
 * them one file each, streaming as checks land; the published build
 * carries each component's pictures in sheets stacked top to bottom, at
 * most SHEET_HEIGHT device pixels tall, and its manifest points each
 * pass picture at its region with a media fragment:
 *   components/button/history/sheet-1.png#xywh=0,120,240,52
 * The app shows that region (ProductCrop's Crisp). Only dist/ changes.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "./cdp/png.mjs";

const SHEET_HEIGHT = 4000;

/** Copy `image` into `sheet` at (x, y). */
function blit(sheet, image, x, y) {
  for (let row = 0; row < image.height; row++) {
    const from = row * image.width * 4;
    sheet.data.set(image.data.subarray(from, from + image.width * 4), ((y + row) * sheet.width + x) * 4);
  }
}

/**
 * Pack dist/components/<slug>/history/*.png into sheets and point
 * dist/manifest.json at them. Returns how many files it saved.
 */
export function packHistory(dist) {
  const manifestPath = join(dist, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let saved = 0;
  for (const component of manifest.components) {
    const folder = join(dist, "components", component.slug, "history");
    if (!existsSync(folder) || component.history.length === 0) continue;
    // Every picture a pass names, in pass order, each once.
    const paths = [];
    for (const pass of component.history) {
      for (const key of ["live", "screenshot", "diff"]) if (pass[key] && !paths.includes(pass[key])) paths.push(pass[key]);
    }
    const images = paths.map((path) => ({ path, image: decodePng(readFileSync(join(dist, path))) }));
    // Shelves top to bottom; a new sheet when the next picture would pass the height.
    const sheets = [];
    let current = null;
    for (const entry of images) {
      if (!current || current.height + entry.image.height > SHEET_HEIGHT) {
        current = { items: [], width: 0, height: 0 };
        sheets.push(current);
      }
      current.items.push({ ...entry, x: 0, y: current.height });
      current.width = Math.max(current.width, entry.image.width);
      current.height += entry.image.height;
    }
    const where = new Map();
    sheets.forEach((sheet, k) => {
      const name = `sheet-${k + 1}.png`;
      const canvas = { width: sheet.width, height: sheet.height, data: new Uint8Array(sheet.width * sheet.height * 4) };
      for (const item of sheet.items) {
        blit(canvas, item.image, item.x, item.y);
        where.set(item.path, `components/${component.slug}/history/${name}#xywh=${item.x},${item.y},${item.image.width},${item.image.height}`);
      }
      writeFileSync(join(folder, name), encodePng(canvas));
    });
    for (const pass of component.history) {
      for (const key of ["live", "screenshot", "diff"]) if (pass[key]) pass[key] = where.get(pass[key]);
    }
    for (const name of readdirSync(folder)) {
      if (/^\d+(-diff|-live)?\.png$/.test(name)) rmSync(join(folder, name));
    }
    saved += paths.length - sheets.length;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return saved;
}
