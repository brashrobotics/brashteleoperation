# ADR 0002: Separate runtime object grounding from persistent learning

- **Status:** Proposed
- **Date:** 2026-09-02

## Context

When autonomy cannot identify a target, an operator must be able to declare the
object and resume the current task quickly. Reusing that declaration for future
recognition is valuable, but automatically changing production perception from
a single runtime interaction can propagate incorrect labels, unsafe
affordances, or environment-specific bias.

## Decision

Treat the operator's runtime declaration as a short-lived grounded object tied
to an immutable observation bundle and current tracking session.

Persistent reuse follows a separate path:

1. Create an enrollment candidate containing observations, labels, geometry,
   affordances, provenance, and manipulation outcomes.
2. Review and evaluate the candidate against held-out data and safety policy.
3. Promote a versioned artifact to a declared scope such as one site.
4. Support rollback and preserve the evidence used for promotion.

## Consequences

- Current-task recovery does not wait for model training.
- Production models remain reproducible and reviewable.
- Object registry and learning-pipeline components are required.
- The same object may need repeated grounding until an enrollment is promoted.
- The UI must distinguish “use now” from “teach for future use.”

## Alternatives considered

- Online retraining after each annotation: rejected because it is difficult to
  validate, reproduce, and roll back safely.
- Never retain operator declarations: rejected because it wastes valuable
  reviewed examples and forces repeated assistance.
- Treat semantic recognition as sufficient for grasping: rejected because a
  class label does not establish instance pose, geometry, tracking, or a safe
  manipulation plan.
