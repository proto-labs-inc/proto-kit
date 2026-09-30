/**
 * Pictures are taken from the product, never redrawn (MAA-217). A logo,
 * an icon, an illustration or a chart is the product's own file: copied
 * as it is, it matches on the first check, where a redrawn one invites
 * an endless tail of attempts at antialiasing it cannot win.
 *
 *   - <img> and <picture>: the file the browser picked (tools/snapshot.mjs
 *     writeImages).
 *   - an inline <svg>: its own markup, serialised from the page with
 *     every paint the product's stylesheet gave it written onto its
 *     elements, saved as <name>.svg beside the module and set inside the
 *     component's <svg> as it is; its ids, gradients and clip paths
 *     stay whole. A paint equal to the element's text colour is written
 *     currentColor, so a hover that changes the colour still reaches it.
 *   - a <canvas>: its pixels (toDataURL, or a screenshot of the element
 *     when the canvas is cross-origin), shown as an <img>.
 *   - a background, mask, list or border image in the stylesheet: the
 *     file downloaded beside the module and referenced relatively.
 *
 * The page-side half (PICTURE_OF) runs inside the product page, in the
 * same evaluate as the element read; the node half writes the files.
 */
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Page-side: `pictureOf(el)` → { kind: "svg", markup } for an outermost
 * <svg>, { kind: "canvas", data } for a <canvas> (data null when the
 * canvas is cross-origin), or null. Spliced into a page-side read.
 */
export const PICTURE_OF = String.raw`(() => {
  const INHERITED = ['color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'clip-rule', 'paint-order', 'shape-rendering', 'visibility', 'color-interpolation-filters', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline'];
  const OWN = { 'opacity': '1', 'stop-color': 'rgb(0, 0, 0)', 'stop-opacity': '1', 'clip-path': 'none', 'mask': 'none', 'filter': 'none', 'flood-color': 'rgb(0, 0, 0)', 'flood-opacity': '1', 'lighting-color': 'rgb(255, 255, 255)', 'mix-blend-mode': 'normal', 'vector-effect': 'none', 'transform': 'none' };
  const COLOURED = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color']);
  const page = location.href.split('#')[0];
  // A reference into this document is a fragment wherever the markup lands.
  const local = (value) => value.split('url("' + page + '#').join('url("#');
  const paintsOf = (el, parent) => {
    const s = getComputedStyle(el);
    const p = parent ? getComputedStyle(parent) : null;
    const out = [];
    for (const name of INHERITED) {
      const value = s.getPropertyValue(name);
      if (p && p.getPropertyValue(name) === value) continue;
      out.push([name, value]);
    }
    for (const [name, initial] of Object.entries(OWN)) {
      const value = s.getPropertyValue(name);
      if (value === initial) continue;
      // A transform the element states as an attribute is kept as the attribute.
      if (name === 'transform' && el.hasAttribute('transform')) continue;
      out.push([name, value]);
      if (name === 'transform') out.push(['transform-origin', s.getPropertyValue('transform-origin')], ['transform-box', s.getPropertyValue('transform-box')]);
    }
    if (s.display === 'none') out.push(['display', 'none']);
    return out.map(([name, value]) => [name, COLOURED.has(name) && value === s.color ? 'currentColor' : local(value)]);
  };
  const svgMarkup = (svg) => {
    const copy = svg.cloneNode(true);
    const originals = [svg, ...svg.querySelectorAll('*')];
    const copies = [copy, ...copy.querySelectorAll('*')];
    originals.forEach((el, i) => {
      const to = copies[i];
      for (const a of [...to.attributes]) {
        if (a.name === 'class' || a.name === 'style' || a.name.startsWith('on')) to.removeAttribute(a.name);
      }
      // The outer <svg> takes its paints from the component's stylesheet;
      // in the file they are written too, so it opens on its own as it looks.
      const paints = i === 0 ? paintsOf(el, null).filter(([name]) => ['color', 'fill', 'stroke'].includes(name)) : paintsOf(el, el.parentElement);
      if (paints.length > 0) to.setAttribute('style', paints.map(([name, value]) => name + ': ' + value).join('; '));
    });
    return new XMLSerializer().serializeToString(copy);
  };
  return (el) => {
    if (el.localName === 'svg' && el.namespaceURI === 'http://www.w3.org/2000/svg' && !(el.parentElement instanceof SVGElement)) {
      return { kind: 'svg', markup: svgMarkup(el) };
    }
    if (el.localName === 'canvas') {
      let data = null;
      try { data = el.toDataURL('image/png'); } catch {}
      return { kind: 'canvas', data };
    }
    return null;
  };
})()`;

/** Whether node `i` sits inside an <svg> taken as a picture: its look is in the picture's markup, not the stylesheet. */
export function inSvgPicture(nodes, i) {
  for (let at = nodes[i].parent; at !== -1 && at !== undefined; at = nodes[at].parent) {
    if (nodes[at].picture?.kind === "svg") return true;
  }
  return false;
}

/** The inner markup of a serialised <svg>, as the component's own <svg> holds it. Emitted into modules as `inside`. */
export const INSIDE = `const inside = (svg: string) => svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));`;

// The bytes a data: URL holds.
function bytesOf(url) {
  const comma = url.indexOf(",");
  const head = url.slice("data:".length, comma).split(";");
  const data = decodeURIComponent(url.slice(comma + 1));
  return head.includes("base64") ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
}

/**
 * Every svg and canvas picture the instances show, written beside the
 * module once each (the looks', not the held states'): markup → { ident, file } for an svg (<ident>.svg,
 * imported ?raw), data → { ident, file } for a canvas (<ident>.png).
 * Returns { svgs, canvases } keyed by the markup or data.
 */
export function writePictures(folder, instances) {
  const svgs = new Map();
  const canvases = new Map();
  // A look held with a pseudo-class shows its look's pictures; its colour reaches them through currentColor.
  for (const inst of instances.filter((x) => !x.state?.force)) {
    for (const node of inst.nodes) {
      const picture = node.picture;
      if (picture?.kind === "svg" && !svgs.has(picture.markup)) {
        const ident = `picture${svgs.size + canvases.size + 1}`;
        writeFileSync(join(folder, `${ident}.svg`), picture.markup + "\n");
        svgs.set(picture.markup, { ident, file: `${ident}.svg` });
      } else if (picture?.kind === "canvas" && picture.data && !canvases.has(picture.data)) {
        const ident = `picture${svgs.size + canvases.size + 1}`;
        writeFileSync(join(folder, `${ident}.png`), bytesOf(picture.data));
        canvases.set(picture.data, { ident, file: `${ident}.png` });
      }
    }
  }
  return { svgs, canvases };
}

// Properties whose value can name an image file.
const IMAGE_PROPERTY = /^(background-image|mask-image|-webkit-mask-image|-webkit-mask-box-image-source|list-style-image|border-image-source|content)$/;
const URL_IN = /url\("((?:https?:)?\/\/[^"]+)"\)/g;

/**
 * The files the instances' stylesheet values name (a background, a mask,
 * a list marker, a border image, a pseudo-element's content), saved
 * beside the module: a captured page's `assets` are copied, anything else
 * downloaded. Returns absolute url → "./<file>"; a file that cannot be
 * fetched keeps its address.
 */
export async function writeStyleImages(folder, instances, assets, download) {
  const urls = new Set();
  for (const inst of instances) {
    for (const node of inst.nodes) {
      for (const style of [node.style, ...Object.values(node.pseudo ?? {})]) {
        for (const [name, value] of Object.entries(style)) {
          if (!IMAGE_PROPERTY.test(name) || typeof value !== "string") continue;
          for (const match of value.matchAll(URL_IN)) urls.add(match[1]);
        }
      }
    }
  }
  const files = new Map();
  for (const url of urls) {
    const extension = /\.(svg|png|jpe?g|webp|gif|avif)$/i.exec(new URL(url, "https://x").pathname)?.[0] ?? ".png";
    const file = `background${files.size + 1}${extension}`;
    const captured = assets?.[url];
    try {
      if (captured && existsSync(captured)) copyFileSync(captured, join(folder, file));
      else await download(url, join(folder, file));
      files.set(url, `./${file}`);
    } catch {
      // Left at its address: the component still shows it while online.
    }
  }
  return files;
}

/** A stylesheet with every url the component's files replace pointed at them. */
export function localStyleImages(css, files) {
  let out = css;
  for (const [url, file] of files) out = out.replaceAll(`url("${url}")`, `url("${file}")`);
  return out;
}
