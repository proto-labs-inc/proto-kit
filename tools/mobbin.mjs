#!/usr/bin/env node
/**
 * Mobbin references for a variant set, with no Mobbin account. Every
 * flow and screen on Mobbin has a public page carrying its full-size
 * screens, readable signed out. Mobbin's own search needs a sign-in, so
 * finding them is the agent's web search restricted to mobbin.com (search
 * engines index those pages), or, without web search, Mobbin's topics: a
 * flow like "Adding & Creating", a screen pattern like "Invite
 * Teammates", a UI element like "Text Field", each showing its first
 * page signed out.
 *
 * Each reference is saved into the workspace and links back to its
 * Mobbin page, which is where the person goes to look closer.
 *
 * Usage:
 *   node tools/mobbin.mjs topics [--platform web|mobile] [--match "<words>"]
 *       topics as <platform>/<kind>/<slug>, kind flows|screens|ui-elements;
 *       --match keeps those whose slug holds any of the words
 *   node tools/mobbin.mjs browse <topic>
 *       the topic's examples, one JSON line each: {url, kind, app, title}
 *   node tools/mobbin.mjs screens <mobbin url>
 *       {app, url, title, screens}: how many screens a flow has (a screen page has 1)
 *   node tools/mobbin.mjs save <workspace> <mobbin url> --as <name> [--screen <n>]
 *       <mobbin url>: a flow or screen page, from web search or browse
 *       writes public/references/<name>.webp (a flow's first screen, or
 *       --screen n of it) and prints the reference to register:
 *       {app, url, image}; add its note and variant
 *
 * A page Mobbin has changed so nothing can be read is an error naming the
 * page, never an empty answer: the skill then goes on without references.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repairReferenceServing } from "./repair-reference-serving.mjs";

const SITE = "https://mobbin.com";
const HEADERS = { "User-Agent": "Proto (+https://prototypes.fun)" };
const KINDS = ["flows", "screens", "ui-elements"];
/** Wide enough for the Frame's lightbox, a fraction of the 3840 original. */
const WANT_WIDTH = 1920;

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function unescape(text) {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** Topic paths (web/flows/adding-creating) from Mobbin's sitemap. */
export function parseTopics(sitemap) {
  const topics = new Set();
  const pattern = new RegExp(`<loc>${SITE}/explore/((?:web|mobile)/(?:${KINDS.join("|")})/[a-z0-9-]+)</loc>`, "g");
  for (const m of sitemap.matchAll(pattern)) topics.add(m[1]);
  return [...topics];
}

export function matchTopics(topics, { platform, match } = {}) {
  const words = (match ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return topics.filter((t) => {
    if (platform && !t.startsWith(`${platform}/`)) return false;
    if (words.length === 0) return true;
    const slug = t.split("/")[2];
    return words.some((w) => slug.includes(w) || slug.includes(w.replace(/(ing|e|s)$/, "")));
  });
}

/**
 * A topic page's examples, in the page's order. A flow's card reads
 * "<title> on <app>"; a screen's image reads "<app> <Web|iOS|Android> <pattern> screen".
 */
export function parseTopicPage(page) {
  const examples = new Map();
  const flow = new RegExp(`href="/explore/flows/(${ID})"`, "g");
  for (const m of page.matchAll(flow)) {
    if (examples.has(m[1])) continue;
    // The card's caption follows its last image link: "<title>" "on" "<app>".
    const lastLink = page.lastIndexOf(`/explore/flows/${m[1]}"`);
    const texts = [...page.slice(lastLink, lastLink + 6000).matchAll(/>([^<>]+)</g)].map((t) => unescape(t[1]).trim()).filter(Boolean);
    const on = texts.indexOf("on");
    if (on < 1 || !texts[on + 1]) continue;
    examples.set(m[1], { url: `${SITE}/explore/flows/${m[1]}`, kind: "flow", app: texts[on + 1], title: texts[on - 1] });
  }
  const screen = new RegExp(`href="/explore/screens/(${ID})"[^>]*>[\\s\\S]{0,600}?alt="([^"]+)"`, "g");
  for (const m of page.matchAll(screen)) {
    if (examples.has(m[1])) continue;
    const alt = /^(.+?) (?:Web|iOS|Android) (.+?)(?: screen)?$/.exec(unescape(m[2]));
    if (!alt) continue;
    examples.set(m[1], { url: `${SITE}/explore/screens/${m[1]}`, kind: "screen", app: alt[1], title: alt[2].replace(/^screen containing /, "") });
  }
  return [...examples.values()];
}

/** The candidate from a srcSet closest to WANT_WIDTH without going under it. */
export function pickFromSrcSet(srcSet) {
  const candidates = [];
  const parts = unescape(srcSet).trim().split(/\s+/);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const width = Number.parseInt(parts[i + 1], 10);
    if (parts[i].startsWith("https://") && width) candidates.push({ url: parts[i].replace(/,$/, ""), width });
  }
  candidates.sort((a, b) => a.width - b.width);
  return (candidates.find((c) => c.width >= WANT_WIDTH) ?? candidates.at(-1))?.url ?? null;
}

/**
 * An example page's app and screens. A flow page lists every screen
 * ("Screen 2 of 8 of the <title> flow on the <app> Web app."); a screen
 * page has one, and names its app in the share picture's address.
 */
export function parseExamplePage(page) {
  const title = unescape(/<title>([^<]*)<\/title>/.exec(page)?.[1] ?? "");
  const screens = [];
  for (const m of page.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    const alt = /\balt="([^"]*)"/.exec(tag)?.[1];
    const srcSet = /\bsrc[sS]et="([^"]*)"/.exec(tag)?.[1];
    if (!alt || !srcSet) continue;
    const step = /^Screen (\d+) of \d+ of the .+ flow on the (.+) (?:Web|iOS|Android) app\.?$/.exec(unescape(alt));
    if (step) screens[Number(step[1]) - 1] = { app: step[2], image: pickFromSrcSet(srcSet) };
  }
  if (screens.length > 0) return { app: screens.find(Boolean).app, title, screens: screens.map((s) => s?.image ?? null) };

  const og = unescape(/property="og:image"\s+content="([^"]+)"/.exec(page)?.[1] ?? "");
  const params = og ? new URL(og).searchParams : new URLSearchParams();
  const app = params.get("appName");
  const screenUrl = params.get("screenUrl");
  if (!app || !screenUrl) return null;
  const image = new URL(screenUrl);
  image.searchParams.set("f", "webp");
  image.searchParams.set("w", String(WANT_WIDTH));
  image.searchParams.set("q", "60");
  return { app, title, screens: [image.toString()] };
}

async function get(url) {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

async function topicsCommand(flags) {
  const sitemap = await (await get(`${SITE}/sitemap.xml`)).text();
  const all = parseTopics(sitemap);
  if (all.length === 0) throw new Error(`${SITE}/sitemap.xml lists no topics: Mobbin's sitemap has changed`);
  for (const t of matchTopics(all, flags)) console.log(t);
}

async function browseCommand(topic) {
  if (!topic) throw new Error("browse needs a topic, e.g. web/flows/adding-creating (see `topics`)");
  const url = `${SITE}/explore/${topic.replace(/^\/+|^explore\//g, "")}`;
  const examples = parseTopicPage(await (await get(url)).text());
  if (examples.length === 0) throw new Error(`${url}: no examples could be read; Mobbin's page has changed or the topic is empty`);
  for (const e of examples) console.log(JSON.stringify(e));
}

/** A flow or screen page as Mobbin links it: search results also give /flows/<id> without /explore. */
export function examplePageUrl(url) {
  const m = new RegExp(`^https://(?:www\\.)?mobbin\\.com/(?:explore/)?(flows|screens)/(${ID})/?(?:[?#].*)?$`).exec(url.trim());
  return m ? `${SITE}/explore/${m[1]}/${m[2]}` : null;
}

async function screensCommand(given) {
  const url = given && examplePageUrl(given);
  if (!url) throw new Error(`${given ?? "screens"}: give a Mobbin flow or screen page`);
  const example = parseExamplePage(await (await get(url)).text());
  if (!example) throw new Error(`${url}: no screens could be read; Mobbin's page has changed`);
  console.log(JSON.stringify({ app: example.app, url, title: example.title.replace(/ \| Mobbin$/, ""), screens: example.screens.length }));
}

async function saveCommand(workspace, given, flags) {
  if (!workspace || !given || !flags.as) throw new Error("save needs <workspace> <mobbin url> --as <name>");
  const url = examplePageUrl(given);
  if (!url) throw new Error(`${given} is not a Mobbin flow or screen page`);
  const name = flags.as.replace(/\.webp$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`--as ${flags.as}: use lowercase letters, digits and hyphens`);
  const example = parseExamplePage(await (await get(url)).text());
  if (!example) throw new Error(`${url}: no screens could be read; Mobbin's page has changed`);
  const index = flags.screen ? Number(flags.screen) - 1 : 0;
  const image = example.screens[index];
  if (!image) throw new Error(`${url}: has ${example.screens.length} screen(s), no screen ${index + 1}`);
  const response = await get(image);
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error(`${image}: answered ${type || "no type"}, not an image`);
  const dir = join(resolve(workspace), "public", "references");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.webp`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const repair = repairReferenceServing(resolve(workspace));
  if (repair.changed) console.error(`Updated ${repair.file} to serve reference images added while Vite is running.`);
  console.log(JSON.stringify({ app: example.app, url, image: `references/${name}.webp` }));
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);
  const run = {
    topics: () => topicsCommand(flags),
    browse: () => browseCommand(positional[0]),
    screens: () => screensCommand(positional[0]),
    save: () => saveCommand(positional[0], positional[1], flags),
  }[command];
  if (!run) {
    console.error("usage: mobbin.mjs topics [--platform web|mobile] [--match <words>] | browse <topic> | screens <url> | save <workspace> <url> --as <name> [--screen <n>]");
    process.exit(2);
  }
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
