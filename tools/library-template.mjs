import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = join(KIT, "template", "library");

/**
 * Bring an existing library app onto the current reader contract without
 * touching imported data in public/ or removing imported component folders.
 */
export function syncLibraryTemplate(libraryDir) {
  if (!existsSync(TEMPLATE)) throw new Error(`library template is missing at ${TEMPLATE}`);
  cpSync(TEMPLATE, libraryDir, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist|public)([\\/]|$)/.test(source),
  });
}
