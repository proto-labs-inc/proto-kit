import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProtoRig } from "@proto/rig";
import type { Manifest } from "@proto/wire";
import manifest from "../public/prototype.json";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ProtoRig manifest={manifest as Manifest}>
      <App />
    </ProtoRig>
  </StrictMode>,
);
