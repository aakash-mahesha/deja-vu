=== c1-inc-1
kind: incident
cluster: C1
title: Checkout API returning 503 during spring campaign
date: 2026-03-06T19:42
resolved: 2026-03-06T20:31
service: checkout-api
priority: High
assignee: sre
reporter: checkout
status: resolved
recall: [adr-003, st-reporting-export]
---
## Impact

From 19:38 to 20:25 UTC about 18% of checkout attempts returned 503. Shoppers saw "Something went wrong, please try again" after pressing Pay.

## Alert

```
[FIRING] checkout-api 5xx rate 17.9% > 2% (5m)  env=prod  pods=8/8
```

## First errors

```
error: remaining connection slots are reserved for non-replication superuser connections
    at Parser.parseErrorMessage (pg-protocol/dist/parser.js:287)
    at checkout-api/src/db/withTx.ts:41  requestId=7f3c1e2a-91b0-4c3e-a7f1-0d2e5b9c8a11
```

## Context

`checkout-api` scaled to its HPA maximum of 8 pods for the spring campaign email. Finance started an on-demand order export from the admin tool at 19:35.

## Resolution

Stopped the finance export job; connections fell from 198 to 141 and errors stopped within a minute. Asked finance to run exports only at night for now.
+++ comments
@sre 2026-03-06T19:50 | `pg_stat_activity` shows 198 connections. 160 from checkout-api (8 pods x 20), 30 from `order-export`, rest from catalog and payments.
@platform 2026-03-06T20:20 | The export job has its own pool of 30. That was never in the connection budget. We were already near the edge at 8 checkout pods.
@checkout 2026-03-06T20:31 | Resolved. Not doing a full postmortem; export moved to 02:00 UTC.

=== c8-inc-1
kind: incident
cluster: C8
title: Payments failing at checkout, PayRail returning 502 and 504
date: 2026-04-02T14:05
resolved: 2026-04-02T15:12
service: payments-api
priority: Highest
assignee: checkout
reporter: sre
status: resolved
decoys: [c1-inc-1]
---
## Impact

From 14:01 to 15:08 UTC, 64% of card payments failed. Shoppers saw "Payment could not be processed" at the payment step of checkout.

## Alert

```
[FIRING] payments-api upstream error rate 61% (payrail)  p95 latency 19.8s
```

## First errors

```
PayRailError: upstream responded 504 Gateway Timeout  path=/v2/charges  attempt=2
PayRailError: upstream responded 502 Bad Gateway  path=/v2/charges  attempt=1
```

## Resolution

PayRail confirmed a regional outage on their status page at 14:20 and recovered at 15:05. We turned on the `payments-degraded-banner` flag at 14:25. No action on our side; Postgres and checkout-api were healthy throughout.
+++ comments
@sre 2026-04-02T14:15 | checkout-api pool usage is normal (60/160). This is upstream.
@checkout 2026-04-02T15:12 | PayRail recovered. Closing as external.

=== cap-mothers-day
kind: page
parent: sec-planning
title: Mother's Day 2026 sale capacity plan
date: 2026-04-20T10:00
author: sre
labels: [capacity-plan, sale, mothers-day, catalog-api, checkout-api]
---
**Sale window:** Friday 2026-05-08 18:00 UK to Sunday 2026-05-10 23:59 UK. Expected peak is 4x a normal Saturday.

## Plan per service

| Service | Normal | Sale setting | Owner |
|---|---|---|---|
| storefront-web | 4 pods | 10 pods, CDN TTL 120 s | Kevin Campbell |
| catalog-api | 2 pods | 6 pods, **pre-warm cache** at 17:30 | Emma Paris |
| checkout-api | HPA 4 to 8 | **HPA 4 to 12** | Ada Isadora |
| payments-api | 2 pods | 4 pods | Ada Isadora |
| order-worker | 6 pods | 12 pods | Max Taylor |

## Cache pre-warm

A CronJob `catalog-prewarm` loads the top 2,000 products and the search index into `redis-shared` at 17:30 on 2026-05-08, so the sale does not start on a cold cache.

## Freeze

No deploys and no migrations from Friday 12:00 to Monday 09:00.

## Open questions

- Is raising checkout-api to 12 pods safe for the database? (Ada: "should be fine, pool usage is usually low")

=== c1-inc-2
kind: incident
cluster: C1
title: Orders failing at payment step during Mother's Day sale
date: 2026-05-08T19:12
resolved: 2026-05-08T21:40
service: checkout-api
priority: Highest
assignee: sre
reporter: sre
status: resolved
links: [c1-inc-1:relates]
recall: [c1-inc-1, adr-003, cap-mothers-day, doc-checkout-flow]
decoys: [c8-inc-1, c7-inc-1]
---
## Impact

From 19:05 to 21:35 UK time, 31% of orders failed and many more stalled on "Placing your order…" for 30 seconds. Estimated lost revenue: 4,100 orders.

## Alert

```
[FIRING] checkout-api p95 latency 30.2s > 5s (5m)  pods=12/12
[FIRING] checkout-api 5xx rate 22% > 2% (5m)
```

## First errors

```
KnexTimeoutError: Knex: Timeout acquiring a connection. The pool is probably full. Are you missing a .transacting(trx) call?
    at Client_PG.acquireConnection (knex/lib/client.js:312)  route=POST /checkout/confirm
error: sorry, too many clients already  (from pg-main, 19:14:03)
```

## Resolution

Scaled checkout-api back from 12 to 8 pods at 20:10, which stopped the `too many clients` errors. Timeouts continued until 21:30 because confirm requests held a transaction open while waiting for PayRail (2 to 6 s each). Hotfix `2026.05.08-h1` moved the PayRail call outside the transaction.
+++ comments
@sre 2026-05-08T19:20 | Runbook [[rb-checkout-5xx]] has nothing on the pool. Checked PayRail status page: green. Redis fine.
@platform 2026-05-08T19:41 | 12 pods x 20 = 240 possible connections against `max_connections` 200. ADR-003 said revisit above 8 pods.
@checkout 2026-05-08T21:05 | `POST /checkout/confirm` opens a transaction, then calls payments-api, which waits on PayRail. Each request holds a connection for seconds. Hotfix building.
@sre 2026-05-08T21:40 | Resolved. Postmortem to follow.

=== c1-pm
kind: postmortem
incident: c1-inc-2
title: Postmortem 2026-05-08 checkout connection pool exhaustion
date: 2026-05-12T15:00
author: sre
labels: [postmortem, checkout-api, pg-main, connection-pool]
---
**Incident:** [[c1-inc-2]]. **Severity:** 1. **Duration:** 2 h 35 min. **Author:** Mitch Davis.

## Summary

During the Mother's Day sale, `checkout-api` scaled to 12 pods as the capacity plan [[cap-mothers-day]] allowed. At 20 connections per pod, checkout alone could open 240 connections against a Postgres limit of 200. At the same time, `POST /checkout/confirm` held a database transaction open across the PayRail call, so every slow payment kept a connection busy.

## Timeline (UK time)

| Time | Event |
|---|---|
| 18:00 | Sale starts; HPA scales checkout-api from 6 to 12 pods by 18:50 |
| 19:05 | First `Timeout acquiring a connection` errors |
| 19:14 | Postgres starts rejecting with `too many clients already` |
| 19:20 | On-call follows the checkout 5xx runbook; no pool guidance |
| 20:10 | Scaled to 8 pods; rejections stop, timeouts continue |
| 21:30 | Hotfix moves PayRail call out of the transaction; recovery |

## Root cause

1. The connection budget in [[adr-003]] assumed at most 8 pods. The capacity plan raised the limit to 12 without checking it.
2. A transaction spanned an external HTTP call, against the rule in [[doc-checkout-flow]].

## What went well

The hotfix shipped in 80 minutes. Customers with snapshotted carts lost nothing.

## Previous occurrence

[[c1-inc-1]] in March had the same Postgres error, caused by the finance export. It was closed without a postmortem.

## Action items

- Introduce PgBouncer in transaction mode in front of pg-main (Ada Isadora)
- Never hold a DB transaction across the PayRail call (Ada Isadora)
- Alert on Knex pool pending acquires and acquire wait p95 (Mitch Davis)
- Cap checkout-api HPA at 8 replicas until PgBouncer is live (Jennifer Evans)
- Add connection pool exhaustion to the checkout 5xx runbook (Mitch Davis)

=== c1-ai-pgbouncer
kind: action
from: c1-pm
title: Introduce PgBouncer in transaction mode in front of pg-main
date: 2026-05-12T16:00
due: 2026-06-30
assignee: checkout
reporter: sre
status: todo
priority: High
service: checkout-api
labels: [postmortem-action, database, connection-pool]
---
From [[c1-pm]]. Put PgBouncer (transaction pooling) between all services and `pg-main` so pod count no longer decides the number of Postgres connections. This is option 2 in [[adr-003]]. Check prepared statement usage in Knex before switching.

Until this is done, checkout-api must stay at 8 pods or fewer.

=== c1-ai-tx
kind: action
from: c1-pm
title: Never hold a DB transaction across the PayRail call in checkout confirm
date: 2026-05-12T16:05
due: 2026-05-29
assignee: checkout
reporter: sre
status: done
priority: High
service: checkout-api
labels: [postmortem-action, database]
---
From [[c1-pm]]. Make the hotfix permanent: commit the pending order, call payments-api, then open a new short transaction for the result. Add a lint check for HTTP calls inside `withTx`.

=== c1-ai-alert
kind: action
from: c1-pm
title: Alert on Knex pool pending acquires and acquire wait time
date: 2026-05-12T16:10
due: 2026-05-22
assignee: sre
reporter: sre
status: done
priority: Medium
service: checkout-api
labels: [postmortem-action, monitoring]
---
From [[c1-pm]]. New alert `checkout-api knex pending acquires > 10 for 2m` and dashboard panel for acquire wait p95.

=== c1-ai-hpa
kind: action
from: c1-pm
title: Cap checkout-api HPA at 8 replicas until PgBouncer is live
date: 2026-05-12T16:15
due: 2026-05-15
assignee: platform
reporter: sre
status: done
priority: High
service: checkout-api
labels: [postmortem-action, kubernetes]
---
From [[c1-pm]]. Set `maxReplicas: 8` in checkout-api's HPA. Remove the cap only after [[c1-ai-pgbouncer]] is done.

=== c1-ai-runbook
kind: action
from: c1-pm
title: Add connection pool exhaustion steps to the checkout 5xx runbook
date: 2026-05-12T16:20
due: 2026-06-05
assignee: sre
reporter: sre
status: todo
priority: Medium
service: checkout-api
labels: [postmortem-action, runbook]
---
From [[c1-pm]]. [[rb-checkout-5xx]] has no steps for pool exhaustion. Add: check `pg_stat_activity` by `application_name`, check pod count against the budget in [[adr-003]], look for long transactions, stop batch jobs.

=== c1-inc-3
kind: incident
cluster: C1
title: checkout-api pods crashlooping after cluster move
date: 2026-07-21T10:48
resolved: 2026-07-21T11:35
service: checkout-api
priority: High
assignee: checkout
reporter: sre
status: resolved
links: [c1-inc-2:relates]
recall: [c1-inc-2, c1-pm, c1-ai-pgbouncer, c1-ai-hpa, st-k8s-migration, adr-003]
decoys: [o-uk-region-null]
---
## Impact

Checkout errors for 40 minutes on a Tuesday morning; about 9% of attempts failed.

## Alert

```
[FIRING] checkout-api readiness probe failures  pods=14/16 Ready=9
```

## First errors

```
Error: sorry, too many clients already
    at checkout-api/src/db/pool.ts:18 (startup health check)
CrashLoopBackOff  container=checkout-api  restarts=7
```

## Context

checkout-api moved to the new cluster `prod-eu-2` with the shared Helm chart on 2026-07-20. The chart's default `maxReplicas: 16` replaced our override of 8, and a traffic bump at 10:30 scaled the deployment to 16 pods. New pods could not get connections, failed readiness and restarted.

## Resolution

Re-applied `maxReplicas: 8` in `values-prod.yaml`. Pods stabilised at 11:30.
+++ comments
@sre 2026-07-21T11:00 | Same Postgres error as the Mother's Day incident.
@checkout 2026-07-21T11:35 | Cap restored. PgBouncer still not started; I keep losing it to feature work.

=== c8-inc-2
kind: incident
cluster: C8
title: Card payments timing out at checkout, PayRail latency above 30 seconds
date: 2026-08-27T17:22
resolved: 2026-08-27T18:05
service: payments-api
priority: High
assignee: checkout
reporter: catalog
status: resolved
recall: [c8-inc-1]
decoys: [c1-inc-2, c1-inc-3]
---
## Impact

For 40 minutes, about a quarter of payments timed out. Shoppers waited on "Placing your order…" and then saw "Payment could not be processed".

## Alert

```
[FIRING] payments-api payrail p95 latency 31.4s > 10s (5m)
```

## First errors

```
PayRailError: request timed out after 20000ms  path=/v2/charges  attempt=2
```

## Resolution

PayRail degraded performance in their EU region (status page incident at 17:30). Recovered 18:00. Banner flag turned on at 17:35. checkout-api pool usage and Postgres were normal.
+++ comments
@checkout 2026-08-27T17:40 | Not us: pool at 55/160, no Knex timeouts. Same pattern as the April PayRail outage.

=== c1-inc-4
kind: incident
cluster: C1
title: Intermittent 500s on checkout confirm on the 15th
date: 2026-09-15T06:20
resolved: 2026-09-15T08:05
service: checkout-api
priority: High
assignee: checkout
reporter: catalog
status: resolved
recall: [c1-inc-2, c1-pm, c1-ai-pgbouncer, st-care-box-renewals, adr-003]
decoys: [o-uk-region-null, o-replica-lag, c8-inc-2]
---
## Impact

From 06:00 to 08:00 UTC, about 6% of checkout confirms returned 500. Some Care Box renewals failed and had to be retried.

## Alert

```
[FIRING] checkout-api knex pending acquires 34 > 10 (2m)
```

## First errors

```
KnexTimeoutError: Knex: Timeout acquiring a connection. The pool is probably full.
    route=POST /checkout/confirm  pod=checkout-api-7d9c5f-x2k1q
    route=job:care-box-renewals  batch=37/90
```

## Context

The first Care Box renewal run inside checkout-api started at 06:00. Each renewal batch holds pool connections for several seconds, so shopper requests on the same pods waited for connections.

## Resolution

Paused the renewal job at 07:50 and resumed it at 22:00 with batch size 20 instead of 100.
+++ comments
@catalog 2026-09-15T06:30 | Spotted from the new pending-acquires alert.
@checkout 2026-09-15T08:05 | Renewals now run at 22:00 with smaller batches. Proper fix is still PgBouncer, or a separate pool for jobs.

=== c1-inc-5
kind: incident
cluster: C1
trigger: true
title: Checkout stuck on "Placing your order" for many customers
date: 2026-11-16T12:04
service: checkout-api
priority: Highest
assignee: sre
reporter: notif_new
status: inprogress
recall: [c1-inc-4, c1-inc-3, c1-inc-2, c1-inc-1, c1-pm, c1-ai-pgbouncer, c1-ai-runbook, adr-003, rb-checkout-5xx]
decoys: [c8-inc-1, c8-inc-2, o-uk-region-null, o-replica-lag]
---
## Impact

Since about 11:55 UTC customers report the checkout page spinning on "Placing your order…" and then an error. Support has 23 tickets in 10 minutes. Early-access Black Friday preview traffic started at 11:45.

## Alert

```
[FIRING] checkout-api p95 latency 28.7s > 5s (5m)  pods=8/8
[FIRING] checkout-api knex pending acquires 51 > 10 (2m)
```

## First errors

```
Error: timeout acquiring connection from pool after 30000ms
    route=POST /checkout/start  pod=checkout-api-5b8f7c-q9w2e
```

PayRail status page is green.
