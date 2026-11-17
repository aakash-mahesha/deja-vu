=== c3-inc-1
kind: incident
cluster: C3
title: Order confirmation emails delayed by over an hour
date: 2026-02-14T10:25
resolved: 2026-02-14T13:10
service: order-pipeline
priority: High
assignee: orders
reporter: notif_old
status: resolved
labels: [order-worker]
recall: [rfc-order-events, st-shiplabel, adr-002]
decoys: [o-sms-ratelimit]
---
## Impact

On Valentine's Day morning, confirmation emails arrived 60 to 90 minutes late and shipping labels were not created. 1,200 "where is my order" contacts.

## Alert

```
[FIRING] order-worker consumer group lag 45210 > 5000 (10m)  topic=order.paid
```

## First errors

```
[Consumer clientId=order-worker-3, groupId=order-worker] consumer poll timeout has expired. This means the time between subsequent calls to poll() was longer than the configured max.poll.interval.ms
Attempt to heartbeat failed since group is rebalancing
```

## Resolution

ShipLabel latency rose from 0.9 s to 8 s under Valentine's volume. The inline label call made each batch exceed `max.poll.interval.ms`, so the group rebalanced repeatedly and reprocessed batches. Lowered `max.poll.records` from 500 to 50 and scaled `order-worker` to 12 pods; lag cleared by 13:00.
+++ comments
@orders 2026-02-14T10:50 | Group has rebalanced 31 times in an hour. Every rebalance restarts the batch.
@notif_old 2026-02-14T11:30 | notifications reads the same events, so emails are late too. Some customers got two confirmations after the rebalances.

=== c3-pm
kind: postmortem
incident: c3-inc-1
title: Postmortem 2026-02-14 order-worker rebalance storm
date: 2026-02-17T14:00
author: orders
labels: [postmortem, kafka, order-worker, notifications, consumer-lag]
---
**Incident:** [[c3-inc-1]]. **Severity:** 2. **Author:** Max Taylor.

## Summary

`order-worker` called ShipLabel synchronously inside the Kafka poll loop ([[st-shiplabel]]). When ShipLabel slowed to 8 s per call, a batch took longer than `max.poll.interval.ms`, the consumer was removed from the group, the group rebalanced, and the batch was redelivered. This repeated for three hours. `notifications` sent duplicate confirmation emails on redelivery.

## Root cause

Rule 3 of [[rfc-order-events]] (no slow synchronous calls in the poll loop) was knowingly deferred for launch.

## Action items

- Move ShipLabel calls to a separate `label.requested` topic with its own consumer (Max Taylor)
- Alert on consumer group rebalances, not only lag (Mitch Davis)
- Deduplicate confirmation emails by order ID and event type in notifications (Ryan Lee)

=== c3-ai-async
kind: action
from: c3-pm
title: Move ShipLabel calls out of the order-worker poll loop
date: 2026-02-17T15:00
due: 2026-04-30
assignee: orders
reporter: orders
status: inprogress
priority: High
service: order-pipeline
labels: [postmortem-action, kafka]
---
From [[c3-pm]]. Publish `label.requested` and handle it in a separate consumer with retries and backoff. Status: topic created, consumer half-built; paused for the rename and returns work.

=== c3-ai-alert
kind: action
from: c3-pm
title: Alert on order-worker consumer group rebalances
date: 2026-02-17T15:05
due: 2026-03-06
assignee: sre
reporter: orders
status: done
priority: Medium
service: order-pipeline
labels: [postmortem-action, monitoring]
---
From [[c3-pm]]. Alert when the group rebalances more than 3 times in 15 minutes.

=== c3-ai-dedupe
kind: action
from: c3-pm
title: Deduplicate order confirmation emails in notifications
date: 2026-02-17T15:10
due: 2026-03-31
assignee: notif_old
reporter: orders
status: todo
priority: Medium
service: notifications
labels: [postmortem-action, notifications, idempotency]
---
From [[c3-pm]]. Keep a record of `(order_id, event_type)` sent in the last 7 days and skip duplicates. Redelivery is normal per [[adr-002]].

=== c3-inc-2
kind: incident
cluster: C3
title: Orders stuck in Paid, order-worker group rebalancing repeatedly
date: 2026-04-11T11:05
resolved: 2026-04-11T12:20
service: order-pipeline
priority: High
assignee: orders
reporter: sre
status: resolved
labels: [order-worker]
recall: [c3-inc-1, c3-pm, c3-ai-async]
---
## Impact

Orders stayed in status Paid for up to 70 minutes. No shipping labels created during that time.

## Alert

```
[FIRING] order-worker rebalances 9 in 15m > 3
[FIRING] order-worker consumer group lag 18900 > 5000
```

## First errors

```
Member order-worker-7 sending LeaveGroup request to coordinator due to consumer poll timeout has expired
```

## Resolution

ShipLabel had a slow deploy on their side (p95 6 s). Lowered `max.poll.records` to 20 for the day. Same mechanism as February.
+++ comments
@orders 2026-04-11T12:20 | Async label work would have made this a non-event.

=== c3-inc-3
kind: incident
cluster: C3
title: Customers receiving duplicate order confirmed emails
date: 2026-07-30T09:40
resolved: 2026-07-30T11:15
service: notifications
priority: Medium
assignee: notif_old
reporter: notif_new
status: resolved
recall: [c3-inc-1, c3-pm, c3-ai-dedupe, c3-ai-async, rfc-order-events]
---
## Impact

About 2,300 customers received two or three "Your order is confirmed" emails. Some thought they had been charged twice.

## Alert

No alert. Reported by customer support.

## Symptoms

```
notifications: sent template=order_confirmed order=4d1a... (3 times in 6 min)
order-pipeline: group rebalanced 6 times between 09:05 and 09:35
```

## Resolution

order-pipeline rebalanced during a slow ShipLabel period and redelivered `order.paid`. notifications has no dedupe, so each redelivery sent another email. Sent a "you were charged once" apology email.
+++ comments
@notif_new 2026-07-30T10:00 | Taking this over from Ryan next week. Is there an existing ticket for dedupe?
@notif_old 2026-07-30T11:15 | There was an action item from the February postmortem. I never got to it.

=== c3-inc-4
kind: incident
cluster: C3
title: order-pipeline lag growing, fulfillment SLA breached
date: 2026-10-05T08:15
resolved: 2026-10-05T10:40
service: order-pipeline
priority: High
assignee: orders
reporter: sre
status: resolved
recall: [c3-inc-1, c3-inc-2, c3-inc-3, c3-pm, c3-ai-async, c3-ai-dedupe, rb-kafka-lag]
decoys: [o-kafka-disk, o-warehouse-address]
---
## Impact

40% of Monday morning orders missed the 2 hour pick-and-pack SLA.

## Alert

```
[FIRING] order-pipeline consumer group lag 27400 > 5000 (10m)  topic=order.paid
```

## First errors

```
CommitFailedException: Commit cannot be completed since the group has already rebalanced and assigned the partitions to another member.
```

## Resolution

Followed the lag runbook, which still refers to the old group name `order-worker`, so the first `kafka-consumer-groups --describe` showed nothing. Found the right group after 20 minutes. Cause again: slow ShipLabel calls inline. Lowered `max.poll.records`.
+++ comments
@sre 2026-10-05T08:40 | Runbook says `--group order-worker`. Group is `order-pipeline` since June.
@orders 2026-10-05T10:40 | Fourth time this year. The async label consumer is 60% done.
