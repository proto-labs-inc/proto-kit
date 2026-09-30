import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "./cdp.mjs";

// A WebSocket server in a few lines: the upgrade handshake, then one of
// two ways a Chrome stops answering: the socket closes (the tab is
// gone) or it stays open and says nothing (the renderer is stuck).
function stuckChrome(behaviour) {
  return new Promise((resolve) => {
    const server = createServer();
    const sockets = new Set();
    server.on("upgrade", (req, socket) => {
      sockets.add(socket);
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
      socket.on("data", () => {
        if (behaviour === "closes") socket.end();
      });
    });
    const close = () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    };
    server.listen(0, "127.0.0.1", () => resolve({ url: `ws://127.0.0.1:${server.address().port}/devtools/page/x`, close }));
  });
}

test("a command whose tab closes under it rejects instead of waiting forever", async () => {
  const chrome = await stuckChrome("closes");
  try {
    const page = await connect(chrome.url);
    await assert.rejects(page.send("Runtime.evaluate", { expression: "1" }), /connection closed under a pending command/);
    // Nothing else on that connection can hang either.
    await assert.rejects(page.send("Page.captureScreenshot"), /connection closed/);
  } finally {
    chrome.close();
  }
});

test("a command that never gets an answer times out with its name", async () => {
  const chrome = await stuckChrome("silent");
  try {
    const page = await connect(chrome.url);
    const began = Date.now();
    await assert.rejects(page.send("Page.captureScreenshot", {}, { timeoutMs: 300 }), /Page.captureScreenshot did not answer within 0.3 s/);
    assert.ok(Date.now() - began < 2000);
    page.close();
  } finally {
    chrome.close();
  }
});
