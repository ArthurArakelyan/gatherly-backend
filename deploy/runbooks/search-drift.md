# Search projection drift

## Impact

Public event search may contain missing, stale, or ineligible documents. Core
PostgreSQL-backed APIs remain available.

## Checks

1. Inspect reconciliation counts by kind.
2. Inspect outbox oldest age and Kafka consumer lag.
3. Check Elasticsearch health and the active read/write aliases.
4. Check dead-letter records without printing payload bodies.

## Recovery

1. Let ordinary backlog recover if lag is decreasing.
2. Repair a poison record deliberately if one blocks progress.
3. Run `yarn search:reindex:prod` only for confirmed drift/index loss.
4. Run reconciliation again and require every drift count to be zero.

## Verification

- Core readiness stayed healthy.
- Search returns only currently eligible events.
- Reconciliation drift is zero.
