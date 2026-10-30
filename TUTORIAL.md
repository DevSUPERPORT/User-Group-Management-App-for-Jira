# Getting started with Group & User Management

A step-by-step guide for first-time users. Find your role, follow the steps, done.

| I am a… | Go to |
| --- | --- |
| **Project admin** — I manage the people in my project | [Part 1](#part-1--project-admins) |
| **Project member** — I need access to a group | [Part 2](#part-2--project-members) |
| **Jira admin** — I set the app up for everyone | [Part 3](#part-3--jira-admins) |
| **Auditor** — I check who had access and when | [Part 4](#part-4--auditors) |
| **Rovo user** — I prefer to just ask | [Part 5](#part-5--using-the-rovo-agent) |

> 🧭 **Prefer to learn inside the app?** The first time you open any page of the app, a short guided tour starts and points at the real buttons. Click **Tutorial** at the top of the page to run it again.

> **Good to know before you start**
> - Every change can be undone. Look for the **Undo** button in the notification that appears after each change.
> - Every change is written to the audit log, with who did it and when.
> - Groups marked **IdP sync** are managed by your identity provider. You can see their members, but not change them.
> - Protected Atlassian groups (admins, product access) are never shown or changed by the app.

---

## Part 1 — Project admins

**Open the app:** your project → **Project settings** → **Groups**.

You'll see four tabs: **Groups**, **People**, **Requests** and **Audit log**.

### 1.1 Create your first group

1. Click **Create group** (top right).
2. Type the last part of the name. The prefix `atlassian-<PROJECTKEY>-` is fixed.
   - Allowed: lowercase letters, digits, single hyphens. Max 60 characters.
   - Wait for the green **Name is available** check.
3. *(Optional)* Add a **Description** — what the group is for.
4. *(Optional)* Under **Start with the members of**, pick an existing project group to copy its members (max 50).
5. Leave **Add me as the first member** ticked if you want to be in it.
6. Click **Create group**.

> ⚠️ The name **cannot be changed** later, and only Jira admins can delete a group. Choose carefully.
>
> If the group shows **Being set up at Atlassian**, wait a minute or two. That's normal.

### 1.2 Add people

1. On the **Groups** tab, click the group on the left.
2. In **Add people**, type at least 2 letters of a name or email and pick the person. Pick several to add them at once.
3. *(Optional)* Set **Access** to an end date (e.g. 30 days or a specific date). The person is removed automatically on that day.
4. Click **Add**.

**Adding many people?** Click **Paste a list**, paste emails or names (one per line or comma-separated), click **Check**, resolve any *Several matches* or *Not found* rows, then click **Add N people**.

### 1.3 Check where a group is used

Open a group and look at **Used in**. The app checks 9 places: permission schemes, workflows, project roles, security levels, notification schemes, shared filters, shared dashboards, Confluence spaces and restricted Confluence pages.

Use **Refresh** to re-check. A check marked *Could not be checked* or *No permission to check* is **not** the same as "not used".

### 1.4 Remove people

**One person:** click the remove icon next to the member → read what they lose → **Remove**.

**Several people (access review):**
1. Click **Review access**.
2. Tick the people who no longer need access.
3. Click **Review removal…**.
4. Check **What they lose**, add a **Note for the audit log** (e.g. "Q4 access review").
5. Tick **I checked that these people no longer need this access.**
6. Click **Remove N people**.

Changed your mind? Click **Undo** in the notification. People get back their previous end date too.

### 1.5 Change or remove an end date

Click the 📅 calendar icon next to a member → pick a new date or **No end date** → **Save**.

### 1.6 Manage several groups at once — the People tab

The **People** tab shows **Who is in which group**: one row per person, one column per group.

1. Click cells to plan changes: an empty cell = *will be added*, a filled cell = *will be removed*.
   - To offboard someone, use **Plan to remove … from all groups** in their row.
   - To add someone not yet in the table, use **Add a person to the table…**.
   - **Several people at once:** tick their rows. A bar appears at the bottom with **Add to group**, **Remove from group**,
     **Same groups as…** (e.g. a new colleague gets the groups of an existing team member; nothing is taken away) and
     **Remove from all groups**.
   - **Many groups?** The **Groups N/M** button chooses which groups are columns (with search). With more than 10 groups,
     the first 10 are shown; your choice is remembered in this browser. Bulk actions reach every group, shown or not.
   - Planned a step by mistake? **Undo step** (or **Ctrl+Z**) takes back the last planning step. **Discard** can be undone
     from its notification.
2. Nothing changes yet. When ready, click **Review & apply**.
3. Set an end date for additions (optional), add a note, tick the confirmation for removals.
4. Click **Apply N changes**.

Failed changes stay planned so you can retry. **Undo batch** reverts the whole batch in one click.

> Filters: **Deactivated**, **Ending in 14 days**, **Changed**.

### 1.7 Answer access requests

When project members ask to join a group, the **Requests** tab shows a badge.

1. Open **Requests**.
2. For each request, read the reason and requested duration.
3. Click **Approve** (person is added with the requested end date) or **Deny** (add a reason for the person).

Every decision can be undone from **Decided in the last 90 days**.

### 1.8 Complete a periodic access review

If your Jira admin turned on periodic reviews, groups that are due show a **Review due** badge.

1. Open the group → click **Review now**.
2. Go through the member list and remove anyone who no longer needs access (see 1.4). Tick **Also record this as the group's periodic access review** to count it.
3. Otherwise, confirm that everyone left still needs access → **Record review**.

### 1.9 Edit a group's description

Open the group → **Edit description** (or **Add a description**) → type → **Ctrl + Enter** to save, **Esc** to cancel.

### 1.10 See the history

The **Audit log** tab lists every change in your project. Filter by **Period**, **Group**, **Action** or **Person**, and click **Export CSV** to download it.

You can also **Export members as CSV** (download icon) from any group.

---

## Part 2 — Project members

**Open the app:** your project → the tab **My groups** (next to Summary, Board, List …). Project admins can check what
members see with **Member view** in the app's header.

### 2.1 See your groups

You'll see every group of this project you belong to, and when your access ends (if it does).

### 2.2 Request access to a group

1. Under **Request access**, find the group you need → click **Request**.
2. Fill in **Why do you need access?** (required).
3. Choose **For how long?** — 7, 30 or 90 days, or no end date.
4. Click **Send request**.

A project admin decides. You'll see the result under **Your requests**. Changed your mind? Click **Withdraw**.

> Don't see **My groups** or **Request**? Your Jira admin has switched these off. Ask your project admin directly.

---

## Part 3 — Jira admins

**Open the app:** **Jira settings** (⚙️) → **Apps** → **Group & User Management**.

Two tabs: **Configuration** and **Audit log (all projects)**.

### 3.1 First-time setup checklist

1. **Connect the Organization API.** Check **Atlassian organization connection**. If it says *Not set up*, the app cannot create groups or change members yet — follow the [setup steps in the README](README.md#connect-the-organization-api). Then click **Test connection**.
2. **Choose projects.** Under **Enabled projects**, pick **All projects** or **Selected projects only**.
3. **Review the block list.** Core admin and product-access groups are **Always blocked**. Add your own under **Additionally blocked** (wildcards like `jira-admins-*` are allowed).
4. **Mark IdP groups.** Under **Synchronised groups**, add groups your identity provider manages so they show as read-only.
5. **Set audit retention.** **Never delete**, or **Delete after** N months.
6. Click **Save**.

### 3.2 Roles & features

| Setting | What it does |
| --- | --- |
| Show the "My groups" page to project members | Members can see their own groups (read-only) |
| Allow time-limited memberships | Enables end dates and automatic removal |
| Auditor groups | Members can read and export the full audit log |

### 3.3 Governance & automation

| Setting | What it does |
| --- | --- |
| Project members can request access | Turns on access requests in **My groups** |
| Periodic access review | Every 3, 6 or 12 months, project admins confirm who still needs each group |
| Remove deactivated accounts automatically | Daily clean-up. Click **Who would be removed?** for a dry run first, then **Switch on** |

Remember to click **Save**.

### 3.4 Compliance overview

At a glance, across all projects: access reviews due, memberships ending within 14 days, open requests, and the Confluence page index status. Click a card for details.

> Want Confluence usage checks? Install the app in Confluence on the same site.

### 3.5 Move data to another installation (export & import)

Use this to move everything the app has stored to another installation on the same site, for example from a test installation to production. You get all of it: settings, group assignments, descriptions, end dates, requests, reviews and the full audit log. Only Jira admins see this section.

**Export (in the old installation):**
1. On the **Configuration** tab, scroll to **Export & import data** → **Export all data**.
2. Enter a **Passphrase** of at least 12 characters, and type it again under **Repeat passphrase**.
3. Click **Encrypt & export** and save the file.

**Import (in the new installation):**
1. In **Export & import data**, click **Import from file…** and pick the file.
2. Enter the passphrase → **Decrypt**.
3. Check the summary (number of records and audit entries, who exported it and when).
4. Tick **I want to import this data into this installation.** → **Import**.

> 🔒 The file is encrypted in your browser with AES-256-GCM, and the passphrase never leaves your browser. Keep the passphrase in your password manager, separate from the file. Without it, nobody can open the file, not even SUPERPORT.
>
> If an import stops partway, just run it again. Entries that are already there are skipped, so nothing is duplicated.

---

## Part 4 — Auditors

**Open the app:** Jira sidebar → **Apps** (hover to open the list) → **Group audit log**. Jira admins also find an
**Open the audit log page** button under *Auditor groups* in the app's configuration.

You get a read-only audit log across **all projects**. Filter by **Period**, **Project**, **Group**, **Action** or **Person**, then click **Export CSV**.

> See *No access*? Ask your Jira admin to add you to one of the **Auditor groups**.

---

## Part 5 — Using the Rovo agent

Open **Rovo** in Jira and choose the **Group & User Management** agent. Ask in plain English or German, for example:

- *"Which groups exist in project ABC and who is in them?"*
- *"Where is atlassian-ABC-reviewers used?"*
- *"Add anna@example.com to atlassian-ABC-reviewers for 30 days."*
- *"Show pending access requests and expiring memberships."*

The agent **always tells you what it will do and waits for your OK** before changing anything. It never guesses between people with similar names. Its changes are tagged *via Rovo* in the audit log and can be undone in the app.

---

## FAQ

**I see "Only project admins can manage the groups of this project."**
You need the *Administer Projects* permission in this project.

**I see "The app is not enabled for this project."**
Your Jira admin has limited the app to selected projects. Ask them to add yours.

**I can't change a group — it says "IdP sync".**
It's synchronised by your identity provider (e.g. Entra ID, Okta). Membership changes must be made there.

**I can't find a group I know exists.**
The app only shows groups that belong to your project (`atlassian-<PROJECTKEY>-…`). Groups blocked by the Jira admin are hidden.

**I just created a group but it shows "Being set up at Atlassian".**
Atlassian needs a minute or two to make new groups visible in Jira. Wait and refresh.

**How do I rename or delete a group?**
You can't in the app. Only Jira admins can delete groups, in Atlassian Administration.

**I made a mistake.**
Click **Undo** in the notification. Already gone? Re-add or remove the person — the audit log shows exactly what changed.

**Where do I assign a group to a project role?**
As usual in Jira: **Project settings** → **People** (Users & Roles).
