# Learning Pipeline

## Purpose

Turns reviewed assistance observations and manipulation outcomes into evaluated
recognition or manipulation artifacts for future reuse.

## Responsibilities

- Materialize immutable datasets from approved registry manifests.
- Validate labels, masks, sensor calibration, deduplication, and train/test
  separation.
- Build or update exemplar indexes, feature artifacts, recognition models, or
  grasp-policy artifacts.
- Run offline accuracy, uncertainty, regression, latency, and safety-policy
  evaluations.
- Produce signed/versioned artifact bundles and machine-readable evaluation
  reports.
- Request promotion through the object registry workflow.
- Retain reproducibility metadata: code, parameters, dependencies, data
  manifest, random seed, and hardware environment.

## Boundaries

- The pipeline is never invoked in the critical path of the current task.
- Training output is inactive until reviewed and explicitly promoted.
- Failed or partial jobs leave prior active artifacts unchanged.
- Evaluation sets must not contain the observations used to create an exemplar
  unless the evaluation explicitly measures same-instance tracking.

## Failure behavior

- Jobs are idempotent by dataset and configuration digest.
- Retries use immutable inputs and create no duplicate active artifacts.
- Promotion failure leaves the candidate and current active version unchanged.
- Every output can be traced back to exact source observations and labels.

## Initial milestone

Build and evaluate a site-scoped exemplar artifact from reviewed RGB-D object
observations, publish a report, promote it through an explicit approval, and
demonstrate rollback to the previous active version.

## Implemented

The deterministic exemplar pipeline consumes only a reviewed registry version
in `VALIDATING`, checks that every training observation appears in its evidence
manifest, rejects train/evaluation leakage, constructs a normalized centroid
artifact, and calculates held-out precision/recall against configured gates.
The full dataset/config digest makes retries idempotent. It returns an immutable
artifact and evaluation report but never activates either; registry review and
promotion remain separate explicit actions.
