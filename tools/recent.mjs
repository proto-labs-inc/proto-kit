#!/usr/bin/env node
/**
 * References from Recent (recent.design), a daily feed of interface,
 * product, web and motion design. Its public API (the same one its site
 * uses, no account) lists every post with a written description, tags,
 * a poster image and, for most, a short clip. The whole catalogue in the
 * categories that matter for product work is a few hundred posts, so it
 * is read once and kept for six hours; a search is then a local match,
 * instant.
 *
 * Usage:
 *   node tools/recent.mjs search "<words>" [--limit 20] [--category interface,product,web,motion]
 *       the best matches, one JSON line each:
 *       {source:"recent", id, title, url, image, video?, width, height, description, tags, score}
 *       ready to become a sketch reference (add `why`, keep the rest)
 *
 * A change on Recent's side that leaves nothing readable is an error
 * naming what failed, never an empty answer.
 */
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.recent.design/rpc/items/list";
const SITE = "https://recent.design";
const CATEGORIES = ["interface", "product", "web", "motion"];
const CACHE = join(process.env.HOME ?? ".", ".proto", "cache", "recent-design.json");
const CACHE_MS = 6 * 60 * 60 * 1000;
const PAGE = 100;

async function listCategory(category) {
  const items = [];
  let cursor;
  for (let page = 0; page < 12; page += 1) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Proto (+https://prototypes.fun)" },
      body: JSON.stringify({ json: { category, limit: PAGE, sort: "recent", ...(cursor ? { cursor } : {}) } }),
    });
    if (!res.ok) throw new Error(`Recent answered ${res.status} for ${category}`);
    const body = (await res.json())?.json;
    if (!body || !Array.isArray(body.items)) throw new Error(`Recent's item list for ${category} has changed shape`);
    items.push(...body.items);
    if (!body.nextCursor || body.items.length < PAGE) break;
    cursor = body.nextCursor;
  }
  return items;
}

/** A post as a reference candidate: what the sketch needs, nothing else. */
export function toCandidate(item) {
  const cover = item.cover ?? item.media?.[0];
  if (!cover) return null;
  const poster = cover.poster ?? (cover.mediaType === "image" ? cover : null);
  const rendition = poster?.renditions?.find((r) => r.width >= 900) ?? poster?.renditions?.at(-1) ?? poster;
  const image = rendition?.url ?? poster?.url;
  if (!image) return null;
  return {
    source: "recent",
    id: item.id,
    title: item.title,
    url: `${SITE}/i/${item.id}-${item.slug}`,
    image,
    ...(cover.mediaType === "video" ? { video: cover.url } : {}),
    width: poster?.width ?? cover.mediaWidth,
    height: poster?.height ?? cover.mediaHeight,
    category: item.category?.slug,
    description: item.description ?? "",
    tags: (item.tags ?? []).map((tag) => tag.name),
  };
}

async function catalogue(categories) {
  try {
    const age = Date.now() - statSync(CACHE).mtimeMs;
    const cached = JSON.parse(readFileSync(CACHE, "utf8"));
    if (age < CACHE_MS && categories.every((c) => cached.categories.includes(c))) return cached.items.filter((i) => categories.includes(i.category));
  } catch {
    // No cache yet, or an unreadable one: read Recent again.
  }
  const lists = await Promise.all(CATEGORIES.map(listCategory));
  const items = lists.flat().map(toCandidate).filter(Boolean);
  if (items.length === 0) throw new Error("Recent listed no posts with pictures");
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ categories: CATEGORIES, items }));
  return items.filter((i) => categories.includes(i.category));
}

const STOP = new Set("a an and the of to in on for with without from by is are be it its this that as at or into your our their".split(" "));

export function words(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
}

/** How well a candidate matches the words: title and tags count most. */
export function score(candidate, query) {
  const title = new Set(words(candidate.title));
  const tags = new Set(candidate.tags.flatMap(words));
  const body = new Set(words(candidate.description));
  let total = 0;
  for (const word of query) {
    const stem = word.replace(/(ing|es|s|ed)$/, "");
    const hit = (set) => [...set].some((w) => w === word || (stem.length > 3 && w.startsWith(stem)));
    if (hit(title)) total += 3;
    if (hit(tags)) total += 2;
    if (hit(body)) total += 1;
  }
  return total;
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
    else flags._.push(argv[i]);
  }
  return flags;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command !== "search" || !flags._[0]) {
    console.error('Usage: node tools/recent.mjs search "<words>" [--limit 20] [--category interface,product,web,motion]');
    process.exit(2);
  }
  const categories = flags.category ? String(flags.category).split(",") : CATEGORIES;
  const query = words(flags._.join(" "));
  const items = await catalogue(categories);
  const ranked = items
    .map((item) => ({ ...item, score: score(item, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(flags.limit ?? 20));
  for (const item of ranked) console.log(JSON.stringify(item));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`recent: ${error.message}`);
    process.exit(1);
  });
}
