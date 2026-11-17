=== c4-inc-1
kind: incident
cluster: C4
title: Customer charged twice for one order
date: 2026-02-26T16:40
resolved: 2026-02-27T11:30
service: payments-api
priority: High
assignee: checkout
reporter: sre
status: resolved
recall: [adr-005, doc-payments-design, st-webhooks]
---
## Impact

37 customers were charged twice for the same order between 2026-02-25 and 2026-02-26. All refunded.

## Report

Customer support escalation: "Customer shows two £64.00 charges from FERNWAY for order FW-118204."

## Evidence

```
payments-api webhook payment.succeeded event_id=evt_8KxQ2 received 16:31:07.114
payments-api webhook payment.succeeded event_id=evt_8KxQ2 received 16:31:07.298
both handlers: payment status=pending -> succeeded; both emitted order.paid
```

## Resolution

PayRail delivered the same webhook twice within 200 ms. Both handlers read status `pending` before either wrote `succeeded` (the read-then-write in [[adr-005]]), so `order.paid` fired twice and the subscription flow captured a second charge. Refunded all 37 customers. Hotfix: `SELECT ... FOR UPDATE` on the payment row in the webhook handler.
+++ comments
@checkout 2026-02-27T09:00 | ADR-005 explicitly left the event-id dedupe table for later. Later is now.

=== c4-pm
kind: postmortem
incident: c4-inc-1
title: Postmortem 2026-02-26 duplicate charges from repeated PayRail webhooks
date: 2026-03-02T10:00
author: checkout
labels: [postmortem, payments-api, idempotency, webhooks, payrail]
---
**Incident:** [[c4-inc-1]]. **Severity:** 2. **Author:** Ada Isadora.

## Summary

Two deliveries of the same `payment.succeeded` webhook were processed concurrently. Our handler is read-then-write, so both succeeded and both emitted `order.paid`.

## Root cause

[[adr-005]] made outbound calls idempotent but left inbound webhooks without deduplication by `event_id`.

## Action items

- Deduplicate all PayRail webhooks by event_id with a unique constraint (Ada Isadora)
- Reconciliation job that flags orders with more than one captured charge (Ada Isadora)

=== c4-ai-dedupe
kind: action
from: c4-pm
title: Deduplicate all PayRail webhooks by event_id
date: 2026-03-02T11:00
due: 2026-04-15
assignee: checkout
reporter: checkout
status: inprogress
priority: High
service: payments-api
labels: [postmortem-action, idempotency, webhooks]
---
From [[c4-pm]]. Table `payrail_events(event_id text primary key, received_at)`; insert first, process only if the insert succeeded. **Progress:** done for `payment.succeeded` and `payment.failed`. Not yet done for `refund.succeeded`.

=== c4-ai-recon
kind: action
from: c4-pm
title: Daily reconciliation for orders with more than one captured charge
date: 2026-03-02T11:05
due: 2026-03-27
assignee: checkout
reporter: checkout
status: done
priority: Medium
service: payments-api
labels: [postmortem-action, payments]
---
From [[c4-pm]]. Daily job compares PayRail captures with orders and alerts on any order with two captures.

=== c4-inc-2
kind: incident
cluster: C4
title: Duplicate refunds issued for cancelled Care Box subscriptions
date: 2026-06-18T10:10
resolved: 2026-06-18T15:00
service: payments-api
priority: Medium
assignee: checkout
reporter: notif_new
status: resolved
recall: [c4-inc-1, c4-pm, c4-ai-dedupe, adr-005]
---
## Impact

52 cancelled Care Box subscribers received their refund twice (total £1,820).

## Evidence

```
refund.succeeded event_id=evt_R7m1p processed 2x (10:02:11.402, 10:02:11.587) subscription credited 2x
```

## Resolution

The event-id dedupe from the February postmortem covers payment events but not `refund.succeeded`. Finance recovered the duplicate credits. Refund handler now uses `FOR UPDATE` as a stopgap.
+++ comments
@checkout 2026-06-18T15:00 | Same mechanism as February. Refund path was the unfinished half of the dedupe action item.

=== c4-inc-3
kind: incident
cluster: C4
title: Payment captured twice after PayRail retried slow webhook responses
date: 2026-09-29T19:20
resolved: 2026-09-30T10:00
service: payments-api
priority: High
assignee: checkout
reporter: sre
status: resolved
recall: [c4-inc-1, c4-inc-2, c4-pm, c4-ai-dedupe]
decoys: [c8-inc-2]
---
## Impact

14 orders captured twice. Found by the daily reconciliation job the next morning.

## Evidence

```
reconciliation: order FW-201877 has 2 captures (chg_91aa, chg_91ab)
payments-api: webhook handler took 6.2s (> PayRail 5s timeout); PayRail retried event_id=evt_Q2w9
```

## Resolution

Webhook handling slowed down under evening load, PayRail retried after 5 s, and the retry arrived on a pod running an older build without the dedupe table (a canary that was never promoted). Removed the stale canary, refunded customers.
+++ comments
@checkout 2026-09-30T10:00 | Third duplicate-money incident this year. Every new payment path has to go through the dedupe table.

=== ep-gift-cards
kind: epic
trigger: true
title: Gift cards, purchase and redeem at checkout
date: 2026-11-12T09:00
assignee: checkout
reporter: em
status: todo
service: payments-api
labels: [feature, gift-cards, q1-2027]
recall: [adr-005, doc-payments-design, c4-pm, c4-ai-dedupe, c4-inc-1, c4-inc-2, c4-inc-3]
---
## Goal

Let shoppers buy digital gift cards and redeem them at checkout, alone or together with a card payment. Target: live before Mother's Day 2027.

## Scope

- Buy a gift card (£10 to £200) and email it to a recipient.
- Redeem a gift card code at checkout; the remaining amount is charged to a card.
- A balance that goes down with each redemption and back up on refunds.

## Out of scope

Physical cards, and multi-currency.

=== st-gift-redeem
kind: story
trigger: true
parent: ep-gift-cards
title: Redeem gift card balance as partial payment at checkout
date: 2026-11-12T09:30
assignee: checkout
reporter: em
status: todo
service: checkout-api
labels: [feature, gift-cards]
recall: [adr-005, c4-pm, c4-ai-dedupe, doc-checkout-flow]
---
As a shopper, I can enter a gift card code at checkout and use its balance; the rest goes to my card. When PayRail confirms the card part, the gift card balance is reduced. If the card part is refunded later, the gift card balance is restored.

=== st-gift-ledger
kind: story
trigger: true
parent: ep-gift-cards
title: Gift card balance ledger
date: 2026-11-12T09:45
assignee: checkout
reporter: em
status: todo
service: payments-api
labels: [feature, gift-cards, database]
recall: [adr-005, c4-pm, c4-ai-dedupe, doc-schema]
---
Store gift cards and an append-only ledger of balance changes (`issued`, `redeemed`, `refunded`). Balance updates are triggered by payment and refund webhooks.
