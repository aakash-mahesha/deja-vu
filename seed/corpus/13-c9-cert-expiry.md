=== c9-inc-1
kind: incident
cluster: C9
title: Order confirmation emails not sending, SMTP TLS handshake failing
date: 2025-11-14T08:30
resolved: 2025-11-14T12:45
service: notifications
priority: High
assignee: notif_old
reporter: sre
status: resolved
---
## Impact

No emails (order confirmations, password resets, shipping updates) were sent for 4 hours. 6,800 emails queued.

## Alert

```
[FIRING] notifications email send failure rate 100% (10m)  relay=mx-relay-01
```

## First errors

```
Error: SMTP TLS handshake failed: certificate has expired  host=mx-relay-01.fernway.internal:587
    at TLSSocket.onConnectSecure (node:_tls_wrap:1674)
```

## Resolution

The relay's certificate, installed by hand in 2024, expired at 00:00 UTC. Ryan requested a new certificate from the internal CA, installed it on `mx-relay-01` and reloaded Postfix. The queue drained by 13:30. New certificate valid until 2026-11-14.
+++ comments
@notif_old 2025-11-14T09:10 | Nobody had a reminder for this. Requesting a new cert now.
@notif_old 2025-11-14T12:45 | Fixed. Writing a runbook so next year is not a surprise.

=== c9-pm
kind: postmortem
incident: c9-inc-1
title: Postmortem 2025-11-14 expired SMTP relay certificate
date: 2025-11-18T10:00
author: notif_old
labels: [postmortem, notifications, smtp-relay, certificate, tls]
---
**Incident:** [[c9-inc-1]]. **Severity:** 2. **Author:** Ryan Lee.

## Summary

The TLS certificate on `mx-relay-01` expired and every email failed for four hours. The certificate was installed manually with no monitoring and no reminder.

## Root cause

Manual certificate lifecycle with no expiry alert.

## Action items

- Automate SMTP relay certificate renewal with cert-manager (Ryan Lee)
- Alert 30 days before any TLS certificate expires (Mitch Davis)
- Write a renewal runbook: done, see [[rb-cert-renewal]]

=== c9-ai-automate
kind: action
from: c9-pm
title: Automate SMTP relay certificate renewal with cert-manager
date: 2025-11-18T11:00
due: 2026-02-28
assignee: notif_old
reporter: notif_old
status: todo
priority: High
service: notifications
labels: [postmortem-action, certificate, tls]
---
From [[c9-pm]]. Move `mx-relay-01` to a certificate issued and renewed by cert-manager. Until then the renewal is manual, see [[rb-cert-renewal]]; current certificate expires **2026-11-14**.

=== c9-ai-alert
kind: action
from: c9-pm
title: Alert 30 days before any TLS certificate expires
date: 2025-11-18T11:05
due: 2025-12-19
assignee: sre
reporter: notif_old
status: todo
priority: Medium
service: notifications
labels: [postmortem-action, monitoring, certificate]
---
From [[c9-pm]]. Add a blackbox exporter check for certificate expiry on every external and internal TLS endpoint, alerting 30 days ahead.

=== c9-inc-2
kind: incident
cluster: C9
trigger: true
title: Password reset and order emails failing with x509 error
date: 2026-11-15T07:55
service: notifications
priority: High
assignee: notif_new
reporter: notif_new
status: inprogress
recall: [c9-inc-1, c9-pm, rb-cert-renewal, c9-ai-automate, c9-ai-alert]
---
## Impact

Since some time on Saturday, no transactional emails are being delivered. Customers cannot reset passwords. 4,100 messages queued.

## Alert

```
[FIRING] notifications email send failure rate 100% (10m)
```

## First errors

```
Error: x509: certificate has expired or is not yet valid: current time 2026-11-15T07:41:12Z is after 2026-11-14T00:00:00Z
    dial tcp mx-relay-01.fernway.internal:587
```

## Notes

I have not worked on the mail relay before. Investigating whether the relay host changed.
