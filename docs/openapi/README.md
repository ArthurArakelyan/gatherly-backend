# Gatherly OpenAPI layout

[`../openapi.yaml`](../openapi.yaml) is the canonical, self-contained OpenAPI
3.0.3 document. Import this single file into Bruno or another OpenAPI tool; it
contains every path and uses only document-local references.

The module directories below are retained as readable Phase 2 source material.
When an endpoint contract changes, update the canonical document and its matching
module file together.

```text
health/        Liveness and readiness endpoints
identity/      Username/password authentication and current-user lookup
communities/   Community creation, listing, and lookup
memberships/   Join and leave transitions
events/        Event creation and public reads
reservations/  Reservation, waitlist, cancellation, and idempotency behavior
```

Update the module's `paths.yaml` and its matching API/integration test whenever
an implemented endpoint contract changes.
