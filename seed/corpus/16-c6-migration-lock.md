=== c6-inc-1
kind: incident
cluster: C6
title: Checkout down for 6 minutes during a deploy
date: 2026-03-24T14:02
resolved: 2026-03-24T14:30
service: checkout-api
priority: Highest
assignee: checkout
reporter: sre
status: resolved
labels: [pg-main]
recall: [doc-migration-guide, doc-schema]
---
## Impact

From 14:01 to 14:07 UTC every checkout failed. About 650 failed attempts.

## Alert

```
[FIRING] checkout-api 5xx rate 100% (2m)
```

## First errors

```
error: canceling statement due to lock timeout
    INSERT INTO "orders" ...  at checkout-api/src/orders/create.ts:33
pg_stat_activity: 83 sessions wait_event_type=Lock relation=orders
blocking pid 41022: CREATE INDEX orders_shipping_region_idx ON orders (shipping_region)
```

## Resolution

Deploy `2026.03.24-1` ran a migration with a plain `CREATE INDEX` on `orders`, which blocks writes until it finishes. Cancelled the migration (`pg_cancel_backend(41022)`), checkout recovered, then re-ran it as `CREATE INDEX CONCURRENTLY` at night.
+++ comments
@platform 2026-03-24T14:30 | Rule 1 of the migration guide. Nothing in CI enforces it.

=== c6-pm
kind: postmortem
incident: c6-inc-1
title: Postmortem 2026-03-24 orders table locked by an index migration
date: 2026-03-26T10:00
author: platform
labels: [postmortem, pg-main, migrations, checkout-api]
---
**Incident:** [[c6-inc-1]]. **Severity:** 2. **Author:** Jennifer Evans.

## Summary

A migration created an index on `orders` without `CONCURRENTLY`, blocking all inserts for 6 minutes, during business hours.

## Root cause

The rules in [[doc-migration-guide]] are documentation only. Code review missed it.

## Action items

- Add a migration linter to CI that fails on unsafe operations on large tables (Jennifer Evans)

=== c6-ai-linter
kind: action
from: c6-pm
title: Add a migration linter to CI for unsafe Postgres operations
date: 2026-03-26T11:00
due: 2026-05-01
assignee: platform
reporter: platform
status: todo
priority: Medium
service: pg-main
labels: [postmortem-action, database, migrations, ci]
---
From [[c6-pm]]. Run a migration linter in CI: fail on non-concurrent index builds, column type changes and missing `lock_timeout` on `orders`, `order_items` and `payments`.

=== c6-inc-2
kind: incident
cluster: C6
title: Order history page timing out, order_items table rewrite
date: 2026-08-19T10:15
resolved: 2026-08-19T10:58
service: checkout-api
priority: High
assignee: platform
reporter: frontend
status: resolved
labels: [pg-main]
recall: [c6-inc-1, c6-pm, c6-ai-linter, doc-migration-guide]
decoys: [o-replica-lag]
---
## Impact

For 40 minutes, the order history page and order confirmation timed out; checkout failed for 12 minutes of that.

## First errors

```
error: canceling statement due to statement timeout  SELECT ... FROM order_items WHERE order_id = $1
blocking query: ALTER TABLE order_items ALTER COLUMN price_cents TYPE bigint
```

## Resolution

A migration changed the type of `order_items.price_cents`, which rewrites the whole table (110 million rows) under an `ACCESS EXCLUSIVE` lock. Cancelled it; redid it with a new column, backfill and switch, following rule 3 of the migration guide.
+++ comments
@platform 2026-08-19T10:58 | Second migration lock this year. The linter action item would have caught both.

=== st-orders-index
kind: story
trigger: true
title: Add index on orders customer_id and created_at for order history
date: 2026-11-14T11:00
assignee: notif_new
reporter: frontend
status: todo
service: checkout-api
labels: [performance, database]
recall: [doc-migration-guide, c6-inc-1, c6-pm, c6-ai-linter, c6-inc-2, doc-schema]
---
The order history page is slow (p95 1.9 s) for customers with many orders. Add a composite index on `orders (customer_id, created_at DESC)` and ship it with the next checkout-api deploy so it is live before Black Friday.

```sql
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);
```
