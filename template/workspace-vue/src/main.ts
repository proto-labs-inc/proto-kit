import { createApp } from "vue";
import { protoRig } from "@proto/rig-vue";
import type { Manifest } from "@proto/wire";
import manifest from "../public/prototype.json";
import App from "./App.vue";
import "./styles.css";

createApp(App).use(protoRig(manifest as Manifest)).mount("#app");
