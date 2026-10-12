import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProtoRig } from "@proto-labs-inc/rig";
import type { Manifest } from "@proto-labs-inc/wire";
import "./styles.css";

const root = document.getElementById("root")!;

// The build's checks render one part alone at #/render/<slug>/<state>
// (src/render.tsx). Only the dev server does: in a build the condition
// is false at compile time and the module is left out. The app is
// imported on its branch only, so a part being checked never waits on
// an App.tsx that is mid-edit.
if (import.meta.env.DEV && window.location.hash.startsWith("#/render/")) {
  import("./render").then(({ renderPart }) => renderPart(root));
} else {
  Promise.all([import("./App"), fetch(`${import.meta.env.BASE_URL}prototype.json`).then((response) => response.json())]).then(([{ App }, manifest]) => {
    createRoot(root).render(
      <StrictMode>
        <ProtoRig manifest={manifest as Manifest}>
          <App />
        </ProtoRig>
      </StrictMode>,
    );
  });
}
