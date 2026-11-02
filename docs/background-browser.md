# Background browser work

Proto source inspection and local-copy checks run headlessly by default. This applies to staff setup, screen discovery/preparation, design-system import and normal prototype creation. Reuse the owned target; inspect saved screenshots with the image viewer. Never add Page.bringToFront, Target.activateTarget, OS activation or foreground browser commands to capture scripts or retries.

The installed CDP client rejects foreground commands by default. Do not catch and bypass that rejection or set PROTO_ALLOW_FOREGROUND during normal work. Keyboard tests use Emulation.setFocusEmulationEnabled, which does not activate an OS window.

If sign-in requires a visible browser, explain that need and ask the user to authorize the switch. After stopping the dedicated headless source browser, launch chrome.mjs with --visible and PROTO_ALLOW_FOREGROUND=1 only for that explicitly authorized interaction. Do not close the user's regular browser. After sign-in, close the dedicated visible browser and restart chrome.mjs without the override before continuing. Browser-mode switches invalidate source sessions and require recapture; never reuse stale visual evidence.

Do not resume old browser scripts after a tool update: use fresh processes so they load the installed protections. No automatic foreground fallback is allowed for failed captures. Report failures and continue independent work.
