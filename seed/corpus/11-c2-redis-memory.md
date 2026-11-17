=== c2-inc-1
kind: incident
cluster: C2
title: Add to cart failing for all shoppers
date: 2026-01-19T13:10
resolved: 2026-01-19T14:02
service: checkout-api
priority: Highest
assignee: checkout
reporter: frontend
status: resolved
recall: [adr-004, st-care-guides]
---
## Impact

From 13:02 to 13:58 UTC, nobody could add items to the cart. The storefront showed "We couldn't update your basket".

## Alert

```
[FIRING] checkout-api POST /cart/items error rate 100% (5m)
[FIRING] redis-shared used_memory 99.6% of maxmemory
```

## First errors

```
ReplyError: OOM command not allowed when used memory > 'maxmemory'.
    command=HSET key=cart:sess_3fa2...  at checkout-api/src/cart/store.ts:57
```

## Resolution

`catalog:guides:*` keys (care guides launched on 2026-01-12) were written without a TTL and had grown to 2.9 GB. Deleted them with a scan-and-unlink script; memory fell to 38%. catalog-api hotfix added a 1 hour TTL.
+++ comments
@checkout 2026-01-19T13:20 | checkout-api is fine, Redis is refusing writes. Who owns `catalog:guides`?
@catalog 2026-01-19T13:35 | Mine. The care guide cache uses a raw `SET` without `EX`. Sorry. Deleting now.

=== c2-pm
kind: postmortem
incident: c2-inc-1
title: Postmortem 2026-01-19 carts failing because redis-shared was full
date: 2026-01-22T11:00
author: catalog
labels: [postmortem, redis-shared, catalog-api, checkout-api, cart]
---
**Incident:** [[c2-inc-1]]. **Severity:** 1. **Duration:** 56 min. **Author:** Emma Paris.

## Summary

The care guide cache in `catalog-api` wrote keys without a TTL. Over seven days they filled `redis-shared`. Because the cluster uses `noeviction` ([[adr-004]]), Redis refused all writes, and the first visible symptom was carts in `checkout-api`, not the catalog.

## Root cause

- A catalog cache write path bypassed the shared cache helper that sets TTLs.
- Cache and carts share one memory budget, so a catalog bug became a checkout outage.

## Lessons

Carts must not depend on the cache's memory. The Postgres snapshot at checkout saved existing orders, but live carts could not be changed.

## Action items

- Split carts and catalog cache into separate Redis clusters (Jennifer Evans)
- Make TTL mandatory in the catalog cache helper and block raw SET in lint (Emma Paris)

=== c2-ai-split
kind: action
from: c2-pm
title: Split carts and catalog cache into separate Redis clusters
date: 2026-01-22T12:00
due: 2026-03-31
assignee: platform
reporter: catalog
status: todo
priority: High
service: checkout-api
labels: [postmortem-action, redis, cart]
---
From [[c2-pm]]. Create `redis-carts` (noeviction) and move `cart:` keys there; switch `redis-shared` to `allkeys-lru` for cache only. This is the "next step" in [[adr-004]].

=== c2-ai-ttl
kind: action
from: c2-pm
title: Make TTL mandatory in the catalog cache helper
date: 2026-01-22T12:05
due: 2026-02-06
assignee: catalog
reporter: catalog
status: done
priority: Medium
service: catalog-api
labels: [postmortem-action, cache]
---
From [[c2-pm]]. `cache.set()` now requires a TTL argument and an ESLint rule forbids direct `redis.set` in catalog-api.

=== rfc-carts-redis-only
kind: page
parent: sec-rfc
title: RFC Keep carts in Redis only and drop the Postgres cart snapshot
date: 2026-02-09T10:00
author: catalog
labels: [rfc, cart, redis-shared, checkout-api, pg-main, rejected]
---
**Status:** Rejected, 2026-02-16.

## Proposal

Stop copying the cart to Postgres at checkout start ([[doc-checkout-flow]]). Read the cart from Redis all the way through payment. This removes two inserts per checkout and about 15% of checkout's Postgres load.

## Discussion

- Ada Isadora: three weeks ago Redis refused all writes for an hour ([[c2-pm]]). The snapshot is the only reason no paid order lost its items. With Redis-only carts that incident would have lost orders, not just blocked add-to-cart.
- Jennifer Evans: Redis is configured as a cache cluster, without durability (no AOF). A failover loses recent writes.
- Alana Grant: reducing Postgres load is a real goal, but it should be solved with connection pooling, not by removing durability.

## Decision

**Rejected.** Revisit only after carts move to a dedicated, persistent Redis (see the split action item from [[c2-pm]]).

=== c2-inc-2
kind: incident
cluster: C2
title: Catalog API latency spike and cache write errors
date: 2026-04-23T09:15
resolved: 2026-04-23T10:20
service: catalog-api
priority: Medium
assignee: catalog
reporter: sre
status: resolved
recall: [c2-inc-1, c2-pm, c2-ai-split, adr-004]
---
## Impact

Product pages slow (p95 2.8 s) for an hour. Cart adds failed intermittently.

## Alert

```
[FIRING] catalog-api p95 latency 2.8s > 1s
[FIRING] redis-shared used_memory 96% of maxmemory
```

## First errors

```
cache write failed: ERR OOM command not allowed when used memory > 'maxmemory'  key=catalog:img:meta:...
falling back to pg-main for product 9c1e...
```

## Resolution

Image metadata keys grew after the spring catalog import (3,000 to 11,000 products). Raised `maxmemory` from 4 GB to 6 GB. Keys have TTLs this time; the cache is simply too big for the shared budget.
+++ comments
@catalog 2026-04-23T10:20 | Bumped memory. The real fix is still splitting carts off the shared cluster.

=== c2-inc-3
kind: incident
cluster: C2
title: Shoppers' baskets emptied after logging in
date: 2026-08-04T20:30
resolved: 2026-08-04T22:15
service: storefront-web
priority: High
assignee: frontend
reporter: notif_new
status: resolved
recall: [c2-inc-1, c2-inc-2, c2-pm, c2-ai-split, adr-004, rb-redis-memory]
---
## Impact

Between 20:12 and 20:20 UTC every active basket was emptied. 340 support contacts; shoppers had to rebuild baskets.

## Alert

No alert fired. Reported by customer support.

## Symptoms

```
GET /api/cart -> 200 {"items":[]}   (for sessions that had items minutes before)
checkout-api: cart:sess_* keyspace count dropped from 48211 to 0 at 20:12:44
```

## Resolution

At 20:12 the on-call engineer handled a `redis-shared used_memory > 85%` alert by following the runbook step "flush the catalog cache" with `FLUSHDB` on DB 0. Carts live in DB 0 too, so all live carts were deleted. Carts that had reached checkout were restored from the Postgres snapshot; others were lost.
+++ comments
@frontend 2026-08-04T20:45 | Filed on storefront because that is where shoppers saw it, but this is Redis.
@sre 2026-08-04T21:30 | The runbook step is wrong: it flushes carts as well as the catalog.

=== c2-pm-flush
kind: postmortem
incident: c2-inc-3
title: Postmortem 2026-08-04 baskets deleted by a cache flush
date: 2026-08-07T11:00
author: sre
labels: [postmortem, redis-shared, runbook, cart]
---
**Incident:** [[c2-inc-3]]. **Severity:** 2. **Author:** Mitch Davis.

## Summary

Following [[rb-redis-memory]] step 3, on-call ran `FLUSHDB` on `redis-shared` DB 0. That deleted 48,000 live carts as well as the catalog cache, because both live in the same database ([[adr-004]]).

## Contributing factors

- The runbook predates any thought of carts in the same DB.
- The split from [[c2-pm]] (January) is still not done.

## Action items

- Fix the Redis memory runbook: delete only `catalog:` keys, never FLUSHDB (Emma Paris)
- Split carts and catalog cache: already tracked from the January postmortem, re-prioritised

=== c2-ai-runbook
kind: action
from: c2-pm-flush
title: Fix redis-shared memory runbook so it never flushes carts
date: 2026-08-07T12:00
due: 2026-08-14
assignee: catalog
reporter: sre
status: done
priority: High
service: catalog-api
labels: [postmortem-action, runbook, redis]
---
From [[c2-pm-flush]]. Replace step 3 of [[rb-redis-memory]] with a scan-and-unlink of `catalog:*` only.

=== c2-inc-4
kind: incident
cluster: C2
title: catalog-api redis writes rejected, memory at 98 percent
date: 2026-10-28T15:40
resolved: 2026-10-28T16:25
service: catalog-api
priority: Medium
assignee: catalog
reporter: catalog
status: resolved
recall: [c2-inc-2, c2-inc-3, c2-pm, c2-ai-split, adr-004]
---
## Impact

Cache misses for 45 minutes; product pages fell back to Postgres and were slow. A few cart updates failed.

## Alert

```
[FIRING] redis-shared used_memory 98% of maxmemory (6gb)  evicted_keys=0
```

## First errors

```
ReplyError: OOM command not allowed when used memory > 'maxmemory'.  command=SET key=catalog:search:v2:...
```

## Resolution

The new search result cache (`catalog:search:v2`) was sized for 50k queries and reached 400k. Lowered its TTL to 10 minutes and raised `maxmemory` to 8 GB.
+++ comments
@catalog 2026-10-28T16:25 | Third memory bump this year. Cache and carts still share the cluster.

=== rfc-ephemeral-baskets
kind: page
parent: sec-rfc
trigger: true
title: RFC Ephemeral basket store to cut checkout database load
date: 2026-11-13T10:00
author: frontend
labels: [rfc, basket, checkout-api, performance, proposed]
recall: [rfc-carts-redis-only, c2-pm, c2-inc-3, c2-ai-split, adr-004, doc-checkout-flow, c1-ai-pgbouncer]
---
**Status:** Proposed. **Author:** Kevin Campbell.

## Problem

Checkout is the slowest part of the storefront at peak, and the database is the bottleneck. Black Friday is in two weeks.

## Proposal

Make the basket fully ephemeral: keep it only in the in-memory key-value store we already run, and stop writing a basket copy into the relational database when the shopper starts checkout. The order is created from the in-memory basket at payment time. This removes two inserts and one read per checkout.

## Expected benefit

About 15% fewer database writes from checkout and a faster "Start checkout" step.

## Risks

We believe the in-memory store is reliable enough; it has had no outages of its own this year.

## Decision needed by

2026-11-20, so it can ship before Black Friday.
