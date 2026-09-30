/**
 * A draft curation of a build's tree, from its structure alone, so the
 * agent reviews names and roles instead of writing them.
 *
 * Roles (docs/build-read.md): the root, any box over a tenth of the
 * viewport, and a box spanning the page that holds two or more parts
 * is a `section`; an interactive control, a repeating list read whole,
 * a box with nothing under it, or any other box up to a tenth of the
 * viewport is a `leaf`; a box whose only job is to hold another (the
 * same box as its parent, its parent's only box, or anything inside a
 * leaf) is `packaging`. Names come from what the page
 * says about the box: its aria label, a heading in it, a landmark tag,
 * a class that reads as a name, its own text. Markers are the names in
 * kebab case, unique, shared only by repeated siblings.
 *
 * `draftCuration(tree)` -> [{ id, name, role, marker? }] in tree order.
 */

// A box over this share of the viewport holds parts; one up to it is
// one component unless it spans the page and plainly holds several.
const LEAF_SHARE = 0.1;
// A box this close to its parent's edges is the parent's wrapper.
const SAME_BOX_PX = 2;

const LANDMARKS = { header: "Header", nav: "Navigation", footer: "Footer", aside: "Sidebar", form: "Form", table: "Table", dialog: "Dialog" };
const PIECES = {
  h1: "Title", h2: "Title", h3: "Title", h4: "Title", h5: "Title", h6: "Title",
  img: "Image", svg: "Icon", input: "Field", textarea: "Field", select: "Select", label: "Label",
  ul: "List", ol: "List", li: "List item", p: "Text", span: "Text", button: "Button", a: "Link",
  video: "Video", canvas: "Canvas", iframe: "Frame",
};

const tagOf = (node) => node.tag ?? node.raw.split(" > ").pop().split(".")[0];
const isInteractive = (node) => node.interactive ?? ["a", "button", "input", "select", "textarea", "label", "summary"].includes(tagOf(node));

const words = (text) => text.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
const sentence = (text) => {
  const w = words(text).toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const shortText = (text) => (text && text.length <= 30 && /[A-Za-z]{2}/.test(text) && !/\n/.test(text) ? text : null);

export const kebab = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * What a box could be called and how sure the page is of it: its aria
 * label first, then a landmark with its heading, a control with its
 * words, a heading, a class that reads as a name, the box's own words,
 * its role, what kind of element it is, and last a generic word for
 * its role. `heading` is used only when `ownsHeading` says the heading
 * belongs to this box and not to a part inside it.
 */
function candidates(node, role, ownsHeading) {
  const tag = tagOf(node);
  const out = [];
  if (node.aria) out.push([1, sentence(node.aria)]);
  const own = shortText(node.ownText) ?? shortText(node.text);
  const heading = ownsHeading ? node.heading : null;
  // A landmark owns the heading inside it whichever part shows it: the
  // page is named after its title, the header after the heading it holds.
  if (tag === "main") out.push([2, node.heading ? `${node.heading} page` : "Main"]);
  else if (LANDMARKS[tag]) out.push([2, node.heading ? `${node.heading} ${LANDMARKS[tag].toLowerCase()}` : LANDMARKS[tag]]);
  if ((tag === "button" || tag === "a") && (own || heading)) out.push([3, `${own ?? heading} ${PIECES[tag].toLowerCase()}`]);
  if (heading) out.push([4, heading]);
  if (node.classes?.[0]) out.push([5, sentence(node.classes[0])]);
  if (own && role !== "section") out.push([6, own]);
  if (node.role) out.push([7, sentence(node.role)]);
  if (PIECES[tag]) out.push([8, PIECES[tag]]);
  if (node.collapsed === "repeats") out.push([8, "List"]);
  if (role === "section") out.push([9, "Group"]);
  else if (role === "leaf") out.push([9, "Block"]);
  else out.push([9, "Wrapper"]);
  return out;
}

/** What to call a box: its best candidate, or, for a box whose only job
 *  is to hold a chain of wrappers, the best along that chain (the page
 *  header's box is a div; the header element inside it says what it is). */
function nameOf(node, role, { chain = [], ownsHeading = () => true } = {}) {
  let best = candidates(node, role, ownsHeading(node)).sort((a, b) => a[0] - b[0])[0];
  for (const inner of chain) {
    const theirs = candidates(inner, "packaging", ownsHeading(inner)).sort((a, b) => a[0] - b[0])[0];
    if (theirs[0] < best[0] && theirs[0] <= 4) best = theirs;
  }
  return best[1];
}

export function draftCuration(tree) {
  const nodes = tree.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) if (node.parent !== null) children.get(node.parent)?.push(node);
  const viewport = tree.viewport.width * tree.viewport.height;
  const roles = new Map();

  const sameBox = (node, parent) =>
    Math.abs(node.rect.x - parent.rect.x) <= SAME_BOX_PX &&
    Math.abs(node.rect.y - parent.rect.y) <= SAME_BOX_PX &&
    Math.abs(node.rect.w - parent.rect.w) <= SAME_BOX_PX &&
    Math.abs(node.rect.h - parent.rect.h) <= SAME_BOX_PX;
  const insideLeaf = (node) => {
    for (let p = node.parent; p !== null; p = byId.get(p).parent) if (roles.get(p) === "leaf") return true;
    return false;
  };

  // A wrapper is the same box as its parent, or its parent's only box:
  // it holds one thing and is struck through. The role of a chain of
  // wrappers belongs to the outermost box, the one the page's layout
  // places.
  const isWrapper = (node, parent) => sameBox(node, parent) || children.get(parent.id).length === 1;
  // What a box is made of: the boxes under it that are not wrappers.
  const partsUnder = (node) => {
    let count = 0;
    const walk = (id) => {
      for (const child of children.get(id)) {
        if (!isWrapper(child, byId.get(id))) count++;
        walk(child.id);
      }
    };
    walk(node.id);
    return count;
  };
  const spans = (node) => node.rect.w >= tree.viewport.width * 0.9 || node.rect.h >= tree.viewport.height * 0.9;

  // Parents come before children in the tree, so a node's ancestors are decided first.
  for (const node of nodes) {
    const kids = children.get(node.id);
    const parent = node.parent === null ? null : byId.get(node.parent);
    let role;
    if (parent === null) role = "section";
    else if (insideLeaf(node)) role = "packaging";
    else if (isInteractive(node) || node.collapsed === "repeats") role = "leaf";
    else if (isWrapper(node, parent)) role = "packaging";
    else if (kids.length === 0) role = "leaf";
    else if ((node.rect.w * node.rect.h) / viewport > LEAF_SHARE) role = "section";
    else if (spans(node) && partsUnder(node) >= 2) role = "section";
    else role = "leaf";
    roles.set(node.id, role);
  }

  // A heading names the outermost box that holds no other part with
  // that heading: the page's title names the page, not the body.
  const ownsHeading = (node) => !children.get(node.id).some((child) => roles.get(child.id) !== "packaging" && child.heading === node.heading);
  // The wrappers under a box, while each is its parent's only box.
  const chainUnder = (node) => {
    const out = [];
    for (let kids = children.get(node.id); kids.length === 1 && roles.get(kids[0].id) === "packaging"; kids = children.get(kids[0].id)) out.push(kids[0]);
    return out;
  };
  const named = new Map(nodes.map((node) => {
    const role = roles.get(node.id);
    if (node.parent === null) return [node.id, "Page"];
    return [node.id, nameOf(node, role, { chain: role === "packaging" ? [] : chainUnder(node), ownsHeading })];
  }));

  // Markers: kebab names, unique, except that repeated siblings (same
  // label under one parent) share one, as list rows do in a prototype.
  const markers = new Map();
  const taken = new Map();
  for (const node of nodes) {
    const role = roles.get(node.id);
    if (role === "packaging") continue;
    const name = named.get(node.id);
    const alike = (a, b) => Math.abs(a - b) <= Math.max(4, b * 0.25);
    const twin = nodes.find(
      (other) =>
        markers.has(other.id) &&
        other.parent === node.parent &&
        other.raw === node.raw &&
        roles.get(other.id) === role &&
        named.get(other.id) === name &&
        alike(other.rect.w, node.rect.w) &&
        alike(other.rect.h, node.rect.h),
    );
    if (twin) {
      markers.set(node.id, markers.get(twin.id));
      continue;
    }
    const base = kebab(name) || `part-${node.id}`;
    let marker = base;
    for (let n = 2; taken.has(marker); n++) marker = `${base}-${n}`;
    taken.set(marker, node.id);
    markers.set(node.id, marker);
  }

  return nodes.map((node) => {
    const role = roles.get(node.id);
    const entry = { id: node.id, name: named.get(node.id), role };
    if (role !== "packaging") entry.marker = markers.get(node.id);
    return entry;
  });
}
