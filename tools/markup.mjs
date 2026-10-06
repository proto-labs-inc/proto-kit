/**
 * Reading a frozen page's markup (src/frozen/page.html, one long line):
 * where a marked element starts and ends, whether one marked element sits
 * inside another, and a copy of one element laid out a tag per line for
 * an agent to read (grep on page.html returns the whole page).
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const markerAttr = (marker) => new RegExp(`<([a-zA-Z][\\w:-]*)\\b[^>]*\\sdata-proto-id="${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`);

/** The element marked `marker`: { start, end, tag } as offsets into html, or null. */
export function elementSpan(html, marker) {
  const open = markerAttr(marker).exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const start = open.index;
  const afterOpen = start + open[0].length;
  if (VOID.has(tag) || open[0].endsWith("/>")) return { start, end: afterOpen, tag };
  // Walk the tags after it, counting this tag name's opens and closes.
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
  tags.lastIndex = afterOpen;
  let depth = 1;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    if (m[1]) depth -= 1;
    else if (!m[2]) depth += 1;
    if (depth === 0) return { start, end: m.index + m[0].length, tag };
  }
  return { start, end: html.length, tag };
}

/** Pairs of markers where one element lies inside the other: [outer, inner]. */
export function nestedMarkers(html, markers) {
  const spans = markers.map((marker) => ({ marker, span: elementSpan(html, marker) })).filter((x) => x.span);
  const out = [];
  for (const a of spans) for (const b of spans) {
    if (a !== b && a.span.start <= b.span.start && b.span.end <= a.span.end) out.push([a.marker, b.marker]);
  }
  return out;
}

/** One element's markup, a tag per line and indented by depth, for reading
 *  only (whitespace between inline elements is not kept as it renders). */
export function readableMarkup(html) {
  const out = [];
  let depth = 0;
  for (const piece of html.split(/(<[^>]+>)/).filter((p) => p.trim())) {
    if (piece.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      out.push(`${"  ".repeat(depth)}${piece}`);
    } else if (piece.startsWith("<")) {
      out.push(`${"  ".repeat(depth)}${piece}`);
      const tag = /^<([a-zA-Z][\w:-]*)/.exec(piece)?.[1]?.toLowerCase();
      if (tag && !VOID.has(tag) && !piece.endsWith("/>") && !piece.startsWith("<!")) depth += 1;
    } else {
      out.push(`${"  ".repeat(depth)}${piece.trim()}`);
    }
  }
  return `${out.join("\n")}\n`;
}
