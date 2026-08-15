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

## Scheduler checks

1. Confirm exactly one intended `search-scheduler` container is running.
2. Inspect `gatherly_search_reconciliation_runs_total` by bounded result.
3. Inspect the last-completed timestamp and duration histogram.
4. Look for `execution:missed`, local `execution:overlap`, PostgreSQL
   `skipped_locked`, timeout, and dependency-failure logs.
5. Verify PostgreSQL and Elasticsearch connectivity without printing URLs,
   credentials, API keys, or event documents.
6. Run `yarn search:reconcile:prod` manually from the same immutable image.

A missed tick is not replayed. Restore the scheduler and allow the next tick,
or run the same idempotent comparison manually. Do not schedule a full reindex.
Use the existing confirmed-drift recovery sequence below.
