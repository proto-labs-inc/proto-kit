import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProtoRig } from "@proto/rig";
import type { Manifest } from "@proto/wire";
import manifest from "../public/prototype.json";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root")!;

// The build's checks render one part alone at #/render/<slug>/<state>
// (src/render.tsx). Only the dev server does: in a build the condition
// is false at compile time and the module is left out.
if (import.meta.env.DEV && window.location.hash.startsWith("#/render/")) {
  import("./render").then(({ renderPart }) => renderPart(root));
} else {
  createRoot(root).render(
    <StrictMode>
      <ProtoRig manifest={manifest as Manifest}>
        <App />
      </ProtoRig>
    </StrictMode>,
  );
}
