# Frame-owned controls and settings snapshots

Numeric controls belong to the Frame. Do not draw a settings card inside the
prototype or duplicate its values in local storage. Declare `controlGroups` in
`public/prototype.json`, and consume them with `useControls(groupId)` from the rig.
This requires a rig build with controls support; older rigs do not advertise it.

```json
{
  "controlGroups": [{
    "id": "appearance",
    "title": "Appearance settings",
    "schemaVersion": 1,
    "state": "default",
    "requires": { "component": "design", "variant": "original" },
    "fields": [{ "id": "size", "label": "Size", "default": 100,
      "min": 25, "max": 200, "step": 1, "unit": "%" }],
    "actions": [
      { "id": "shuffle", "label": "Shuffle shapes", "kind": "prototype" },
      { "id": "reset", "label": "Reset controls", "kind": "reset" }
    ]
  }]
}
```

In React: `const values = useControls('appearance')`. In Vue:
`const values = useControls('appearance')` returns a readonly ref. Register an
optional action with `useControlAction('appearance', 'shuffle', shuffle)`.
A declared reset action restores the defaults without a prototype callback. Actions are not
snapshot fields. `frameOrigin` must be the trusted Frame origin from the workspace
configuration, including the local origin for a localhost development workspace.

Keep simulation and random-scene lifetime independent of control values. Never
use settings in a component key. Reconcile size and spacing into existing objects;
quantity adds or removes only the difference. Shuffle may replace the scene.

Snapshot saves only the declared numeric values. It creates a data-backed variant
in a `controls-<groupId>` set; it does not invoke an agent, change prototype files,
or publish a build. The Frame merges these variants into its effective catalog
and hydrates the rig before selection. Existing code variants remain in the
published manifest. Do not write snapshot variants into that manifest.

Stable group and field IDs are part of the saved contract. Increment schemaVersion
for incompatible meaning, ranges, or field changes. Existing snapshots remain
stored but cannot be applied to an incompatible schema. Do not store seeds,
positions, shape identities, or scene images as control values.
