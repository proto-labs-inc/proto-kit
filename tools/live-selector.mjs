/**
 * A live element's selector that survives the page changing a little.
 *
 * The survey names an element by its position (`body > div:nth-of-type(3)
 * > … > a:nth-of-type(1)`) when nothing on the way has an id. A position
 * holds only while the page keeps every sibling before it: a flash
 * message shown once after sign-in, a banner dismissed, a reload that
 * drops either, and the same path lands on another element or on none
 * ("nothing on the live page matches …").
 *
 * So when snapshot.mjs reads a state through a positional selector it
 * also records `live.fallback` in component.json: the shortest chain of
 * the element's own tag, classes and steady attributes (anchored at the
 * nearest ancestor with a unique id) that names it alone, with no
 * position in it. check.mjs and explain-diff.mjs resolve each state
 * through `resolveStates`: the recorded selector while it still names
 * the element the fallback names, else the fallback.
 */
import { findPage } from "./cdp/attach.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";

/** Whether a selector names its element by position alone. */
export const positional = (selector) => /:nth-(of-type|child)\(/.test(selector ?? "");

/**
 * Runs in the live page: (selector) => a position-free selector naming
 * the same element alone, or null when the page gives no such handle.
 * Classes a pointer or a script toggles (active, hover, open, in, show,
 * focus, selected, disabled, collapsed) are left out: the element wears
 * them only some of the time.
 */
export const STURDY_SELECTOR = String.raw`(selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const transient = /^(active|hover|focus|focused|open|opened|in|show|shown|selected|current|disabled|collapsed|collapse|expanded|visible|hidden|fade|is-.*|has-.*|ng-.*|js-.*)$/;
  const steadyAttrs = ['data-testid', 'data-test', 'data-id', 'data-role', 'name', 'role', 'aria-label', 'type', 'for', 'href'];
  const step = (e) => {
    if (e.id && document.querySelectorAll('#' + CSS.escape(e.id)).length === 1) return { anchor: true, text: '#' + CSS.escape(e.id) };
    let text = e.tagName.toLowerCase();
    for (const c of e.classList) if (!transient.test(c) && /^[A-Za-z_-][\w-]*$/.test(c)) text += '.' + CSS.escape(c);
    for (const name of steadyAttrs) {
      const value = e.getAttribute(name);
      if (value && value.length <= 60 && !/^javascript:/.test(value)) { text += '[' + name + '=' + JSON.stringify(value) + ']'; break; }
    }
    return { anchor: false, text };
  };
  const names = (sel) => { try { const all = document.querySelectorAll(sel); return all.length === 1 && all[0] === el; } catch { return false; } };
  const chain = [];
  for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
    const s = step(e);
    chain.unshift(s.text);
    const sel = chain.join(' > ');
    if (names(sel)) return sel;
    if (s.anchor) break;
    if (e === document.body) break;
  }
  return null;
}`;

/**
 * Runs in the live page: ({ selector, fallback }) => the selector to
 * use now. The recorded one while it names an element and either no
 * fallback was recorded or the fallback names that same element; the
 * fallback when it names one element and the recorded one names none
 * or another; else the recorded one (its failure is then the honest
 * report).
 */
const RESOLVE = String.raw`({ selector, fallback }) => {
  const first = document.querySelector(selector);
  if (!fallback) return selector;
  let all = [];
  try { all = [...document.querySelectorAll(fallback)]; } catch { return selector; }
  if (all.length !== 1) return selector;
  if (first === all[0]) return selector;
  return fallback;
}`;

/**
 * Each state's `live` as it resolves on the open page now: a copy of
 * `states` whose `live.selector` is the fallback wherever the recorded
 * selector no longer names the element (and `live.recorded` keeps the
 * one it replaced). States with no fallback come back as they are, and
 * so does everything when the page cannot be reached (the pass that
 * follows reports that itself).
 */
export async function resolveStates(states, liveMatch, port = 9333) {
  if (!states.some((s) => s.live?.fallback)) return states;
  let page;
  try {
    const tab = await findPage(liveMatch, port);
    if (!tab) return states;
    page = await connect(tab.webSocketDebuggerUrl);
    const out = [];
    for (const state of states) {
      if (!state.live?.fallback) {
        out.push(state);
        continue;
      }
      const chosen = await evaluate(page, `(${RESOLVE})(${JSON.stringify({ selector: state.live.selector, fallback: state.live.fallback })})`);
      out.push(chosen === state.live.selector ? state : { ...state, live: { ...state.live, selector: chosen, recorded: state.live.selector } });
    }
    return out;
  } catch {
    return states;
  } finally {
    page?.close();
  }
}
