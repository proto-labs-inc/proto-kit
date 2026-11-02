import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadEvidence, evidenceRecord, withRetry, isTransient } from "./evidence-upload.mjs";
import { callTool } from "./mcp-call.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** A stand-in for the Proto site: /api/mcp answers screen_index capture
 *  with the server's checksum-named key and a signed URL, /blob/<key>
 *  stores PUT bytes. `failures` makes the first N calls of a kind fail. */
async function mockSite({ latency = 0, failures = {} } = {}) {
  const site = { blobs: new Map(), signs: [], puts: [], inFlight: 0, peak: 0, failures: { ...failures } };
  const fail = (kind) => (site.failures[kind] > 0 ? (site.failures[kind]--, true) : false);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    site.inFlight++;
    site.peak = Math.max(site.peak, site.inFlight);
    await new Promise((r) => setTimeout(r, latency));
    site.inFlight--;
    if (req.url === "/api/mcp") {
      const message = JSON.parse(body);
      if (message.method === "initialize")
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      if (fail("sign")) return (res.statusCode = 503), res.end("busy");
      const args = message.params.arguments;
      site.signs.push(args);
      const key = `screen-indexes/${args.indexId}/${args.checksum}.png`;
      const text = JSON.stringify({ key, uploadUrl: `${site.url}/blob/${key}` });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } }));
    }
    if (req.method === "PUT" && req.url.startsWith("/blob/")) {
      if (fail("put")) return (res.statusCode = 502), res.end();
      if (fail("forbidden")) return (res.statusCode = 403), res.end();
      site.puts.push(req.url);
      site.blobs.set(req.url.slice(6), body);
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  site.url = `http://127.0.0.1:${server.address().port}`;
  site.close = () => new Promise((r) => server.close(r));
  return site;
}

/** Real kit client against the mock: the same call screen-index.mjs makes. */
function signer(site, indexId = "idx") {
  process.env.PROTO_APP = site.url;
  process.env.PROTO_TOKEN = "test-token";
  return async (checksum, size) => {
    const result = await callTool("screen_index", { operation: "capture", indexId, checksum, size, codebase: "demo" });
    const text = result.content.map((c) => c.text).join("\n");
    return JSON.parse(text);
  };
}

/** The old upload: every path signed and PUT one after another. */
async function sequential(scenarios, sign) {
  for (const scenario of scenarios) {
    const keys = [];
    for (const path of scenario.evidence) {
      const file = readFileSync(path);
      const capture = await sign(sha(file), file.length);
      const r = await fetch(capture.uploadUrl, { method: "PUT", body: file });
      assert.ok(r.ok);
      keys.push(capture.key);
    }
    scenario.evidence = keys;
  }
}

/** A report like verify writes: per scenario and width a copy PNG, and for
 *  visual scenarios the shared reference of that width. */
function fixture(t, { scenarios = 6, widths = [390, 1280] } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "proto-evidence-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const png = (name, content) => {
    const path = join(folder, name);
    writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(content)]));
    return path;
  };
  const report = [];
  for (const width of widths) {
    const reference = png(`reference-${width}.png`, `reference ${width}`);
    for (let i = 0; i < scenarios; i++) {
      // Scenario 0 and 1 draw the same pixels: identical copies.
      const copy = png(`s${i}-${width}.png`, `copy ${i < 2 ? 0 : i} ${width}`);
      report.push({ id: `s${i}-${width}`, evidence: i % 2 === 0 ? [copy, reference] : [copy] });
    }
  }
  return { folder, report, clone: () => report.map((s) => ({ ...s, evidence: [...s.evidence] })) };
}

test("evidence gets exactly the keys and bytes the one-at-a-time upload produced, each distinct file once", async (t) => {
  const { report, clone } = fixture(t);
  const before = await mockSite();
  t.after(before.close);
  const old = clone();
  await sequential(old, signer(before));

  const after = await mockSite();
  t.after(after.close);
  const fresh = clone();
  const sent = await uploadEvidence(fresh, { sign: signer(after) });

  assert.deepEqual(fresh.map((s) => s.evidence), old.map((s) => s.evidence));
  assert.deepEqual([...after.blobs.keys()].sort(), [...before.blobs.keys()].sort());
  for (const [key, bytes] of after.blobs) {
    assert.ok(before.blobs.get(key).equals(bytes));
    assert.equal(key, `screen-indexes/idx/${sha(bytes)}.png`);
  }
  const named = report.flatMap((s) => s.evidence);
  const distinct = new Set(named.map((p) => sha(readFileSync(p)))).size;
  assert.equal(before.puts.length, named.length);
  assert.equal(after.puts.length, distinct);
  assert.equal(after.signs.length, distinct);
  assert.equal(sent.distinct, distinct);
  assert.ok(distinct < named.length, "the fixture has duplicates");
});

test("signing and uploading run in parallel, bounded by the concurrency limit", async (t) => {
  const { clone } = fixture(t, { scenarios: 40 });
  const site = await mockSite({ latency: 30 });
  t.after(site.close);
  await uploadEvidence(clone(), { sign: signer(site), concurrency: 8 });
  assert.ok(site.peak > 1, `peak ${site.peak}`);
  assert.ok(site.peak <= 8, `peak ${site.peak}`);
});

test("transient sign and PUT failures are retried; the same keys come out", async (t) => {
  const { clone } = fixture(t);
  const site = await mockSite({ failures: { sign: 3, put: 3 } });
  t.after(site.close);
  const fresh = clone();
  const sleeps = [];
  await uploadEvidence(fresh, { sign: signer(site), sleep: async (ms) => sleeps.push(ms) });
  assert.equal(site.failures.sign, 0);
  assert.equal(site.failures.put, 0);
  assert.ok(sleeps.length >= 6);
  for (const key of fresh.flatMap((s) => s.evidence)) assert.ok(site.blobs.has(key));
});

test("a refused PUT is not retried and fails the upload", async (t) => {
  const { clone } = fixture(t, { scenarios: 1, widths: [390] });
  const site = await mockSite({ failures: { forbidden: 1 } });
  t.after(site.close);
  let sleeps = 0;
  await assert.rejects(
    uploadEvidence(clone(), { sign: signer(site), concurrency: 1, sleep: async () => sleeps++ }),
    /Artifact upload failed \(403\)/,
  );
  assert.equal(sleeps, 0);
});

test("retries give up after the attempt limit", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; const e = new Error("down"); e.status = 503; throw e; }, { attempts: 3, sleep: async () => {} }),
    /down/,
  );
  assert.equal(calls, 3);
  assert.equal(isTransient(new Error("This laptop's Proto credential no longer works")), false);
  assert.equal(isTransient(new TypeError("fetch failed")), true);
});

test("evidence this laptop already uploaded to the index is not signed or uploaded again", async (t) => {
  const { folder, clone } = fixture(t);
  const site = await mockSite();
  t.after(site.close);
  const recordPath = join(folder, "uploaded-evidence.json");
  const first = evidenceRecord(recordPath, site.url, "idx");
  const firstReport = clone();
  const sent = await uploadEvidence(firstReport, { sign: signer(site), known: first.known });
  first.save(sent.uploaded);
  const signs = site.signs.length;

  const second = evidenceRecord(recordPath, site.url, "idx");
  const again = clone();
  const resent = await uploadEvidence(again, { sign: signer(site), known: second.known });
  assert.equal(site.signs.length, signs);
  assert.equal(resent.skipped.length, sent.distinct);
  assert.deepEqual(again.map((s) => s.evidence), firstReport.map((s) => s.evidence));

  // Another index or another site starts from nothing; forgetting clears.
  assert.deepEqual(evidenceRecord(recordPath, site.url, "other").known, {});
  assert.deepEqual(evidenceRecord(recordPath, "https://elsewhere", "idx").known, {});
  second.save({}, resent.skipped);
  assert.deepEqual(evidenceRecord(recordPath, site.url, "idx").known, {});
});
