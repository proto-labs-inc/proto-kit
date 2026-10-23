/** Shared manifest promotion: kit and desktop publishers may run in different repos. */
export function mergeRelease(current, staged) {
  if (current.format !== 1 || staged.format !== 1) throw new Error("Unsupported release manifest.");
  const kits = new Map((current.kits ?? []).map(kit => [kit.version, kit]));
  for (const kit of staged.kits ?? []) {
    const existing = kits.get(kit.version);
    if (existing && existing.sha256 !== kit.sha256) throw new Error("A kit version cannot be replaced.");
    kits.set(kit.version, existing ?? kit);
  }
  let requiredKit = current.requiredKit;
  if (!requiredKit || (staged.requiredKit && staged.requiredKit > requiredKit)) requiredKit = staged.requiredKit;
  let desktop = current.desktop;
  if (staged.desktop) {
    const parts = value => {
      if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("Invalid desktop version.");
      return value.split(".").map(Number);
    };
    const a = parts(staged.desktop.version);
    const b = parts(desktop?.version ?? "0.0.0");
    const order = a.map((part, index) => part - b[index]).find(part => part !== 0) ?? 0;
    if (order > 0) desktop = staged.desktop;
    if (order === 0 && desktop && desktop.sha256 !== staged.desktop.sha256) throw new Error("A desktop version cannot be replaced.");
  }
  return { ...current, format: 1, kits: [...kits.values()], requiredKit, ...(desktop ? { desktop } : {}), publishedAt: new Date().toISOString() };
}

export async function promoteRelease({ get, put, token, channel, staged, validate }) {
  const pathname = `desktop-releases/${channel}/current.json`;
  for (let attempt = 0; attempt < 8; attempt++) {
    // Origin reads and conditional writes avoid lost releases across repositories.
    const existing = await get(pathname, { access: "public", token, useCache: false });
    const current = existing ? await new Response(existing.stream).json() : { format: 1, kits: [] };
    const next = mergeRelease(current, staged);
    await validate(next);
    try {
      const result = await put(pathname, JSON.stringify(next, null, 2) + "\n", {
        token, access: "public", addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60,
        allowOverwrite: Boolean(existing), ...(existing ? { ifMatch: existing.blob.etag } : {}),
      });
      return { ...result, manifest: next };
    } catch (error) {
      if (!["BlobPreconditionFailedError", "BlobAlreadyExistsError"].includes(error.name)) throw error;
    }
  }
  throw new Error("The release manifest kept changing. Retry promotion; staged artifacts remain intact.");
}
