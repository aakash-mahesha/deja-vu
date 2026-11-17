=== c7-inc-1
kind: incident
cluster: C7
title: Search results taking 8 to 12 seconds at the start of the Mother's Day sale
date: 2026-05-08T18:05
resolved: 2026-05-08T18:55
service: catalog-api
priority: High
assignee: catalog
reporter: frontend
status: resolved
recall: [cap-mothers-day]
---
## Impact

For the first 50 minutes of the sale, search and category pages took 8 to 12 seconds. Conversion during that hour was 40% below forecast.

## Alert

```
[FIRING] catalog-api p95 latency 9.8s > 1s  cache_hit_ratio=0.07
```

## First errors

```
cache miss storm: catalog:search:* hit ratio 7%  pg-main catalog queries 1900/s
```

## Resolution

The `catalog-prewarm` CronJob from the capacity plan was scheduled at `30 17 * * *` in UTC, not UK time, so it ran at 18:30 UK, after the sale started. Ran it manually at 18:20; latency normal by 18:50.
+++ comments
@catalog 2026-05-08T18:55 | Cache warm now. CronJob timezone was wrong.

=== c7-pm
kind: postmortem
incident: c7-inc-1
title: Postmortem 2026-05-08 cold catalog cache at sale start
date: 2026-05-13T10:00
author: catalog
labels: [postmortem, catalog-api, cache, sale, capacity-plan]
---
**Incident:** [[c7-inc-1]]. **Severity:** 3. **Author:** Emma Paris.

## Summary

The sale started on a cold cache because the pre-warm job in [[cap-mothers-day]] ran an hour late (UTC versus UK time). The same weekend also had the checkout connection pool incident, see [[c1-pm]].

## Action items

- Pre-warm job: schedule in UTC explicitly and alert if it has not completed 30 minutes before a sale (Emma Paris)
- Create a reusable sale readiness checklist that covers cache warm-up, pod limits against the database connection budget, and the deploy freeze (Alana Grant)

=== c7-ai-prewarm
kind: action
from: c7-pm
title: Alert if catalog pre-warm has not completed before a sale
date: 2026-05-13T11:00
due: 2026-05-29
assignee: catalog
reporter: catalog
status: done
priority: Medium
service: catalog-api
labels: [postmortem-action, cache, sale]
---
From [[c7-pm]]. CronJob uses UTC explicitly; new alert fires if `catalog_prewarm_last_success` is older than the next sale start minus 30 minutes.

=== c7-ai-checklist
kind: action
from: c7-pm
title: Create a reusable sale readiness checklist
date: 2026-05-13T11:05
due: 2026-06-30
assignee: em
reporter: catalog
status: todo
priority: Medium
labels: [postmortem-action, sale, process]
---
From [[c7-pm]]. One page to copy before every sale: cache pre-warm verified, pod limits checked against the database connection budget ([[adr-003]]), deploy and migration freeze, PayRail contact, on-call staffing.

=== c7-inc-2
kind: incident
cluster: C7
title: Search latency p95 6 seconds at the start of the Labor Day promotion
date: 2026-09-07T16:02
resolved: 2026-09-07T16:40
service: catalog-api
priority: Medium
assignee: catalog
reporter: sre
status: resolved
recall: [c7-inc-1, c7-pm, c7-ai-checklist, cap-mothers-day, st-k8s-migration]
---
## Impact

US Labor Day promotion started with search and category pages at 4 to 6 seconds for 35 minutes.

## Alert

```
[FIRING] catalog-api p95 latency 6.1s > 1s  cache_hit_ratio=0.11
```

## Resolution

The `catalog-prewarm` CronJob did not exist on the new cluster `prod-eu-2`: the shared Helm chart only creates CronJobs listed in `values-prod.yaml`, and it was not listed. The pre-warm alert did not fire because its metric was also missing. Ran the job by hand.
+++ comments
@catalog 2026-09-07T16:40 | Lost in the cluster move. Same cold-cache problem as Mother's Day.

=== tk-black-friday
kind: task
trigger: true
title: Black Friday and Cyber Monday 2026 readiness
date: 2026-11-16T09:00
due: 2026-11-25
assignee: em
reporter: em
status: inprogress
labels: [sale, black-friday, capacity-plan]
recall: [cap-mothers-day, c7-pm, c7-ai-checklist, c7-inc-1, c7-inc-2, c1-pm, c1-ai-pgbouncer, c1-ai-hpa, adr-003, c9-inc-1, rb-cert-renewal]
---
Black Friday is 2026-11-27 and Cyber Monday is 2026-11-30. Expected peak is 6x a normal Saturday.

## To do

- Capacity numbers per service (storefront, catalog, checkout, payments, order-pipeline)
- Decide checkout-api pod limits
- Deploy freeze dates
- On-call rota for the weekend
- Confirm with PayRail
