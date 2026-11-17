=== c5-inc-1
kind: incident
cluster: C5
title: storefront-web pods restarting, JavaScript heap out of memory
date: 2026-01-27T21:15
resolved: 2026-01-28T11:00
service: storefront-web
priority: Medium
assignee: frontend
reporter: sre
status: resolved
recall: [doc-storefront-ssr, adr-006, st-srcset]
---
## Impact

Every storefront pod restarted every 3 to 4 hours. During each restart, about 1% of page loads got a 502 from the CDN.

## Alert

```
[FIRING] storefront-web container restarts 14 in 1h > 3
```

## First errors

```
<--- Last few GCs --->
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 1: 0xb7c3f0 node::Abort() [node]
```

## Resolution

Heap snapshot showed the `srcset` memo map with 2.1 million entries. A new image CDN added a signed `?sig=` query string to every image URL, so each request produced a new key. Bounded the map with an LRU of 5,000 entries and stripped query strings from keys.
+++ comments
@frontend 2026-01-28T11:00 | The design assumed keys were catalog image URLs. Once URLs became per-request, the map grew without limit.

=== c5-inc-2
kind: incident
cluster: C5
title: Storefront slow then 502s, pods OOMKilled
date: 2026-06-02T18:40
resolved: 2026-06-03T09:30
service: storefront-web
priority: High
assignee: frontend
reporter: catalog
status: resolved
recall: [c5-inc-1, doc-storefront-ssr, st-plant-finder]
---
## Impact

Over 90 minutes, storefront p95 rose from 400 ms to 4 s, then pods were killed and 6% of requests got 502s.

## Alert

```
[FIRING] storefront-web OOMKilled 9 in 30m  (exit code 137)
[FIRING] CDN origin 502 rate 6.1%
```

## First errors

```
Last State: Terminated  Reason: OOMKilled  Exit Code: 137
process memory rss=1.49GB heapUsed=1.02GB
```

## Resolution

The plant finder page (launched 2026-05-28) memoized results with the shared `memoize()` helper, which has no size limit. The cache key included the full query string, including tracking parameters from a marketing email, so it grew with every visitor. Switched to a bounded LRU and normalised the key.
+++ comments
@frontend 2026-06-03T09:30 | Same pattern as January: an unbounded in-process cache keyed by something with unlimited values.

=== c5-ai-lint
kind: action
from: c5-inc-2
title: Ban unbounded in-process caches in storefront-web
date: 2026-06-03T10:00
due: 2026-07-15
assignee: frontend
reporter: frontend
status: todo
priority: Medium
service: storefront-web
labels: [postmortem-action, frontend, performance]
---
After [[c5-inc-2]] (and [[c5-inc-1]]): give `memoize()` a required `maxEntries`, add a lint rule against module-level `new Map()` used as a cache, and add a heap-growth alert (RSS slope over 1 hour).

=== c5-inc-3
kind: incident
cluster: C5
title: Product pages intermittently 502, node memory climbing about 200 MB per hour
date: 2026-10-14T13:20
resolved: 2026-10-15T10:10
service: storefront-web
priority: Medium
assignee: frontend
reporter: sre
status: resolved
recall: [c5-inc-1, c5-inc-2, c5-ai-lint, doc-storefront-ssr]
---
## Impact

Each storefront pod hit its memory limit about every 7 hours; product pages returned 502 for some shoppers during restarts.

## Alert

```
[FIRING] storefront-web container restarts 11 in 6h
```

## First errors

```
Reason: OOMKilled  Exit Code: 137
heap snapshot: i18n/messagesCache Map size=412,880
```

## Resolution

The locale message cache was keyed by the raw `Accept-Language` header (there are hundreds of thousands of distinct values) instead of the resolved locale (6 values). Keyed by resolved locale.
+++ comments
@sre 2026-10-14T14:00 | Third storefront memory leak this year. The lint rule from June is still not in.
