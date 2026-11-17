=== ep-checkout
kind: epic
title: Fernway v2 checkout-api service
date: 2025-11-07T09:00
assignee: checkout
reporter: em
status: done
service: checkout-api
labels: [replatform]
---
Extract cart and checkout from the monolith into `checkout-api`. Design: [[doc-checkout-flow]]. Connection pooling: [[adr-003]].

=== st-checkout-pool
kind: story
parent: ep-checkout
title: Configure Knex pool and connection budget for checkout-api
date: 2025-11-25T09:00
assignee: checkout
reporter: platform
status: done
service: checkout-api
labels: [replatform, database]
---
Set Knex pool `min: 2, max: 20` per pod and an `acquireTimeoutMillis` of 30000, as agreed in [[adr-003]]. HPA for checkout-api: min 4, max 8 replicas.

## Acceptance criteria

- Pool size and acquire timeout come from config, not code.
- Dashboard panel for pool used, pool pending and acquire wait time.

=== st-cart-redis
kind: story
parent: ep-checkout
title: Store live carts in redis-shared with Postgres snapshot at checkout
date: 2025-12-02T09:00
assignee: checkout
reporter: catalog
status: done
service: checkout-api
labels: [replatform, redis, cart]
---
Implement carts as `cart:<session>` hashes in `redis-shared` with a 7 day TTL ([[adr-004]]). Copy to `carts` and `cart_items` at checkout start ([[doc-checkout-flow]]).

=== ep-payments
kind: epic
title: Fernway v2 payments-api and PayRail integration
date: 2025-11-07T09:10
assignee: checkout
reporter: em
status: done
service: payments-api
labels: [replatform, payrail]
---
Build `payments-api` as the only service that talks to PayRail. Design: [[doc-payments-design]], idempotency: [[adr-005]].

=== st-webhooks
kind: story
parent: ep-payments
title: Handle PayRail webhooks for payments and refunds
date: 2025-12-04T09:00
assignee: checkout
reporter: checkout
status: done
service: payments-api
labels: [replatform, webhooks, payrail]
---
Endpoint `/webhooks/payrail`: verify signature, then read payment row, compare status, update. Covers `payment.succeeded`, `payment.failed`, `refund.succeeded`. Event-id dedupe table left for later, see [[adr-005]].

=== ep-orders
kind: epic
title: Fernway v2 order-worker on Kafka
date: 2025-11-07T09:20
assignee: orders
reporter: em
status: done
service: order-pipeline
labels: [replatform, kafka]
---
Fulfillment moves to the `order-worker` consumer group. Design: [[rfc-order-events]], [[adr-002]].

=== st-shiplabel
kind: story
parent: ep-orders
title: Buy shipping labels from ShipLabel in order-worker
date: 2025-12-09T09:00
assignee: orders
reporter: orders
status: done
service: order-pipeline
labels: [replatform, shiplabel]
---
On `order.paid`, call ShipLabel `POST /labels` and store the label. **Shortcut for launch:** the call is made inline in the consumer handler; ShipLabel's p99 is 900 ms today. Move it behind a topic if it gets slower (rule 3 in [[rfc-order-events]]).

=== ep-storefront
kind: epic
title: Fernway v2 storefront-web on Next.js SSR
date: 2025-11-07T09:30
assignee: frontend
reporter: em
status: done
service: storefront-web
labels: [replatform, frontend]
---
New storefront rendered on Node ([[adr-006]], [[doc-storefront-ssr]]).

=== st-srcset
kind: story
parent: ep-storefront
title: Responsive product images with memoized srcset
date: 2025-12-09T10:00
assignee: frontend
reporter: frontend
status: done
service: storefront-web
labels: [replatform, frontend, performance]
---
Generate `srcset` for product images at 5 widths and memoize per image URL in-process, as described in [[doc-storefront-ssr]].

=== ep-catalog
kind: epic
title: Fernway v2 catalog-api with Redis cache
date: 2025-11-07T09:40
assignee: catalog
reporter: em
status: done
service: catalog-api
labels: [replatform]
---
Products, search and care guides served by `catalog-api`, cached in `redis-shared` ([[adr-004]]).

=== ep-notifications
kind: epic
title: Fernway v2 notifications service
date: 2025-11-07T09:50
assignee: notif_old
reporter: em
status: done
service: notifications
labels: [replatform]
---
Email and SMS sent from Kafka events. Email goes through `smtp-relay`.

=== st-care-guides
kind: story
title: Show plant care guides on product pages
date: 2026-01-12T09:00
assignee: catalog
reporter: frontend
status: done
service: catalog-api
labels: [feature, catalog, cache]
---
Serve care guides (watering, light, repotting) from `catalog-api` at `/products/:id/care-guide` and cache the rendered guide in Redis under `catalog:guides:<productId>:<locale>`.

=== st-reporting-export
kind: task
title: Nightly and on-demand order export for finance
date: 2026-02-23T09:00
assignee: platform
reporter: em
status: done
service: pg-main
labels: [reporting, database]
---
Finance needs order exports. Add an export job that reads `orders` and `payments` from `pg-main` with its own pool of 30 connections, and a button in the admin tool to run it on demand.

=== st-plant-finder
kind: story
title: Plant finder quiz page
date: 2026-05-18T09:00
assignee: frontend
reporter: em
status: done
service: storefront-web
labels: [feature, frontend]
---
New SSR page `/plant-finder` that recommends plants from quiz answers (light, pets, experience). Memoize recommendation results per answer combination with the shared `memoize()` helper so repeat visitors are fast.

=== st-rename-pipeline
kind: task
title: Rename order-worker to order-pipeline
date: 2026-06-08T09:00
assignee: orders
reporter: orders
status: done
service: order-pipeline
labels: [rename, kafka]
---
Fulfillment and returns are merging into one service. Rename deployment, consumer group (`order-worker` to `order-pipeline`), dashboards and alerts on 2026-06-15. Update [[doc-service-catalog]]. Runbooks are out of scope for this task.

=== st-ownership-notifications
kind: task
title: Hand over notifications ownership from Ryan Lee to Cassi Owens
date: 2026-07-27T09:00
assignee: em
reporter: em
status: done
service: notifications
labels: [ownership]
---
Ryan Lee moves to the Mobile team on 2026-08-03. Cassi Owens takes over `notifications`. Hand-over list: on-call rotation, dashboards, open bugs. Open postmortem action items assigned to Ryan were **not** part of this hand-over.

=== st-k8s-migration
kind: epic
title: Move all workloads to the new Kubernetes cluster
date: 2026-07-06T09:00
assignee: platform
reporter: em
status: done
labels: [platform, kubernetes]
---
Move every service to the new cluster `prod-eu-2` using the new shared Helm chart. The shared chart sets defaults for HPA (`maxReplicas: 16`), probes and CronJobs. Services override what they need in `values-prod.yaml`.

=== st-care-box-renewals
kind: story
title: Run Care Box subscription renewals inside checkout-api
date: 2026-08-24T09:00
assignee: checkout
reporter: em
status: done
service: checkout-api
labels: [feature, subscriptions]
---
On the 15th of each month, renew all active Care Box subscriptions: create an order and charge the saved card. Run it as a background job inside the `checkout-api` pods so it reuses checkout's order and payment code. About 9,000 renewals per run.
