=== o-sms-ratelimit
kind: incident
title: Order shipped text messages delayed, SMS provider rate limiting
date: 2025-12-22T17:30
resolved: 2025-12-22T19:00
service: notifications
priority: Low
assignee: notif_old
reporter: sre
status: resolved
---
## Impact

"Your order has shipped" texts arrived up to 2 hours late on the last pre-Christmas shipping day. Email was not affected.

## First errors

```
SmsProviderError: 429 Too Many Requests  retry-after=60  account=fernway-prod
```

## Resolution

We exceeded our SMS plan's 20 messages per second. The provider raised the limit to 60 per second for December. Kafka consumer lag was normal; the queue was inside the SMS client.

=== o-cdn-stale
kind: incident
title: Wrong prices shown on product pages after price update
date: 2026-01-08T09:20
resolved: 2026-01-08T10:05
service: storefront-web
priority: High
assignee: frontend
reporter: catalog
status: resolved
---
## Impact

For 45 minutes, about 300 product pages showed last week's prices. Checkout charged the correct new price, which confused shoppers.

## Resolution

The price update job calls the CDN purge API after writing prices. The CDN API token had been rotated on 2026-01-07 and the job's secret was not updated, so purges returned 401 and pages stayed cached. Updated the secret and purged manually.

=== o-images-404
kind: incident
title: Product images returning 404 for older products
date: 2026-02-03T08:40
resolved: 2026-02-03T12:30
service: catalog-api
priority: Medium
assignee: catalog
reporter: frontend
status: resolved
---
## Impact

Images for about 1,400 products created before 2025 showed broken placeholders.

## Resolution

A storage bucket lifecycle rule added to clean up temporary uploads matched the `originals/` prefix too and deleted original images older than 365 days. Restored from versioned backups and fixed the rule's prefix.

=== o-promo-twice
kind: incident
title: Promo code SPRING20 applied twice to cart total
date: 2026-03-02T11:15
resolved: 2026-03-02T13:40
service: checkout-api
priority: Medium
assignee: checkout
reporter: em
status: resolved
decoys: [c4-inc-1]
---
## Impact

For 2 hours, the SPRING20 code took 40% off instead of 20% when shoppers clicked Apply twice. 210 orders affected; we honoured the price.

## Resolution

The Apply button did not disable while the request was in flight, and the promo service did not check for an existing redemption of the same code on the cart. Added a unique constraint on `promo_redemptions (cart_id, code)`. No payment was charged twice; this was a discount calculation bug.

=== o-translations
kind: incident
title: German translations missing on the checkout page
date: 2026-03-30T10:00
resolved: 2026-03-30T11:20
service: storefront-web
priority: Low
assignee: frontend
reporter: notif_new
status: resolved
---
## Impact

German shoppers saw raw keys such as `checkout.shipping.title` on the checkout page for 80 minutes.

## Resolution

The translation export from the localisation tool dropped the `de` file because of an invalid plural rule in one string. Fixed the string and re-ran the export; added a build check that every locale file is present.

=== o-applepay
kind: incident
title: Apple Pay button missing for Safari shoppers
date: 2026-04-15T12:30
resolved: 2026-04-15T16:10
service: payments-api
priority: Medium
assignee: checkout
reporter: frontend
status: resolved
decoys: [c8-inc-1]
---
## Impact

Apple Pay did not appear at checkout for about 4 hours. Card payments worked.

## Resolution

The Apple Pay domain verification file under `/.well-known/` was removed by a storefront routing change. PayRail's Apple Pay check failed, so the button was hidden. Restored the file and added it to the storefront smoke tests.

=== o-warehouse-address
kind: incident
title: Shipping labels printed with the old warehouse return address
date: 2026-05-20T09:10
resolved: 2026-05-20T10:30
service: order-pipeline
priority: Medium
assignee: orders
reporter: em
status: resolved
labels: [order-worker]
decoys: [c3-inc-2]
---
## Impact

About 800 labels printed with the Bristol return address after the move to the Leeds warehouse.

## Resolution

A config typo in `order-worker` (`RETURN_ADDRESS_ID=wh_bris` left in the production overlay) after the warehouse move. Fixed the config and reprinted labels for parcels not yet collected. No Kafka lag; consumers were healthy.

=== o-uk-region-null
kind: incident
title: Checkout 500s after deploy, null shipping region for UK addresses
date: 2026-06-10T15:05
resolved: 2026-06-10T15:30
service: checkout-api
priority: High
assignee: checkout
reporter: sre
status: resolved
decoys: [c1-inc-1, c6-inc-1]
---
## Impact

25 minutes of checkout errors for UK shoppers (about 70% of traffic).

## First errors

```
TypeError: Cannot read properties of null (reading 'code')
    at resolveShippingZone (checkout-api/src/shipping/zones.ts:22)
```

## Resolution

Deploy `2026.06.10-2` changed address parsing; UK postcodes without a space returned a null region. Rolled back at 15:28. Database and pool were healthy throughout.

=== o-kafka-disk
kind: incident
title: Kafka broker disk at 92 percent
date: 2026-06-24T07:50
resolved: 2026-06-24T09:30
service: order-pipeline
priority: Medium
assignee: platform
reporter: sre
status: resolved
labels: [kafka-main]
decoys: [c3-inc-2]
---
## Impact

No customer impact. Risk of broker failure if disk filled.

## Alert

```
[FIRING] kafka-main broker-2 disk used 92% > 85%
```

## Resolution

The new `order.audit` topic was created with `retention.ms=-1` (keep forever) instead of 7 days. Set retention to 7 days; disk fell to 41%. Consumer lag was normal throughout.

=== o-search-accents
kind: incident
title: Search returns no results for queries with accents
date: 2026-07-08T13:00
resolved: 2026-07-09T10:00
service: catalog-api
priority: Low
assignee: catalog
reporter: notif_new
status: resolved
---
## Impact

Searches like "monstera délicieuse" or "café plant" returned nothing.

## Resolution

The new search index analyzer did not include ASCII folding. Added the folding filter and reindexed overnight.

=== o-flag-pdp
kind: incident
title: New product page layout shown to all mobile shoppers and broken
date: 2026-07-14T11:30
resolved: 2026-07-14T11:52
service: storefront-web
priority: High
assignee: frontend
reporter: em
status: resolved
decoys: [c5-inc-2]
---
## Impact

For 20 minutes, every mobile shopper got the unfinished `new-pdp` layout, with the Add to basket button hidden below the fold.

## Resolution

The `new-pdp` feature flag was set to 100% instead of 10% when the rollout was edited. Set it back to 10% and added a confirmation step for rollouts above 50%.

=== o-replica-lag
kind: incident
title: Postgres read replica lag 15 minutes, order history out of date
date: 2026-08-11T10:20
resolved: 2026-08-11T11:45
service: checkout-api
priority: Medium
assignee: platform
reporter: frontend
status: resolved
labels: [pg-main]
decoys: [c1-inc-3]
---
## Impact

New orders did not appear in customers' order history for up to 15 minutes. Checkout itself was fine.

## Resolution

A finance analyst ran a long reporting query on the replica, which blocked WAL replay (`max_standby_streaming_delay = -1`). Cancelled the query and set `max_standby_streaming_delay` to 30 s. Primary connections were normal.

=== o-consent-filter
kind: incident
title: Subscription reminder emails sent to unsubscribed customers
date: 2026-09-02T08:00
resolved: 2026-09-02T10:30
service: notifications
priority: High
assignee: notif_new
reporter: em
status: resolved
decoys: [c3-inc-3]
---
## Impact

About 5,100 customers who had opted out of marketing received a Care Box reminder.

## Resolution

A template refactor moved the reminder from the marketing category to transactional, which skips the consent filter. Moved it back, notified the data protection officer, sent no further emails.

=== o-3ds-loop
kind: incident
title: 3-D Secure challenge loops for one bank's cards
date: 2026-09-22T12:10
resolved: 2026-09-22T17:00
service: payments-api
priority: Medium
assignee: checkout
reporter: notif_new
status: resolved
decoys: [c8-inc-2]
---
## Impact

Shoppers with cards from one UK bank were sent back to the 3-D Secure challenge after approving it. About 300 failed payments.

## Resolution

Our return URL lost the `payment_intent` parameter when the bank's page posted back with a different encoding. Fixed URL handling in payments-api. PayRail itself was healthy.

=== o-dns-cname
kind: incident
title: www.fernway.shop unreachable after registrar migration
date: 2026-10-20T06:10
resolved: 2026-10-20T06:32
service: storefront-web
priority: Highest
assignee: frontend
reporter: sre
status: resolved
---
## Impact

The website was unreachable for 22 minutes early in the morning.

## Resolution

During the move to a new registrar, the `www` CNAME was entered with a typo pointing at a non-existent CDN hostname. Corrected the record; TTL was 300 s so recovery was quick.

=== o-ratelimit-allowlist
kind: incident
title: catalog-api returning 429 to storefront after network change
date: 2026-11-03T14:20
resolved: 2026-11-03T14:55
service: catalog-api
priority: High
assignee: catalog
reporter: frontend
status: resolved
decoys: [c2-inc-4]
---
## Impact

Product and search pages failed for about 30% of requests for 35 minutes.

## First errors

```
catalog-api ratelimit: 429 client=10.42.0.0/16 limit=500rps
```

## Resolution

A network change gave storefront pods new source IPs that were not in the internal rate limiter's allowlist, so all storefront traffic shared one anonymous limit. Added the new range. Redis was healthy.
