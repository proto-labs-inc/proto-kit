/** Bounds shared by editable source and ready-to-serve screen archives. */
export const SCREEN_ARTIFACT_LIMIT = 64 * 1024 * 1024;
export const SCREEN_EXPANDED_LIMIT = 128 * 1024 * 1024;

// A repeated four-character regex group exhausts V8's regexp stack on video
// assets. Scan the alphabet once, then validate padding without recursion.
export function isBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : Number(value.endsWith("="));
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}
