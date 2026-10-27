<div align="center">

<img src="static/icons/superport.svg" alt="SUPERPORT" width="72" height="72" />

# Group & User Management for Jira

**Self-service Atlassian groups for project admins — safe, audited, and reversible.**

A SUPERPORT [Atlassian Forge](https://developer.atlassian.com/platform/forge/) app for Jira Cloud.

![Forge](https://img.shields.io/badge/Atlassian-Forge-0052CC?logo=atlassian&logoColor=white)
![Jira Cloud](https://img.shields.io/badge/Jira-Cloud-0052CC?logo=jira&logoColor=white)
![Node.js 22](https://img.shields.io/badge/Node.js-22.x-339933?logo=nodedotjs&logoColor=white)
![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Rovo](https://img.shields.io/badge/Rovo-agent-6554C0)
![Tests](https://img.shields.io/badge/tests-61%20passing-2EA043)
![i18n](https://img.shields.io/badge/i18n-EN%20%7C%20DE-lightgrey)

</div>

---

> 📘 **New here?** Read the [first-time user tutorial](TUTORIAL.md) — step by step for project admins, members, Jira admins and auditors.

## Why

In most Jira sites only site admins can create groups or change who is in them, so project admins
end up filing tickets for every new teammate. **Group & User Management** hands that job to the
project admins — inside a fixed naming convention, with guardrails, an append-only audit log, and
one-click undo for every change. Jira admins keep global control.

## Highlights

| | |
| --- | --- |
| 🧩 **Project-owned groups** | Create real Atlassian groups named `atlassian-<KEY>-<name>`, with name checks against current *and* previous project keys. |
| 👥 **Member management** | Search, paging, active/deactivated status, add several people at once, or paste a list of emails/names and review each match before adding. |
| 🗺️ **People matrix** | "Who is in which group" — plan additions and removals across all project groups, review them, apply as one batch, undo as one batch. |
| 🔍 **Where-used analysis** | 9 checks: permission schemes, workflows, project roles, issue security levels, notification schemes, shared filters, dashboards, Confluence space permissions and page restrictions. |
| ⚠️ **Impact before removal** | The confirmation shows exactly which schemes and workflows a person loses access through. |
| ↩️ **Undo everything** | Every add, remove, end date, review and config change can be undone; failed items get a Retry. |
| ⏳ **Time-limited access** | Set an end date per membership; an hourly job removes expired access and logs it. |
| 📨 **Access requests** | Project members request access (with reason and 7/30/90 days); project admins approve or deny. |
| ✅ **Access reviews** | Periodic reviews (3/6/12 months) with due badges, mandatory confirmation, and audit notes — ISO 27001 friendly. |
| 📜 **Audit log** | Append-only, filterable, CSV export, project or global scope, configurable retention. Read-only page for auditors. |
| 🔒 **Hard guardrails** | Atlassian core and product-access groups are always blocked; IdP/SCIM-synced groups are read-only. |
| 🤖 **Rovo agent** | 11 actions (list, details, where-used, audit, compliance, create, add/remove, end date, description, requests) — confirms before every change, runs through the same permission checks, tagged "via Rovo". |
| 🧭 **Built-in guided tour** | First-time users get a step-by-step tour that highlights the real controls, tailored to their page (project admin, member, Jira admin, auditor). Reopen it any time with **Tutorial**. |
| 🌍 **Native feel** | Follows Jira's light/dark theme and the user's locale (English/German); Jira flags for notifications; respects `prefers-reduced-motion`. |

## Where it lives in Jira

| Module | Who | What |
| --- | --- | --- |
| **Project settings → Groups** | Project admins | Groups, members, people matrix, where-used, requests, audit log |
| **Project page → My groups** | Project members | Own groups (read-only) and access requests |
| **Apps → Group audit log** | Auditors & Jira admins | Read-only global audit log with CSV export |
| **Admin → Group & User Management** | Jira admins | Configuration, block list, IdP groups, compliance overview, Org API status |
| **Rovo → Group & User Management** | Project admins | Conversational group management |

Background jobs: daily audit retention, hourly membership expiry, hourly Confluence restriction
index, optional daily cleanup of deactivated accounts, and SQL migrations on install/upgrade.

## Architecture

```mermaid
flowchart LR
    UI["Custom UI<br/>React 18 · Vite · framer-motion"] -->|"@forge/bridge invoke"| R["Resolver<br/>src/index.js"]
    Rovo["Rovo agent<br/>src/rovo.js"] --> S
    Jobs["Scheduled triggers"] --> S
    R --> S["Core service<br/>src/core"]
    S --> J["jiraClient<br/>Jira REST (reads)"]
    S --> O["orgClient<br/>Organization Admin API (writes)"]
    S --> C["confluenceClient<br/>usage checks"]
    S --> K["kvsStore<br/>Forge KVS"]
    S --> A["sqlAudit<br/>Forge SQL"]
```

The core service is platform-free and gets its Jira, storage and audit back ends **injected** —
the same code runs in Forge, in the test suite, and in the browser click-dummy.

```
manifest.yml        Forge modules, Rovo agent & actions, triggers, scopes
src/index.js        Resolver wiring – builds the trusted context from Forge
src/core/           Business logic: service, naming, blocklist, csv, errors
src/forge/          Adapters: Jira, Organization API, Confluence, KVS, SQL, usage
src/rovo*.js        Rovo agent actions
src/dev/            In-memory adapters + demo seed (tests & click-dummy only)
static/app/         Custom UI (React 18 + Vite)
test/               node:test suite
scripts/            Offline manifest validation
```

## Getting started

**Prerequisites:** Node.js 22+, the [Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/) (for deploying).

```bash
npm install
npm --prefix static/app install
npm test
```

### Try it without Jira

The click-dummy runs the real service against in-memory demo data:

```bash
npm run dev:ui
```

Open http://localhost:3000. Useful query parameters:

| Parameter | Effect |
| --- | --- |
| `view=admin\|member\|auditor` | Switch role / page |
| `lang=en` | Force language |
| `theme=dark` | Dark theme |
| `fast` | No simulated latency |
| `motion=off` | Skip animations |
| `org=off` | Simulate a missing Organization API key |

`npm run build:demo` produces a static copy in `static/app/demo-build/` that can be hosted anywhere.

### Deploy to Jira Cloud

```bash
forge register
npm run deploy
forge install --site <site>.atlassian.net --product jira
```

`npm run validate` checks the manifest against the Forge schema offline. `forge tunnel` serves the
UI from the Vite dev server on port 3000.

### Connect the Organization API

Atlassian does not let apps create groups or change memberships through the Jira REST API, so all
group **writes** go through the Atlassian Organization Admin API (reads still use Jira).

1. An org admin creates an API key at **admin.atlassian.com → Settings → API keys** (unscoped).
2. Store it as Forge variables:

   ```bash
   forge variables set -e development ORG_ID <org-id>
   forge variables set -e development --encrypt ORG_API_KEY <api-key>
   ```

   Set `ORG_DIRECTORY_ID` too if the org has more than one user directory.
3. Deploy and upgrade the installation (the egress to `https://api.atlassian.com` is a major version):

   ```bash
   npm run deploy
   forge install --upgrade --site <site> --product jira -e development
   ```

4. The admin page shows the connection status; **Test connection** re-runs the check.

For Confluence usage checks, install the app in Confluence on the same site:

```bash
forge install -p Confluence -s <site> -e <env>
```

## Security model

- The trusted context (project, account) always comes from Forge, never from the client.
- Every write re-checks project-admin rights and group ownership (stored project id **and** key prefix).
- Blocked and IdP-synced groups are never changed, by the UI, the API, the Rovo agent or the automations.
- Rovo actions act as the calling user, add at most 10 / remove at most 5 people per call, and never guess ambiguous names.
- The audit log is append-only; its only delete is the configured retention purge.

## Scripts

| Command | Description |
| --- | --- |
| `npm test` | Run the node:test suite |
| `npm run dev:ui` | Start the click-dummy on port 3000 |
| `npm run build:ui` | Build the Custom UI for Forge |
| `npm run build:demo` | Build the static demo |
| `npm run validate` | Validate `manifest.yml` offline |
| `npm run deploy` | Build the UI and `forge deploy` |

---

<div align="center">
<sub>Built by <b>SUPERPORT</b> · Proprietary — all rights reserved</sub>
</div>
