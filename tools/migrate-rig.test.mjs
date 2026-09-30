import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renameImports, withoutRigPaths, withoutSourceRig } from "./migrate-rig.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));

// A workspace scaffolded before the rig was on npm, with the edits
// builds made to it: Tailwind, an "@/" alias, loadEnv for PROTO_PACKAGES.
const OLD = `import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Pre-npm: the rig ships as source. PROTO_PACKAGES points at a proto
// checkout's packages/ dir (the scaffolder writes it into .env or the dev
// script from ~/.proto/config.json). Once @proto/rig publishes to npm it
// becomes a plain dependency and this whole block goes away.
const packages = process.env.PROTO_PACKAGES ?? loadEnv("development", process.cwd(), "").PROTO_PACKAGES;
const tunnel = process.env.PROTO_TUNNEL === "1";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    // The source-aliased rig resolves from outside this standalone
    // workspace. Keep its hooks on the prototype's React runtime in both
    // dev and production builds.
    dedupe: ["react", "react-dom"],
    ...(packages && {
      alias: {
        "@/": fileURLToPath(new URL("./src/", import.meta.url)),
        "@proto/rig": \`\${packages}/rig/src/index.tsx\`,
        "@proto/rig-core": \`\${packages}/rig-core/src/index.ts\`,
        "@proto/wire": \`\${packages}/wire/src/index.ts\`,
        // The rig lazy-imports this from the prototype's own deps; with the
        // rig aliased from outside the root, vite needs the resolution pinned.
        "modern-screenshot": fileURLToPath(
          new URL("./node_modules/modern-screenshot/dist/index.mjs", import.meta.url),
        ),
      },
    }),
  },
  server: {
    port: 5231,
  },
});
`;

test("a built-on workspace keeps its own alias and plugins, and loses the rig's", () => {
  const result = withoutSourceRig(OLD);
  assert.equal(result.kind, "rewritten");
  assert.equal(
    result.text,
    `import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const tunnel = process.env.PROTO_TUNNEL === "1";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@/": fileURLToPath(new URL("./src/", import.meta.url)),
    },
  },
  server: {
    port: 5231,
  },
});
`,
  );
});

test("the templates are already what a migration writes", () => {
  for (const framework of ["react", "vue"]) {
    const text = readFileSync(join(kit, "template", `workspace-${framework}`, "vite.config.ts"), "utf8");
    assert.deepEqual(withoutSourceRig(text), { kind: "unchanged" });
  }
});

test("a config that still names PROTO_PACKAGES in another shape is left for a hand edit", () => {
  const odd = `const root = process.env.PROTO_PACKAGES;\nexport default { resolve: { alias: { "@proto/rig": root } } };\n`;
  assert.deepEqual(withoutSourceRig(odd), { kind: "unknown" });
});

test("imports are renamed in either quote, and nothing else is", () => {
  const source = `import { ProtoRig } from "@proto/rig";\nimport type { Manifest } from '@proto/wire';\nimport x from "@proto/rigging";\n`;
  assert.equal(
    renameImports(source),
    `import { ProtoRig } from "@proto-labs-inc/rig";\nimport type { Manifest } from '@proto-labs-inc/wire';\nimport x from "@proto/rigging";\n`,
  );
});

test("tsconfig keeps its own paths and loses the rig's", () => {
  const tsconfig = { compilerOptions: { strict: true, paths: { "@proto/rig": ["/x"], "@proto/wire": ["/y"], "@/*": ["./src/*"] } } };
  assert.deepEqual(withoutRigPaths(tsconfig), { compilerOptions: { strict: true, paths: { "@/*": ["./src/*"] } } });
  assert.deepEqual(withoutRigPaths({ compilerOptions: { paths: { "@proto/rig": ["/x"] } } }), { compilerOptions: {} });
  assert.equal(withoutRigPaths({ compilerOptions: { strict: true } }), null);
});
