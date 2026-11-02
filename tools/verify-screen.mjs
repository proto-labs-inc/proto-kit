import { hasCompleteAbsenceEvidence } from "./container-applicability.mjs";
/** Execute reference-authored scenarios against an archived compiled build, never the dev server. */
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { resolve, join, extname } from "node:path";
import { headlessPage } from "./cdp/headless.mjs";
import { evaluate } from "./cdp/cdp.mjs";
import { diffPngs } from "./cdp/diff.mjs";
import { createHash } from "node:crypto";
import { SCREEN_RENDER, applyScreenRender, settleForCapture, pngSize, referenceScale } from "./cdp/render-profile.mjs";
import { VERSION, widthsForScenario, interactionBands, resizeOrigin, validateStateInventory, comparisonState } from "./screen-verification.mjs";
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
};
/** The Frame origin each served build may reach, by the build's address. */
const runtimeOrigins = new Map();

/** Where the build's rig fetches its runtime: the Frame origin the build's
 *  prototype.json records (rig 0.3 and later). Null when it records none. */
export function runtimeSource(folder) {
  const manifest = join(folder, "prototype.json");
  if (!existsSync(manifest)) return null;
  const configured = JSON.parse(readFileSync(manifest, "utf8")).frameOrigin;
  if (typeof configured !== "string") return null;
  const url = new URL(configured);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== configured || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)))
    throw new Error(`Invalid frameOrigin in prototype.json: ${configured}`);
  return url.origin;
}

export async function serveBuild(folder) {
  const root = resolve(folder);
  // The build may request only itself and the Frame origin its rig loads the runtime from.
  const runtime = runtimeSource(root);
  const connect = runtime ? `connect-src 'self' ${runtime}` : "connect-src 'self'";
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      res.setHeader(
        "Content-Security-Policy",
        `${connect}; form-action 'self'; object-src 'none'; base-uri 'self'`,
      );
      if (url.pathname === "/__proto_verify_frame") {
        const target = url.searchParams.get("target") || "/";
        if (!target.startsWith("/") || target.startsWith("//"))
          throw new Error("Invalid target");
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<link rel="icon" href="data:,"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style><script>window.messages=[];addEventListener('message',e=>{if(e.source===document.querySelector('iframe')?.contentWindow)messages.push(e.data)})</script><iframe sandbox="allow-scripts allow-same-origin allow-forms"></iframe><script>document.querySelector('iframe').src=${JSON.stringify(target).replace(/</g, "\\u003c")}</script>`,
        );
        return;
      }
      let file = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + "/") && file !== root)
        throw new Error("Invalid path");
      if (!existsSync(file) && !extname(file)) file = join(root, "index.html");
      if (file === root || statSync(file).isDirectory())
        file = join(file, "index.html");
      res.setHeader(
        "Content-Type",
        mime[extname(file)] || "application/octet-stream",
      );
      res.end(readFileSync(file));
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  if (runtime) runtimeOrigins.set(address, runtime);
  return {
    url: address,
    close: () =>
      new Promise((resolve) => {
        runtimeOrigins.delete(address);
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
const inFrame = (expression) =>
  `(()=>{const window=globalThis.document.querySelector('iframe').contentWindow;const document=window.document;const location=window.location;const innerWidth=window.innerWidth;const innerHeight=window.innerHeight;return (${expression})})()`;
const frameScope = (expression) => inFrame(expression);
export async function until(page, expression) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try {
      if (await evaluate(page, expression)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Assertion timed out: ${expression}`);
}
/** Perform one scenario action. `wrap` scopes expressions: the verifier's
 *  iframe by default; prepare-plan.mjs passes an identity wrap for the live source. */
export async function step(page, action, scope = frameScope) {
  const inFrame = scope;
  if (action.kind === "resize-container") {
    if (!Number.isFinite(action.width) || action.width < 1 || action.width > 10000)
      throw new Error("Invalid container width");
    await evaluate(page, inFrame(`(()=>{const element=document.querySelector(${JSON.stringify(action.selector)});if(!element)throw Error('Missing query container');for(const property of ['width','min-width','max-width'])element.style.setProperty(property,${JSON.stringify(String(action.width) + "px")},'important')})()`));
    await evaluate(page, inFrame(`new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve)))`));
  } else if (action.kind === "assert") {
    if (typeof action.expression !== "string" || !action.expression.trim())
      throw new Error("Missing assertion");
    await until(page, inFrame(action.expression));
  } else if (action.kind === "click") {
    await evaluate(page, inFrame(`(()=>{const e=document.querySelector(${JSON.stringify(action.selector)});if(!e)throw Error('Missing control');if(!e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))throw Error('Control is not visible');e.scrollIntoView({block:'center',inline:'center',behavior:'instant'})})()`));
    await evaluate(page, inFrame("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"));
    const rect = await evaluate(
      page,
      inFrame(
        `(()=>{const e=document.querySelector(${JSON.stringify(action.selector)});if(!e)throw Error('Missing control');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      ),
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...rect,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...rect,
    });
  } else if (action.kind === "key") {
    if (action.until !== undefined) {
      if (action.key !== "Tab" || typeof action.until !== "string" || !action.until.trim())
        throw new Error("Keyboard target needs Tab and a selector");
      for (let pressed = 0; pressed < 150; pressed++) {
        if (await evaluate(page, inFrame(`document.activeElement?.matches(${JSON.stringify(action.until)})`))) return;
        await step(page, {kind:"key",key:"Tab",shift:action.shift}, scope);
      }
      throw new Error("Control is not reachable by keyboard: " + action.until);
    }
    const codes = {
      Tab: 9,
      Enter: 13,
      Escape: 27,
      " ": 32,
      ArrowDown: 40,
      ArrowUp: 38,
      ArrowLeft: 37,
      ArrowRight: 39,
    };
    if (!(action.key in codes)) throw new Error("Unsupported key");
    const params = {
      key: action.key,
      code: action.key === " " ? "Space" : action.key,
      windowsVirtualKeyCode: codes[action.key],
      modifiers: action.shift ? 8 : 0,
    };
    let text = "";
    if (action.key === "Enter") text = "\r";
    else if (action.key === " ") text = " ";
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...params,
      text,
      unmodifiedText: text,
    });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  } else if (action.kind === "type")
    await page.send("Input.insertText", { text: action.text });
  else throw new Error("Unknown scenario action");
}

/** Runs inside the copied screen. Intentional scroll regions are allowed;
 * hidden/clip ancestors must not silently cut off usable controls. */
export function layoutProblems(window) {
  const { document, innerWidth, innerHeight } = window;
  const errors = [];
  if (document.documentElement.scrollWidth > innerWidth + 1)
    errors.push("Horizontal page overflow");
  for (const element of document.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="dialog"],[role="menu"]')) {
    if (element.closest('[inert],[aria-hidden="true"]')) continue;
    if (!element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const label = element.id || element.getAttribute("aria-label") || element.tagName;
    let scrollX = false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      let bounds = parent.getBoundingClientRect();
      // Root overflow locks the viewport, not the scrolled body's layout box.
      // A viewport-fixed portal therefore remains visible after its trigger scrolls.
      if (parent === document.body || parent === document.documentElement) {
        let fixed = false;
        let contained = false;
        for (let node = element; node && node !== parent; node = node.parentElement) {
          const nodeStyle = window.getComputedStyle(node);
          if (fixed && ((nodeStyle.transform && nodeStyle.transform !== "none") ||
              (nodeStyle.filter && nodeStyle.filter !== "none") ||
              /layout|paint|strict|content/.test(nodeStyle.contain || ""))) contained = true;
          if (nodeStyle.position === "fixed") fixed = true;
        }
        if (fixed && !contained) bounds = {left:0,top:0,right:innerWidth,bottom:innerHeight};
      }
      if (["auto", "scroll"].includes(style.overflowX)) scrollX = true;
      if (["hidden", "clip"].includes(style.overflowX) &&
          (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) && !scrollX)
        errors.push("Control clipped by ancestor: " + label);
      if (["hidden", "clip"].includes(style.overflowY) &&
          (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)) {
        // A nested vertical scroll area makes its content reachable.
        let reachable = false;
        for (let ancestor = element.parentElement; ancestor !== parent; ancestor = ancestor.parentElement)
          if (["auto", "scroll"].includes(window.getComputedStyle(ancestor).overflowY)) reachable = true;
        if (!reachable) errors.push("Control clipped vertically by ancestor: " + label);
      }
    }
    if (!scrollX && (rect.left < -1 || rect.right > innerWidth + 1))
      errors.push("Clipped control: " + label);
    if (element.matches('[role="dialog"],[role="menu"]') &&
        (rect.top < -1 || rect.bottom > innerHeight + 1))
      errors.push("Clipped overlay: " + label);
  }
  return [...new Set(errors)];
}

/** A scenario replaces the plan profile; an empty object restores normal motion. */
export function captureProfileFor(plan = {}, scenario = {}) {
  let profile = plan.capture;
  if (scenario.capture !== undefined) profile = scenario.capture;
  if (profile === undefined) profile = {};
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    throw new Error("Capture profile must be an object");
  for (const key of Object.keys(profile))
    if (!["reducedMotion", "animationTimeMs", "videoTimeMs"].includes(key))
      throw new Error("Unknown capture profile option: " + key);
  if (profile.reducedMotion !== undefined && !["reduce", "no-preference"].includes(profile.reducedMotion))
    throw new Error("Capture reducedMotion must be reduce or no-preference");
  if (profile.animationTimeMs !== undefined && (!Number.isFinite(profile.animationTimeMs) || profile.animationTimeMs < 0))
    throw new Error("Capture animationTimeMs must be a finite nonnegative number");
  if (profile.videoTimeMs !== undefined && (!Number.isFinite(profile.videoTimeMs) || profile.videoTimeMs < 0))
    throw new Error("Capture videoTimeMs must be a finite nonnegative number");
  return { ...profile };
}

/** Apply before navigation so source scripts see the native media preference. */
export async function applyCaptureMedia(page, profile) {
  if (profile.reducedMotion !== undefined)
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: profile.reducedMotion }],
    });
}

/** Runs in either source or copied document, only for a declared sampled snapshot. */
export function sampleAnimations(document, timeMs) {
  const animations = document.getAnimations();
  for (const animation of animations) {
    animation.pause();
    animation.currentTime = timeMs;
  }
  return animations.length;
}

/** Sample original video frames identically in source and copy; no raster replacement. */
export async function sampleVideos(document, timeMs) {
  const videos = [...document.querySelectorAll("video")];
  for (const video of videos) {
    if (!video.currentSrc && !video.src) continue;
    const waitFor = (event, ready) => new Promise((resolve, reject) => {
      if (ready()) { resolve(); return; }
      const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener("error", fail); };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error("Video capture could not load or seek")); };
      const timer = setTimeout(fail, 10000);
      video.addEventListener(event, done, {once:true});
      video.addEventListener("error", fail, {once:true});
    });
    await waitFor("loadeddata", () => video.readyState >= 2);
    video.pause();
    const target = timeMs / 1000;
    if (Number.isFinite(video.duration) && target > video.duration)
      throw new Error("Video capture time exceeds duration");
    if (Math.abs(video.currentTime - target) > 0.0001) {
      video.currentTime = target;
      await waitFor("seeked", () => !video.seeking);
    }
  }
  return videos.length;
}

export async function runScenario(
  url,
  scenario,
  out,
  viewport,
  screenshotReference,
  captureMetadata = {},
  inventory,
) {
  const capture = captureProfileFor({}, scenario);
  captureMetadata.profile = capture;
  const responsive = scenario.category === "responsive";
  const origin = { ...viewport, width: resizeOrigin(viewport.width) };
  // Drawn as reference.mjs draws the source (render-profile.mjs): 1x, no
  // scrollbars. A reference taken before that at a whole multiple of the
  // viewport (2x on a Retina window) is still compared at its own scale.
  let referenceSize = null;
  if (screenshotReference && existsSync(screenshotReference)) {
    try { referenceSize = pngSize(readFileSync(screenshotReference)); } catch {}
  }
  const dpr = (referenceSize && referenceScale(referenceSize, viewport)) || SCREEN_RENDER.dpr;
  captureMetadata.render = { ...SCREEN_RENDER, dpr };
  const opened = await headlessPage("about:blank", responsive ? origin : viewport);
  const page = opened.page;
  const problems = [];
  try {
    await applyScreenRender(page, responsive ? { ...origin, dpr } : { ...viewport, dpr });
    await applyCaptureMedia(page, capture);
    // Match the visible source session: visibility-gated animation and rAF
    // must keep advancing even while another browser window has focus.
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Page.enable");
    await page.send("Log.enable");
    page.on("Log.entryAdded", ({ entry }) => {
      if (entry.level === "error") problems.push(entry.text);
    });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        "window.__protoVerificationViolations=[];addEventListener('securitypolicyviolation',event=>window.__protoVerificationViolations.push(event.blockedURI))",
    });
    page.on("Runtime.exceptionThrown", (e) =>
      problems.push(e.exceptionDetails?.text || "Runtime error"),
    );
    page.on("Network.loadingFailed", (e) => {
      // Resizing a srcset can cancel an obsolete candidate. The selected image
      // is checked below; blocked requests and actual load failures still fail.
      if (e.type === "Image" && e.canceled && !e.blockedReason) return;
      problems.push(e.blockedReason ? `Blocked request: ${e.blockedReason}` : e.errorText);
    });
    page.on("Network.webSocketCreated", () =>
      problems.push("Live WebSocket connection is not allowed"),
    );
    await page.send("Network.setBypassServiceWorker", { bypass: true });
    page.on("Network.responseReceived", (e) => {
      if (e.response.status >= 400)
        problems.push(`Asset failed: ${e.response.status}`);
    });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    page.on("Fetch.requestPaused", (e) => {
      const address = new URL(e.request.url);
      let operation;
      if (
        address.origin === new URL(url).origin ||
        address.origin === runtimeOrigins.get(new URL(url).origin) ||
        ["data:", "blob:"].includes(address.protocol)
      )
        operation = page.send("Fetch.continueRequest", {
          requestId: e.requestId,
        });
      else {
        problems.push(`External request blocked: ${address.origin}`);
        operation = page.send("Fetch.failRequest", {
          requestId: e.requestId,
          errorReason: "BlockedByClient",
        });
      }
      operation.catch((error) => problems.push(error.message));
    });
    page.on("Page.windowOpen", () =>
      problems.push("Navigation opened another window"),
    );
    const path = scenario.path || "/";
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Scenario paths must be local");
    const frameUrl =
      url + "/__proto_verify_frame?target=" + encodeURIComponent(path);
    await page.send("Page.navigate", { url: frameUrl });
    await until(
      page,
      inFrame(
        `document.readyState === 'complete' && !!document.body?.innerText.trim()`,
      ),
    );
    await until(page, `window.messages?.some(m=>m.type==='hello')`);
    if (scenario.category === "keyboard") {
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await evaluate(
        page,
        "document.querySelector('iframe').contentWindow.focus()",
      );
    }
    const resize = async (width) => {
      await applyScreenRender(page, { width, height: viewport.height, dpr });
      await until(page, inFrame(`innerWidth === ${width}`));
      await evaluate(page, inFrame(`new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve)))`));
    };
    if (responsive) await resize(viewport.width);
    await evaluate(page, inFrame("document.fonts.ready"));
    const settleMotion = () => until(page, inFrame("document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running')"));
    await settleMotion();
    for (const action of scenario.steps || []) {
      await step(page, action);
      await settleMotion();
    }
    await step(page, { kind: "assert", expression: scenario.assertion });
    if (responsive) {
      // Keep the same document and state: reloads conceal mount-only layout logic.
      await resize(origin.width);
      await resize(viewport.width);
      await step(page, { kind: "assert", expression: scenario.assertion });
    }
    if (scenario.category === "state") {
      const current = await evaluate(
        page,
        inFrame("location.pathname+location.search+location.hash"),
      );
      await page.send("Page.navigate", {
        url:
          url + "/__proto_verify_frame?target=" + encodeURIComponent(current),
      });
      await until(page, `window.messages?.some(m=>m.type==='hello')`);
      await step(page, { kind: "assert", expression: scenario.assertion });
      await page.send("Page.reload");
      await until(page, `window.messages?.some(m=>m.type==='hello')`);
      await step(page, { kind: "assert", expression: scenario.assertion });
    }
    await settleMotion();
    await evaluate(
      page,
      inFrame(
        `document.fonts.ready.then(()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))))`,
      ),
    );
    await until(page, inFrame(`Array.from(document.images).every(image => {
      const rect=image.getBoundingClientRect();
      const visible=image.checkVisibility() && rect.bottom>0 && rect.top<innerHeight && rect.right>0 && rect.left<innerWidth;
      return !visible || image.complete;
    })`));
    const failedImages = await evaluate(page, inFrame(`Array.from(document.images).filter(image => image.complete && image.currentSrc && image.naturalWidth===0).map(image => image.getAttribute('alt') || image.getAttribute('src'))`));
    problems.push(...failedImages.map(src => "Image failed to decode: " + src));
    captureMetadata.reducedMotion = await evaluate(page, inFrame(
      "window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'",
    ));
    if (capture.animationTimeMs !== undefined) {
      captureMetadata.sampledAnimations = await evaluate(page, inFrame(
        `(${sampleAnimations.toString()})(document, ${capture.animationTimeMs})`,
      ));
      await evaluate(page, inFrame(
        "new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve)))",
      ));
    }
    if (capture.videoTimeMs !== undefined) {
      captureMetadata.sampledVideos = await evaluate(page, inFrame(`(${sampleVideos.toString()})(document, ${capture.videoTimeMs})`));
      await evaluate(page, inFrame("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"));
    }
    const geometry = await evaluate(
      page,
      inFrame(
        `(${layoutProblems.toString()})(window)`,
      ),
    );
    problems.push(...geometry);
    const violations = await evaluate(
      page,
      inFrame("window.__protoVerificationViolations || []"),
    );
    problems.push(
      ...violations.map((uri) => `External request blocked: ${uri}`),
    );
    await settleForCapture(page, evaluate, inFrame);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    if (["visual", "responsive"].includes(scenario.category)) {
      const state = inventory ? comparisonState(inventory, scenario) : { kind: "source" };
      if (state.kind === "prototype-boundary") return problems;
      if (!screenshotReference) throw new Error("Missing reference screenshot");
      const diff = await diffPngs(screenshotReference, out, { dpr });
      if (
        diff.sizeReal[0] !== diff.sizeMine[0] ||
        diff.sizeReal[1] !== diff.sizeMine[1]
      )
        problems.push(`Reference viewport dimensions do not match: the reference is ${diff.sizeReal.join("x")} px, the copy ${diff.sizeMine.join("x")} px (viewport ${viewport.width}x${viewport.height} CSS px). Recapture the reference with tools/cdp/reference.mjs at --widths ${viewport.width} --height ${viewport.height}; do not resize or pad it.`);
      if (parseFloat(diff.pct) > 1)
        problems.push(`Visual mismatch: ${diff.pct} (maximum 1%)`);
    }
  } catch (error) {
    problems.push(error.message);
    try {
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(out, Buffer.from(shot.data, "base64"));
    } catch {}
  } finally {
    // The result is already recorded; a tab whose connection closed while
    // closing (the flake that used to abort a whole sweep) changes nothing.
    await opened.close().catch(() => {});
  }
  return problems;
}
export function validateResponsivePlan(plan) {
  const css = plan?.responsiveCss;
  if (!css || css.sourceUrl !== plan.inventory?.sourceUrl || !Array.isArray(css.breakpoints))
    throw new Error("Supply the responsive-css report from the live source page.");
  if (css.breakpoints.some(boundary => !plan.inventory.breakpoints.includes(boundary)))
    throw new Error("The inventory omits a compiled CSS breakpoint.");
  for (const finding of [...(css.warnings || []), ...(css.unresolved || [])])
    if (!plan.responsiveCssReview?.[finding]?.trim())
      throw new Error("Inspect and document unresolved CSS: " + finding);
  for (const query of css.containerQueries || []) {
    if (hasCompleteAbsenceEvidence(plan, query)) continue;
    const scenarios = plan.scenarios.filter(s => s.category === "responsive" && s.containerQuery === query.condition
      && plan.inventory.states.some(state => state.id === s.target && state.kind === "source"));
    if (!scenarios.some(s => s.steps?.some(step => step.kind === "resize-container")))
      throw new Error("Add explicit container-size scenarios for " + query.condition);
  }
}
export function validateMapStates(manifest, inventory) {
  for (const state of manifest.states || []) {
    const declared = inventory.states.find(entry => entry.id === state.id);
    if (!declared) throw new Error(`Missing declared state: ${state.id}`);
    if (declared.kind === "prototype-boundary")
      throw new Error(`Prototype boundary ${state.id} must not appear in prototype.json states (the state map). Keep it in the verification inventory only.`);
  }
}

const CATEGORIES = ["visual", "interaction", "keyboard", "responsive", "state", "isolation"];

/** Pages verified at once. Each scenario still gets its own fresh tab and window. */
export function verifyConcurrency(value = process.env.PROTO_VERIFY_CONCURRENCY) {
  if (value === undefined || value === "") return 6;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 32)
    throw new Error("PROTO_VERIFY_CONCURRENCY must be a whole number from 1 to 32.");
  return count;
}

/** Run `work` over `items` with at most `limit` in flight; results keep item order. */
export async function inPool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** JSON with sorted keys, so one plan hashes the same however it was written. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** The runner's own code: a kit update that changes how checks run invalidates every checkpoint. */
let runnerChecksum;
function runner() {
  runnerChecksum ??= sha(["./verify-screen.mjs", "./screen-verification.mjs", "./cdp/diff.mjs", "./cdp/render-profile.mjs"]
    .map(file => readFileSync(new URL(file, import.meta.url))).reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0)));
  return runnerChecksum;
}
/** One check's identity: the build, the scenario as run, its width and reference, the inventory it is judged against. */
export function checkpointKey({ sourceChecksum, buildChecksum, inventory, scenario, viewport, reference }) {
  const referenceChecksum = reference && existsSync(reference) ? sha(readFileSync(reference)) : null;
  return sha(stable({ runner: runner(), sourceChecksum, buildChecksum, inventory, scenario, viewport, referenceChecksum }));
}
/** A passed result saved earlier for exactly this check, with its evidence still on disk and unchanged. */
function resumed(file, key) {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.key !== key || saved.result?.outcome !== "passed"
        || !saved.result.evidence.every(path => path in saved.evidence)) return null;
    for (const [path, checksum] of Object.entries(saved.evidence))
      if (!existsSync(path) || sha(readFileSync(path)) !== checksum) return null;
    return saved.result;
  } catch {
    return null;
  }
}

/** One scenario at one width. A failure is run again once on its own, so a
 *  renderer hiccup (screenshot timeout, closed target) does not fail the build;
 *  both outcomes are kept. A check that passes on retry counts as passed. */
export async function checkWithRetry(run) {
  const attempt = async () => {
    try {
      return await run();
    } catch (error) {
      return [error.message];
    }
  };
  const first = await attempt();
  if (!first.length) return { problems: first };
  const second = await attempt();
  return {
    problems: second,
    attempts: [
      { outcome: "failed", problems: first },
      { outcome: second.length ? "failed" : "passed", problems: second },
    ],
  };
}

// An assertion that cannot fail does not verify an outcome.
const TRIVIAL = new Set(["true", "1", "!0", "!!1", "!false", "document", "!!document", "document.body", "!!document.body",
  "window", "!!window", "location", "!!location", "document.readyState==='complete'", 'document.readyState==="complete"']);
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Problems that make a plan unfit to run: placeholders, interaction checks
 *  without an outcome, invalid expressions and pointer-driven keyboard checks. */
export function assertionProblems(plan) {
  const problems = [];
  const placeholder = (value) => JSON.stringify(value ?? "").includes("TODO");
  for (const control of plan?.inventory?.controls || [])
    if (placeholder(control.expected)) problems.push(`Describe the expected outcome of control ${control.id}`);
  for (const [finding, review] of Object.entries(plan?.responsiveCssReview || {}))
    if (placeholder(review)) problems.push(`Review the CSS finding ${finding}`);
  for (const scenario of plan?.scenarios || []) {
    const name = scenario.id || "(unnamed scenario)";
    const expressions = [scenario.assertion, ...(scenario.steps || []).filter(s => s.kind === "assert").map(s => s.expression)];
    if (placeholder(scenario.assertion) || placeholder(scenario.steps) || placeholder(scenario.path))
      problems.push(`Replace the TODO in scenario ${name}`);
    for (const expression of expressions) {
      if (typeof expression !== "string" || !stripComments(expression).trim()) { problems.push(`Scenario ${name} needs an assertion`); continue; }
      if (expression.includes("TODO")) continue;
      try { new Function(`return (${expression});`); }
      catch (error) { problems.push(`Scenario ${name} has an invalid assertion: ${error.message}`); }
    }
    if (["interaction", "keyboard"].includes(scenario.category)) {
      if (!scenario.steps?.length) problems.push(`Control scenario ${name} needs executable actions`);
      const outcome = stripComments(String(scenario.assertion || "")).replace(/\s+/g, "");
      if (TRIVIAL.has(outcome)) problems.push(`Control scenario ${name} must assert the control's visible outcome, not ${scenario.assertion}`);
    }
    if (scenario.category === "keyboard" && (!scenario.steps?.some(s => s.kind === "key") || scenario.steps.some(s => s.kind === "click")))
      problems.push(`Keyboard scenario ${name} must use keyboard input only`);
  }
  return [...new Set(problems)];
}

/** Every check a plan asks for: each scenario at each width its category
 *  needs (widthsForScenario), width-major then plan order, so the report
 *  order is the same however many checks run at once. `only` (scenario ids
 *  or a RegExp) and `widths` narrow it for local runs. */
export function planJobs(plan, { only, widths } = {}) {
  const wanted = (scenario) => !only || (only instanceof RegExp ? only.test(scenario.id) : only.includes(scenario.id));
  const jobs = plan.scenarios
    .filter(wanted)
    .flatMap((scenario, order) => widthsForScenario(plan.inventory, scenario)
      .filter(width => !widths || widths.includes(width))
      .map(width => ({ scenario, order, width, id: `${scenario.id}-${width}` })))
    .sort((a, b) => a.width - b.width || a.order - b.order);
  for (const { scenario, id } of jobs) {
    if (!CATEGORIES.includes(scenario.category)) throw new Error("Unknown scenario category");
    if (["interaction", "keyboard"].includes(scenario.category) && !scenario.steps?.length)
      throw new Error("Controls need executable actions");
    if (scenario.category === "keyboard" &&
        (!scenario.steps.some((s) => s.kind === "key") || scenario.steps.some((s) => s.kind === "click")))
      throw new Error("Keyboard checks must use keyboard input");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Scenario IDs must be safe filenames");
  }
  return jobs;
}

/** Run a plan's checks against a compiled build: the one loop behind both
 *  `screen-index.mjs verify` (verifyBuild) and `prepare-plan.mjs run`.
 *  At most `concurrency` pages at once (PROTO_VERIFY_CONCURRENCY), each check
 *  in a fresh tab, a failing check retried once (both attempts recorded, the
 *  first try's screenshot kept as <id>.first-try.png). With `checkpoint`
 *  ({ sourceChecksum, buildChecksum }) every finished check is saved under
 *  <output>/checkpoints and a passed one is not run again for the same
 *  build, plan, reference and runner. `bail` stops starting checks after the
 *  first failure; `onResult` sees each result as it finishes. */
export async function runPlan(folder, plan, output, { only, widths, bail = false, concurrency, lanes, checkpoint, onResult, runScenario: run = runScenario } = {}) {
  const jobs = planJobs(plan, { only, widths });
  mkdirSync(output, { recursive: true });
  const checkpoints = join(output, "checkpoints");
  if (checkpoint) mkdirSync(checkpoints, { recursive: true });
  const limit = concurrency ?? lanes ?? verifyConcurrency();
  const server = await serveBuild(folder);
  let failed = false;
  try {
    const results = await inPool(jobs, limit, async ({ scenario, width, id }) => {
      if (bail && failed) return null;
      const viewport = { width, height: plan.height || 900 };
      const evidence = join(output, id + ".png");
      const reference = scenario.references?.[width];
      const effective = { ...scenario, capture: captureProfileFor(plan, scenario) };
      const compared = ["visual", "responsive"].includes(scenario.category)
        && comparisonState(plan.inventory, scenario).kind === "source";
      const key = checkpoint && checkpointKey({ ...checkpoint, inventory: plan.inventory, scenario: effective, viewport, reference });
      const file = join(checkpoints, `${id}.json`);
      const saved = checkpoint && resumed(file, key);
      if (saved) {
        const result = { ...saved, resumed: true };
        onResult?.(result, jobs.length);
        return result;
      }
      const capture = {};
      let tries = 0;
      const { problems, attempts } = await checkWithRetry(async () => {
        // Keep the failed first try's screenshot beside the retry's.
        if (tries++ && existsSync(evidence)) copyFileSync(evidence, join(output, id + ".first-try.png"));
        for (const name of Object.keys(capture)) delete capture[name];
        return run(server.url, effective, evidence, viewport, reference, capture, plan.inventory);
      });
      if (problems.length) failed = true;
      const result = {
        id,
        category: scenario.category,
        target: scenario.target,
        viewport,
        capture,
        ...(scenario.category === "responsive" ? { resizedFrom: resizeOrigin(width) } : {}),
        outcome: problems.length ? "failed" : "passed",
        problems,
        ...(attempts ? { attempts } : {}),
        evidence: compared ? [evidence, reference].filter(Boolean) : [evidence],
      };
      if (checkpoint) {
        const hashes = {};
        for (const path of result.evidence) if (existsSync(path)) hashes[path] = sha(readFileSync(path));
        writeFileSync(file, JSON.stringify({ key, result, evidence: hashes }, null, 2));
      }
      onResult?.(result, jobs.length);
      return result;
    });
    return results.filter(Boolean);
  } finally {
    await server.close();
  }
}

/** Everything that refuses a plan before any page opens. */
export function preflightPlan(folder, plan) {
  if (!plan?.inventory || !Array.isArray(plan.scenarios))
    throw new Error("Supply the reference inventory and executable scenarios");
  validateStateInventory(plan.inventory);
  validateResponsivePlan(plan);
  interactionBands(plan.inventory);
  const problems = assertionProblems(plan);
  if (problems.length) throw new Error("The verification plan is incomplete:\n- " + problems.join("\n- "));
  captureProfileFor(plan);
  for (const scenario of plan.scenarios) captureProfileFor(plan, scenario);
  const manifest = JSON.parse(readFileSync(join(folder, "prototype.json"), "utf8"));
  if (manifest.viewport)
    throw new Error("Responsive starters must not fix the Frame viewport.");
  validateMapStates(manifest, plan.inventory);
}

export async function verifyBuild(folder, plan, screen, output, options = {}) {
  preflightPlan(folder, plan);
  const sourceChecksum = screen.bundle_checksum;
  const buildChecksum = screen.metadata.preparedBuild.checksum;
  const scenarios = await runPlan(folder, plan, output, {
    concurrency: options.concurrency,
    runScenario: options.runScenario,
    checkpoint: { sourceChecksum, buildChecksum },
  });
  const report = {
    version: VERSION,
    sourceChecksum,
    buildChecksum,
    inventory: plan.inventory,
    scenarios,
  };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
export async function smokeBuild(folder, state = {}) {
  const server = await serveBuild(folder);
  const path = "/";
  try {
    const problems = await runScenario(
      server.url,
      {
        path,
        category: "smoke",
        assertion: `${JSON.stringify(Object.entries(state))}.every(([key,value])=>new URLSearchParams(location.search).get(key)===value)`,
      },
      join(folder, "..", ".proto-smoke.png"),
      { width: 1440, height: 900 },
    );
    if (problems.length)
      throw new Error(
        "Copied starter failed its load check: " + problems.join("; "),
      );
  } finally {
    await server.close();
  }
}
