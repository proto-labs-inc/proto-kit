import { test } from "node:test";
import assert from "node:assert/strict";
import { examplePageUrl, matchTopics, parseExamplePage, parseTopicPage, parseTopics, pickFromSrcSet } from "./mobbin.mjs";

const FLOW = "3b2b6bce-c5ea-4b49-ac26-a789f8d5853f";
const SCREEN = "5195991b-3c07-40b2-84a2-0c81efb79d90";
const CDN = "https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/file.webp?enc=x";

// Trimmed from Mobbin's signed-out pages as they were on 2026-10-07.
const flowCard = `
<a tabindex="-1" class="absolute inset-0" href="/explore/flows/${FLOW}"></a>
<a href="/explore/flows/${FLOW}" class="block"><div class="relative size-full"><img alt="Databricks Creating a table screen" srcSet="${CDN}&amp;w=640 640w, ${CDN}&amp;w=3840 3840w" data-sentry-component="CdnImg"/></div></a>
<a href="/explore/flows/${FLOW}" class="block"><div class="relative size-full"><img alt="Databricks Creating a table screen" srcSet="${CDN} 640w" data-sentry-component="CdnImg"/></div></a>
<div><span>Creating a table</span> <span>on</span> <a href="/signup/modal">Databricks</a></div>
<a href="/explore/web/flows/adding-creating">Adding &amp; Creating</a>`;

const screenCard = `
<a href="/explore/web/screens/invite-teammates">Invite Teammates</a>
<a href="/explore/screens/${SCREEN}" class="block"><div><img crossorigin="anonymous" alt="Better Stack Web Invite Teammates screen" srcSet="${CDN} 640w"/></div></a>`;

test("topics come from the sitemap's explore pages, flows, screens and UI elements only", () => {
  const sitemap = [
    "web/flows/adding-creating",
    "mobile/screens/invite-teammates",
    "web/ui-elements/text-field",
    "sites/sections/sitemap-footer",
    "web/app-categories/ai",
  ].map((p) => `<url><loc>https://mobbin.com/explore/${p}</loc></url>`).join("") + "<url><loc>https://mobbin.com/pricing</loc></url>";
  const topics = parseTopics(sitemap);
  assert.deepEqual(topics, ["web/flows/adding-creating", "mobile/screens/invite-teammates", "web/ui-elements/text-field"]);
  assert.deepEqual(matchTopics(topics, { platform: "web" }), ["web/flows/adding-creating", "web/ui-elements/text-field"]);
  assert.deepEqual(matchTopics(topics, { match: "create a project" }), ["web/flows/adding-creating"]);
  assert.deepEqual(matchTopics(topics, { match: "invite teammates" }), ["mobile/screens/invite-teammates"]);
});

test("a topic page's flows read '<title> on <app>' and its screens read the image's alt", () => {
  assert.deepEqual(parseTopicPage(flowCard + screenCard), [
    { url: `https://mobbin.com/explore/flows/${FLOW}`, kind: "flow", app: "Databricks", title: "Creating a table" },
    { url: `https://mobbin.com/explore/screens/${SCREEN}`, kind: "screen", app: "Better Stack", title: "Invite Teammates" },
  ]);
});

test("a page with no readable examples gives none, so the caller can say Mobbin changed", () => {
  assert.deepEqual(parseTopicPage("<html><body>Sign in</body></html>"), []);
});

test("the srcSet candidate is the narrowest at least 1920 wide, else the widest", () => {
  assert.equal(pickFromSrcSet("https://a/1 640w, https://a/2 2048w, https://a/3 3840w"), "https://a/2");
  assert.equal(pickFromSrcSet("https://a/1 640w, https://a/2 1200w"), "https://a/2");
  assert.equal(pickFromSrcSet(""), null);
});

test("a flow page gives its app and every screen in order", () => {
  const page = `<title>Databricks Web Creating a table Flow | Mobbin</title>
    <img alt="Screen 2 of 2 of the Creating a table flow on the Databricks Web app." srcSet="https://a/2 3024w"/>
    <img alt="Screen 1 of 2 of the Creating a table flow on the Databricks Web app." srcSet="https://a/1 3024w"/>`;
  assert.deepEqual(parseExamplePage(page), {
    app: "Databricks",
    title: "Databricks Web Creating a table Flow | Mobbin",
    screens: ["https://a/1", "https://a/2"],
  });
});

test("a flow or screen link from search becomes its /explore page; anything else is refused", () => {
  assert.equal(examplePageUrl(`https://mobbin.com/flows/${FLOW}`), `https://mobbin.com/explore/flows/${FLOW}`);
  assert.equal(examplePageUrl(`https://mobbin.com/explore/screens/${SCREEN}?utm=x`), `https://mobbin.com/explore/screens/${SCREEN}`);
  assert.equal(examplePageUrl("https://mobbin.com/explore/web/flows/adding-creating"), null);
  assert.equal(examplePageUrl(`https://evil.example/explore/flows/${FLOW}`), null);
});

test("a screen page names its app and picture in the share image's address", () => {
  const og = `https://mobbin.com/api/og/screen?appName=Databricks&amp;appPlatform=web&amp;screenUrl=${encodeURIComponent("https://bytescale.mobbin.com/s.png")}`;
  const page = `<title>Databricks Web Visualization Tooltip | Mobbin</title><meta property="og:image" content="${og}"/>`;
  const example = parseExamplePage(page);
  assert.equal(example.app, "Databricks");
  assert.equal(example.screens.length, 1);
  const image = new URL(example.screens[0]);
  assert.equal(image.origin + image.pathname, "https://bytescale.mobbin.com/s.png");
  assert.equal(image.searchParams.get("w"), "1920");
  assert.equal(parseExamplePage("<title>Mobbin</title>"), null);
});
