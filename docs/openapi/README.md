# Gatherly OpenAPI layout

[`../openapi.yaml`](../openapi.yaml) is the OpenAPI entry point. Open it in an
OpenAPI-capable editor or importer; it assembles the paths below and keeps shared
parameters and schemas in one place.

```text
health/        Liveness and readiness endpoints
communities/   Community creation, listing, and lookup
memberships/   Join and leave transitions
events/        Event creation and public reads
reservations/  Reservation, waitlist, cancellation, and idempotency behavior
```

Update the module's `paths.yaml` and its matching API/integration test whenever
an implemented endpoint contract changes.
