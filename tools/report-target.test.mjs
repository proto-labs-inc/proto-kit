import { test } from "node:test";
import assert from "node:assert/strict";
import { reportTarget, REPORT_APP } from "./report-target.mjs";

test("reports use the hosted service independently of the product endpoint", () => {
  for (const app of ["http://localhost:3000", "https://preview.example.com", REPORT_APP]) {
    const config = { app, credentials: [{ secret: "existing-laptop-token" }] };
    assert.deepEqual(reportTarget(undefined, config, ""), { app: REPORT_APP, secret: "existing-laptop-token" });
    assert.equal(config.app, app);
  }
});

test("reporting selects the existing most recently linked identity", () => {
  const config = { app: "http://localhost:3000", credentials: [
    { secret: "older", linkedAt: "2026-10-01" },
    { secret: "newer", linkedAt: "2026-10-07" },
  ] };
  assert.equal(reportTarget(undefined, config, "").secret, "newer");
});

test("tests can explicitly select a reporting server without changing the app", () => {
  const config = { app: REPORT_APP, credentials: [{ secret: "test-token" }] };
  assert.deepEqual(reportTarget(undefined, config, "http://127.0.0.1:1234/"), {
    app: "http://127.0.0.1:1234", secret: "test-token",
  });
  for (const override of ["http://remote.example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?token=x"]) {
    assert.throws(() => reportTarget(undefined, config, override), /HTTPS origin/);
  }
});
