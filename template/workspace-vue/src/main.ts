import { createApp } from "vue";
import { protoRig } from "@proto-labs-inc/rig-vue";
import type { Manifest } from "@proto-labs-inc/wire";
import manifest from "../public/prototype.json";
import App from "./App.vue";
import "./styles.css";

createApp(App).use(protoRig(manifest as Manifest)).mount("#app");
