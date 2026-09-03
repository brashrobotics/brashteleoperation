# Interactive autonomy demo

This executable scenario proves the intended product loop in one process:

1. Recognition cannot identify an object and opens an assistance request.
2. An operator selects and names the object in an immutable RGB-D observation.
3. The selection is grounded into 3D, planned, explicitly approved, and manipulated in simulation.
4. Redacted, consented evidence becomes a versioned registry candidate.
5. Human review and held-out evaluation gate activation of an exemplar.
6. A future instance is recognized and manipulated without another assistance request.

The future manipulation uses an exact-revision approval issued by the autonomous policy. This keeps the executor's provenance invariant while avoiding a second operator interaction. The adapter is simulation-only and physical command output is always reported as disabled.

Run it from the repository root:

```sh
npm run demo:autonomy
```
