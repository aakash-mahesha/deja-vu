=== sec-architecture
kind: section
title: Architecture
date: 2025-11-03T09:00
author: em
---
System design, service designs and the data model for Fernway v2.

=== sec-adr
kind: section
title: Architecture decision records
date: 2025-11-03T09:05
author: em
---
One page per decision. Status is one of Proposed, Accepted, Superseded. Each ADR lists the conditions under which it must be revisited.

=== sec-rfc
kind: section
title: RFCs
date: 2025-11-03T09:10
author: em
---
Proposals for cross-team changes. Each RFC ends with a decision: Accepted or Rejected, with the reason.

=== sec-runbooks
kind: section
title: Runbooks
date: 2025-11-03T09:15
author: sre
---
On-call runbooks. If a runbook step did not work during an incident, fix the runbook as a postmortem action item.

=== sec-postmortems
kind: section
title: Postmortems
date: 2025-11-03T09:20
author: sre
---
Blameless postmortems. Every postmortem has a matching Post-incident review in the OPS project and action items in the FERN project labelled `postmortem-action`.

=== sec-planning
kind: section
title: Planning
date: 2025-11-03T09:25
author: em
---
Capacity plans, sale readiness and quarterly plans.

=== doc-architecture
kind: page
parent: sec-architecture
title: Fernway v2 system architecture
date: 2025-11-04T10:00
author: em
labels: [architecture, system-design]
---
## Context

Fernway sells house plants online: one-off orders plus the monthly **Care Box** subscription. The 2019 Rails monolith cannot be deployed safely during sales, and every team waits on the same release train. Fernway v2 splits it into six services with one shared Postgres, one shared Redis and one Kafka cluster. Migration runs Nov 2025 to Feb 2026.

## Request path

1. The shopper's browser loads `storefront-web` (Next.js, server-side rendered) through the CDN.
2. `storefront-web` calls `catalog-api` for products, search and plant care guides, and `checkout-api` for the cart and checkout.
3. `checkout-api` keeps the live cart in `redis-shared`. At checkout start it writes a cart snapshot and a pending order to `pg-main`.
4. `checkout-api` calls `payments-api`, which charges the card through our payment provider **PayRail**. PayRail confirms asynchronously with webhooks.
5. When payment succeeds, `checkout-api` publishes `order.paid` to Kafka.
6. `order-worker` consumes `order.created` and `order.paid`, reserves inventory, buys a shipping label from **ShipLabel** and publishes `order.shipped`.
7. `notifications` consumes order events and `notification.requested`, and sends email through `smtp-relay` and SMS through our SMS provider.

## Services

| Service | Layer | Owner | Main store |
|---|---|---|---|
| storefront-web | Frontend | Kevin Campbell | none (stateless SSR) |
| catalog-api | Backend | Emma Paris | pg-main, redis-shared cache |
| checkout-api | Backend | Ada Isadora | redis-shared carts, pg-main |
| payments-api | Backend | Ada Isadora | pg-main payments tables |
| order-worker | Backend | Max Taylor | pg-main, kafka-main |
| notifications | Backend | Ryan Lee | kafka-main |

## Shared infrastructure

- `pg-main`: Postgres 16, one primary and one read replica, `max_connections = 200`. See [[adr-001]] and [[adr-003]].
- `redis-shared`: one Redis cluster for the catalog cache and shopping carts. See [[adr-004]].
- `kafka-main`: 3 brokers, 12 partitions per order topic. See [[adr-002]].

## Known limits we accepted for launch

- Every backend pod opens its own Postgres pool. Total connections grow with pod count ([[adr-003]]).
- Cache and carts share Redis memory; cache growth can starve carts ([[adr-004]]).
- PayRail webhooks are at-least-once; our handlers must be idempotent ([[adr-005]]).

## Related designs

[[doc-storefront-ssr]], [[doc-checkout-flow]], [[doc-payments-design]], [[rfc-order-events]], [[doc-schema]], [[doc-migration-guide]], [[doc-service-catalog]].

=== adr-001
kind: page
parent: sec-adr
title: ADR-001 Postgres as the system of record
date: 2025-11-05T11:00
author: platform
labels: [adr, database, pg-main]
---
**Status:** Accepted, 2025-11-05. **Deciders:** Jennifer Evans, Ada Isadora, Alana Grant.

## Decision

All transactional data (orders, order items, payments, inventory, subscriptions, cart snapshots) lives in one Postgres 16 cluster, `pg-main`. Services own their tables and schemas; no service reads another service's tables directly.

## Why

- Orders and payments need transactions and constraints.
- One cluster is cheaper to run with a team of nine.
- We can split per-service databases later because table ownership is already separated.

## Consequences

- `pg-main` is a shared dependency for every backend service, so a problem there shows up everywhere at once.
- Schema changes on large tables (`orders`, `order_items`) need the rules in [[doc-migration-guide]].

## Revisit when

A single service needs more than half of the connections or I/O of `pg-main`.

=== adr-002
kind: page
parent: sec-adr
title: ADR-002 Kafka for order events
date: 2025-11-06T11:00
author: orders
labels: [adr, kafka, order-worker]
---
**Status:** Accepted, 2025-11-06. **Deciders:** Max Taylor, Jennifer Evans.

## Decision

Order lifecycle events go through Kafka (`kafka-main`) on the topics `order.created`, `order.paid`, `order.shipped` and `notification.requested`. Consumers use consumer groups with manual offset commits after processing.

## Why

Fulfillment and notifications must not slow down checkout. Kafka lets them fall behind and catch up without losing orders.

## Consequences

- Delivery is at-least-once. Every consumer must tolerate redelivery after a rebalance.
- Consumer lag becomes a key health signal for `order-worker` and `notifications`.
- Detailed consumer rules live in [[rfc-order-events]].

=== adr-003
kind: page
parent: sec-adr
title: ADR-003 Application-level Postgres connection pooling
date: 2025-11-24T15:00
author: platform
labels: [adr, database, pg-main, connection-pool, checkout-api]
---
**Status:** Accepted, 2025-11-24. **Deciders:** Jennifer Evans, Ada Isadora.

## Context

Each backend service uses Knex with a connection pool. `pg-main` allows `max_connections = 200`, with 10 reserved for superuser and replication.

## Options considered

1. **Pool per pod (chosen).** Knex pool `max: 20` per pod. Simple, no new component.
2. **PgBouncer in transaction mode** in front of `pg-main`. Lets hundreds of client connections share a small number of server connections. Adds a component to run and breaks session-level features (prepared statements, `SET` per session).

## Decision

Option 1 for launch. Connection budget at launch:

| Service | Pods | Pool max | Connections |
|---|---|---|---|
| checkout-api | 6 | 20 | 120 |
| catalog-api | 2 | 10 | 20 |
| payments-api | 2 | 10 | 20 |
| order-worker | 2 | 5 | 10 |
| **Total** | | | **170 of 190 usable** |

## Consequences and risk

Headroom is only 20 connections. **If `checkout-api` scales beyond 8 pods, or any new workload connects to `pg-main`, we will run out of connections.** Symptoms would be `remaining connection slots are reserved for non-replication superuser connections` from Postgres and `Knex: Timeout acquiring a connection` in the services.

## Revisit when

- `checkout-api` needs more than 8 pods (for example during a sale), or
- a batch job or reporting tool needs its own connections to `pg-main`.

At that point, introduce PgBouncer (option 2) before raising pod counts.

=== adr-004
kind: page
parent: sec-adr
title: ADR-004 One Redis cluster for catalog cache and carts
date: 2025-12-01T10:00
author: catalog
labels: [adr, redis, redis-shared, catalog-api, checkout-api, cart]
---
**Status:** Accepted, 2025-12-01. **Deciders:** Emma Paris, Ada Isadora, Jennifer Evans.

## Decision

`catalog-api` (cache) and `checkout-api` (live shopping carts) share one Redis cluster, `redis-shared`, with `maxmemory 4gb` and `maxmemory-policy noeviction`. Both use logical DB 0 with key prefixes `catalog:` and `cart:`.

## Why noeviction

Carts are customer data. An LRU eviction policy could silently drop a shopper's cart, so Redis must refuse writes instead of evicting.

## Rules that make this safe

- Every `catalog:` key must have a TTL (default 1 hour).
- Carts have a 7 day TTL and are snapshotted to Postgres at checkout start ([[doc-checkout-flow]]).

## Consequences and risk

If cache keys are written without a TTL, memory fills up and Redis rejects **all** writes, including carts, with `OOM command not allowed when used memory > 'maxmemory'`. A catalog bug would then look like a checkout outage.

## Revisit when

Cache memory exceeds 50% of `maxmemory`, or carts need persistence guarantees beyond the checkout snapshot. Splitting into two clusters is the expected next step.

=== adr-005
kind: page
parent: sec-adr
title: ADR-005 Idempotency for PayRail charges
date: 2025-12-03T14:00
author: checkout
labels: [adr, payments-api, idempotency, payrail, webhooks]
---
**Status:** Accepted, 2025-12-03. **Deciders:** Ada Isadora, Alana Grant.

## Decision

1. Every outbound charge or refund request to PayRail carries an `Idempotency-Key` of `order_id:attempt_no`. PayRail returns the original result for a repeated key for 24 hours.
2. Inbound webhooks (`payment.succeeded`, `payment.failed`, `refund.succeeded`) are handled by reading the payment row, checking its status, and updating it if the status changes.

## Not decided now

A deduplication table keyed by PayRail `event_id` with a unique constraint. Not needed at launch volume, revisit after launch.

## Consequences and risk

PayRail delivers webhooks at least once and may send the same event twice within milliseconds. Step 2 is a read-then-write, so two concurrent deliveries can both see the old status. Any new payment type (gift cards, store credit, split payments) must go through the same idempotency path.

=== adr-006
kind: page
parent: sec-adr
title: ADR-006 Server-side rendering on Node for the storefront
date: 2025-12-05T10:00
author: frontend
labels: [adr, storefront-web, frontend, ssr]
---
**Status:** Accepted, 2025-12-05. **Deciders:** Kevin Campbell, Emma Paris.

## Decision

`storefront-web` is a Next.js app rendered on the server in long-running Node pods (not serverless). Product pages are cached at the CDN for 60 seconds.

## Why

SEO for product pages, and fast first paint on mobile.

## Consequences

Because Node processes live for days, any in-process cache or memoized helper must be bounded. Pods have a 1.5 GB memory limit, and Node's default heap limit is lower still. Details in [[doc-storefront-ssr]].

=== doc-storefront-ssr
kind: page
parent: sec-architecture
title: Storefront SSR and caching design
date: 2025-12-08T10:00
author: frontend
labels: [design, storefront-web, frontend, ssr, cache]
---
## Rendering

- Product, category and plant finder pages render on the server. The cart and checkout render on the client.
- Data comes from `catalog-api` (products, search) and `checkout-api` (cart), never directly from a database.

## Caching layers

| Layer | What | TTL |
|---|---|---|
| CDN | Full HTML of product and category pages | 60 s, purged on price change |
| In-process (per pod) | Responsive image `srcset` strings, computed per image URL and width | until pod restart |
| catalog-api / redis-shared | Product JSON | 1 h |

## In-process srcset cache

Computing `srcset` for every product image on every render costs 4 ms per image, so results are memoized in a `Map` keyed by `imageUrl + width`. The catalog has about 3,000 images and 5 widths, so the map stays small. **This assumption only holds while keys come from catalog image URLs.** Do not key the map by anything user-controlled.

## Memory

Pods run with `--max-old-space-size=1024` inside a 1.5 GB container limit. Running out shows up as `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` and a pod restart.

=== doc-checkout-flow
kind: page
parent: sec-architecture
title: Checkout flow design
date: 2025-12-10T10:00
author: checkout
labels: [design, checkout-api, cart, pg-main, redis-shared]
---
## Steps

1. **Cart.** Adds and removes go to `redis-shared` (`cart:<session>` hash, 7 day TTL).
2. **Start checkout.** `checkout-api` copies the cart into the Postgres tables `carts` and `cart_items` and creates an `orders` row with status `pending`. The snapshot protects the cart if Redis loses it ([[adr-004]]).
3. **Pay.** `checkout-api` calls `payments-api` to create a PayRail charge. The shopper sees "Placing your order…" until it returns.
4. **Confirm.** On a PayRail success webhook, `payments-api` marks the payment `succeeded` and `checkout-api` publishes `order.paid`.

## Database usage

Steps 2 to 4 use the `checkout-api` Knex pool ([[adr-003]]). Transactions must be short: **never hold a database transaction open across the PayRail HTTP call.**

## Failure modes

- Redis rejects writes: add-to-cart fails, existing snapshots are safe.
- Postgres pool exhausted: start checkout and confirm hang, then time out after 30 s.
- PayRail slow or down: the shopper waits up to 20 s, then sees "Payment could not be processed".

=== doc-payments-design
kind: page
parent: sec-architecture
title: Payments integration and webhooks design
date: 2025-12-12T10:00
author: checkout
labels: [design, payments-api, payrail, webhooks, idempotency]
---
## PayRail integration

- `payments-api` is the only service that talks to PayRail.
- Charges: `POST /v2/charges` with `Idempotency-Key` ([[adr-005]]). Timeout 20 s, one retry with the same key.
- Refunds: `POST /v2/refunds`, same key rules.

## Webhooks

PayRail posts events to `/webhooks/payrail`. We verify the signature, then:

| Event | Action |
|---|---|
| payment.succeeded | mark payment succeeded, notify checkout-api |
| payment.failed | mark payment failed |
| refund.succeeded | mark refund succeeded, credit subscription if needed |

PayRail retries any webhook that does not get a 2xx within 5 s, and may deliver duplicates even after a 2xx.

## Tables

`payments(id, order_id, payrail_charge_id, amount_cents, status, created_at)` and `refunds(id, payment_id, payrail_refund_id, amount_cents, status)`. See [[doc-schema]].

## Out of scope for v2 launch

Gift cards, store credit and split payments. Any of these must reuse the idempotency path and the webhook handler.

=== rfc-order-events
kind: page
parent: sec-rfc
title: RFC Event-driven order processing
date: 2025-11-10T10:00
author: orders
labels: [rfc, kafka, order-worker, notifications, consumer]
---
**Status:** Accepted, 2025-11-14.

## Proposal

Move fulfillment out of the checkout request into `order-worker`, a Kafka consumer group reading `order.created` and `order.paid` ([[adr-002]]).

## Consumer rules

1. Commit offsets only after the side effect succeeded.
2. Handlers must be idempotent: redelivery after a rebalance is normal.
3. **No slow synchronous calls inside the poll loop.** `max.poll.interval.ms` is 300 s and a batch is up to 500 records. If processing a batch takes longer than that, the broker removes the consumer from the group, the group rebalances, and the batch is processed again. Calls to external APIs (ShipLabel, the SMS provider) must go through a separate topic or an outbox.
4. Alert on consumer group lag.

## Risks

If rule 3 is broken, lag grows, rebalances repeat, and customers get late or duplicate emails, because `notifications` reads the same events.

## Decision

Accepted with the rules above. Max Taylor owns `order-worker`; Ryan Lee owns `notifications`.

=== doc-schema
kind: page
parent: sec-architecture
title: Database schema and data model
date: 2025-11-20T10:00
author: platform
labels: [database, pg-main, schema, data-model]
---
## Ownership

| Schema | Owner service | Tables |
|---|---|---|
| catalog | catalog-api | products, product_images, care_guides, inventory |
| checkout | checkout-api | carts, cart_items, orders, order_items, promo_redemptions |
| payments | payments-api | payments, refunds |
| subscriptions | checkout-api | subscriptions, subscription_renewals |
| fulfillment | order-worker | shipments, shipping_labels |

## Core tables

```sql
orders(id uuid pk, customer_id uuid, status text, total_cents int, currency text,
       shipping_region text, created_at timestamptz, updated_at timestamptz)
order_items(id uuid pk, order_id uuid fk, product_id uuid, qty int, price_cents int)
payments(id uuid pk, order_id uuid fk, payrail_charge_id text, amount_cents int,
         status text, created_at timestamptz)
subscriptions(id uuid pk, customer_id uuid, plan text, next_renewal_on date, status text)
```

## Size expectations

`orders` grows about 40k rows per month and `order_items` about 110k. By late 2026 both are large enough that a table rewrite or a non-concurrent index build takes minutes, not seconds. Follow [[doc-migration-guide]].

## Indexes at launch

`orders(status)`, `orders(customer_id)`, `order_items(order_id)`, `payments(order_id)`. The order history page in the storefront queries by `customer_id` ordered by `created_at`.

=== doc-migration-guide
kind: page
parent: sec-architecture
title: Zero-downtime database migration guide
date: 2025-12-15T10:00
author: platform
labels: [database, pg-main, migrations, guide]
---
Migrations run automatically at deploy time. On `orders`, `order_items` and `payments`, a migration that takes a strong lock stops checkout for as long as it runs.

## Rules

1. **Indexes:** always `CREATE INDEX CONCURRENTLY`, in its own migration with the transaction disabled. A plain `CREATE INDEX` blocks every insert and update on the table.
2. **New columns:** add them nullable without a volatile default, then backfill in batches.
3. **Column type changes:** never `ALTER COLUMN ... TYPE` on a large table; it rewrites the table under an `ACCESS EXCLUSIVE` lock. Add a new column, dual-write, backfill, switch reads, then drop the old one.
4. **Timeouts:** every migration sets `SET lock_timeout = '5s'` so a blocked migration fails fast instead of queueing every query behind it.
5. **Timing:** migrations on the three big tables only outside 08:00 to 22:00 UK time, and never during a sale.

## Symptoms of breaking a rule

Inserts fail with `canceling statement due to lock timeout`, checkout returns 500s, and `pg_stat_activity` shows many sessions waiting on `relation` locks behind the migration.

=== doc-service-catalog
kind: page
parent: sec-architecture
title: Service catalog and glossary
date: 2025-12-01T09:00
updated: 2026-08-03T09:00
author: em
labels: [service-catalog, glossary, ownership]
---
## Services

| Service | Also called | Owner | On-call rotation |
|---|---|---|---|
| storefront-web | storefront, web, SSR | Kevin Campbell | web |
| catalog-api | catalog, search | Emma Paris | core |
| checkout-api | checkout, cart | Ada Isadora | core |
| payments-api | payments, PayRail adapter | Ada Isadora | core |
| order-pipeline | **order-worker** (name until 2026-06-15), orders, fulfillment | Max Taylor | core |
| notifications | mailer, email, SMS | Cassi Owens (Ryan Lee until 2026-08-03) | core |

## Infrastructure

| Name | What |
|---|---|
| pg-main | Postgres 16 primary and replica |
| redis-shared | Redis for catalog cache and carts |
| kafka-main | Kafka cluster for order events |
| smtp-relay | Outbound mail relay `mx-relay-01` |

## Glossary

- **Care Box**: monthly plant subscription, renewed on the 15th of each month.
- **PayRail**: our card payment provider (PSP).
- **ShipLabel**: shipping label API used by fulfillment.

## Change log

- 2026-06-15: `order-worker` renamed to `order-pipeline` when fulfillment and returns were merged. Older incidents, runbooks and dashboards still say `order-worker`.
- 2026-08-03: notifications ownership moved from Ryan Lee (now on the Mobile team) to Cassi Owens.
