import { createApp } from "vue";
import { protoRig } from "@proto-labs-inc/rig-vue";
import type { Manifest } from "@proto-labs-inc/wire";
import manifest from "../public/prototype.json";
import App from "./App.vue";
import "./styles.css";

async function start() {
  const rig = await protoRig(manifest as Manifest);
  createApp(App).use(rig).mount("#app");
}
void start().catch(error => {
  const root = document.querySelector("#app");
  if (root) {
    root.textContent = "Could not load the rig. Check your connection and refresh to retry.";
    root.setAttribute("role", "alert");
  }
  console.error(error);
});
