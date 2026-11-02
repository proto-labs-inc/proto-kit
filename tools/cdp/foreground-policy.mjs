// Foreground access is reserved for an explicitly requested visible session.
export function assertForegroundAllowed(method, params = {}, allowed = process.env.PROTO_ALLOW_FOREGROUND === "1") {
  if (allowed) return;
  const raises = method === "Page.bringToFront" || method === "Target.activateTarget" ||
    (method === "Browser.setWindowBounds" && ["normal", "maximized", "fullscreen"].includes(params.bounds?.windowState));
  if (raises) throw new Error(`${method} blocked: Proto browser work stays in the background. Foreground access requires an explicitly requested visible session.`);
}
