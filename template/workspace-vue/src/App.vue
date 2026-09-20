<!--
  Starter page. Replace everything inside .app with the real prototype —
  keeping the three rules it demonstrates:

  1. Every visually coherent component's root element carries a
     kebab-case data-proto-id — the Frame's comment mode hit-tests
     these for selection and comment anchoring. Repeating an id across
     list rows is fine; renaming one breaks comments already anchored
     to it.
  2. Every distinct mode a reviewer should reach is a preview state in
     public/prototype.json, driven through usePreviewState.
  3. Placeholder art is inline SVG generated in-component — never
     stock images, so scaffolds ship license-clean.
-->
<script setup lang="ts">
import { usePreviewState } from "@proto/rig-vue";

const [state] = usePreviewState("default", ["default", "empty"]);
</script>

<template>
  <div class="app">
    <header data-proto-id="header">
      <h1>Prototype</h1>
    </header>
    <div v-if="state === 'empty'" class="empty" data-proto-id="empty-state">
      <svg class="art" viewBox="0 0 72 72" aria-hidden="true">
        <circle cx="36" cy="36" r="32" fill="#f1e8f7" />
        <circle cx="28" cy="30" r="10" fill="#d9c2ea" />
        <path d="M12 58c6-14 42-14 48 0" fill="#c7a8e0" />
      </svg>
      <p>Nothing here yet.</p>
    </div>
    <main v-else data-proto-id="content">
      <p>Build the prototype here.</p>
    </main>
  </div>
</template>
