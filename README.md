# Déjà Vu

Déjà Vu is an Atlassian Forge app for Jira, Jira Service Management, Confluence and Rovo. It stops teams from fighting the same problem twice.

When you open an incident, a ticket or a page, Déjà Vu finds the older items that matter and says why:

- **Repeats:** earlier incidents with the same cause, and how each one was fixed ("5th occurrence, 2 in the last 90 days").
- **Follow-up debt:** postmortem action items from those occurrences that are still open, with owner and age.
- **Read first:** design decisions, RFCs, runbooks and postmortems on the same mechanism, even a year old.

Matching is deterministic and explained: every result lists the reason (the same error line, shared technical terms, a link the team made, the decision it cites). No external LLM or API key is needed. The Rovo agent only phrases the answer.

## What is in the app

| Surface | What it does |
|---|---|
| Jira issue panel | Repeat banner, past fixes, open follow-ups with **Escalate** (confirmation dialog), **Link past occurrences**, postmortems, read-first documents |
| Rovo agent "Déjà Vu" | The same answers in chat. Actions: `find-related`, `get-followup-debt`, and the two-step `link-related` and `escalate-action-item` (preview first, act only after the user confirms) |
| Rovo MCP | `find-related` and `get-followup-debt` as tools for external MCP clients (Preview; an admin must enable it under Connected apps) |
| Admin page | Index status, Index now, settings (projects, spaces, date field, service aliases), Use demo settings, audit log |
| Triggers | Issue and page events keep the index fresh; a queue consumer runs resumable full crawls; a daily sweep catches anything missed |

Data stays in Atlassian: the index is held in Forge SQL and the settings in Forge KVS. Results are filtered to what the viewing user can open, and every write runs as the confirming user and is recorded in the audit log.

## Install and run

Needs the Forge CLI and Node.js 22 or later.

```bash
npm install
forge deploy -e development
forge install -e development --site <your-site>.atlassian.net --product jira
forge install -e development --site <your-site>.atlassian.net --product confluence
```

Then, in Jira, go to **⚙ Settings → Apps → Déjà Vu**:
1. Choose what to index, or click **Use demo settings** for the seeded demo site.
2. Click **Index everything**.
3. Open an incident and open the **Déjà Vu** panel from the issue's **Apps** button.

## Demo data

`seed/` contains the fictional company **Fernway**: an online plant shop with six services. Its corpus has 93 Jira/JSM issues and 35 Confluence pages written as one connected history: designs, ADRs, incidents, postmortems and action items. It includes planted repeat clusters, look-alike decoys and items dated this week that trigger the demo. All of it is seeded demo data.

```bash
export ATL_SITE=https://<your-site>.atlassian.net ATL_EMAIL=<you> ATL_TOKEN=<api token>
npm run seed:check   # validate the corpus and write seed/ground-truth.json
npm run seed         # create the projects, space, issues and pages on the site (re-runs are idempotent)
```

## Evaluation

`npm run eval` replays every labelled query in `seed/ground-truth.json` against the site. It uses the same matching code as the app, and each query only sees items older than itself.

On the seeded site (129 documents, 49 queries):

| Metric | Result |
|---|---|
| Repeat precision | 1.00 |
| Repeat recall | 0.81 |
| Recall of expected older items | 0.84 |
| Decoys reported as repeats | 0 |

## Project layout

```
src/core/       matching engine (pure TypeScript, shared with the eval)
src/store/      Forge SQL index, settings, audit log
src/ingest/     Jira/Confluence clients, indexer and crawls
src/services/   use cases shared by the panel, Rovo and MCP
src/actions/    Rovo/MCP action handlers
src/resolvers/  issue panel and admin page resolvers
src/frontend/   UI Kit issue panel and admin page
src/agent/      Rovo agent prompt
seed/           demo world, corpus, settings, ground truth
scripts/        seed push script
eval/           offline evaluation
```

## License

MIT, see [LICENSE](LICENSE). Third-party packages, including the Atlassian Forge SDK under the Atlassian Developer Terms, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
