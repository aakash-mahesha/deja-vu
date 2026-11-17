=== rb-checkout-5xx
kind: page
parent: sec-runbooks
title: Runbook checkout-api 5xx and timeouts
date: 2025-12-18T10:00
author: sre
labels: [runbook, checkout-api]
---
**Alert:** `checkout-api 5xx rate > 2% for 5m` or `checkout p95 > 5s`.

## Triage

1. Check the deploy log. If a deploy went out in the last 30 minutes, roll it back first and investigate after.
2. Check PayRail's status page. If PayRail is degraded, turn on the `payments-degraded-banner` flag and stop here: there is nothing to fix on our side.
3. Check `redis-shared` memory (see [[rb-redis-memory]]). Add-to-cart failures usually mean Redis.
4. Check error logs for `ECONNREFUSED` from `payments-api` and restart unhealthy pods.

## Escalate

Page Ada Isadora (checkout-api owner) if the error rate stays above 2% for 15 minutes.

=== rb-redis-memory
kind: page
parent: sec-runbooks
title: Runbook redis-shared memory pressure
date: 2025-12-18T11:00
author: catalog
labels: [runbook, redis-shared, catalog-api, cache]
---
**Alert:** `redis-shared used_memory > 85% of maxmemory`.

## Steps

1. Find large key groups: `redis-cli --bigkeys` and `INFO keyspace`.
2. Check that `catalog:` keys have TTLs: `redis-cli --scan --pattern 'catalog:*' | head` then `TTL <key>`.
3. If memory is above 95% and catalog keys are the cause, **flush the catalog cache**: `redis-cli -n 0 FLUSHDB`. The catalog repopulates within minutes.
4. Tell Emma Paris (catalog-api) in the incident channel.

=== rb-kafka-lag
kind: page
parent: sec-runbooks
title: Runbook order-worker Kafka consumer lag
date: 2025-12-19T10:00
author: orders
labels: [runbook, kafka, order-worker, consumer-lag]
---
**Alert:** `order-worker consumer group lag > 5000 for 10m`.

## Steps

1. Check lag per partition: `kafka-consumer-groups --describe --group order-worker`.
2. If lag is on every partition, check whether `order-worker` pods are restarting or the group is rebalancing (log line `Attempt to heartbeat failed since group is rebalancing`).
3. Scale `order-worker` up to the partition count (12). More pods than partitions does nothing.
4. If the group keeps rebalancing, look for slow calls inside the handler. See rule 3 in [[rfc-order-events]].

=== rb-cert-renewal
kind: page
parent: sec-runbooks
title: Runbook SMTP relay TLS certificate renewal
date: 2025-11-17T10:00
author: notif_old
labels: [runbook, notifications, smtp-relay, certificate, tls]
---
The outbound mail relay `mx-relay-01` uses a TLS certificate installed by hand. It is **not** renewed automatically. The current certificate was issued on 2025-11-14 and is valid for **one year**, until **2026-11-14**.

## Renewal steps (do this at least 2 weeks before expiry)

1. Request a new certificate for `mx-relay-01.fernway.internal` from the internal CA portal.
2. Copy the certificate and key to `/etc/postfix/tls/` on `mx-relay-01`.
3. `postfix reload`.
4. Send a test email from `notifications`: `npm run send-test -- --to oncall@fernway.shop`.
5. Put a calendar reminder for next year's renewal on the notifications team calendar.
