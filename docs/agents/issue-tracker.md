# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters. Keep `--limit` high (default `gh` returns only 30) so the full backlog is visible.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: yes.** External PRs are treated as feature requests; `/triage` reads this flag and pulls them into the same queue as issues, running them through the same labels and states using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR` — collaborators' in-flight PRs are left alone).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

GitHub (via recent `gh`) supports **native issue blocking** and **sub-issue
parents**, so the wayfinder map/children/blocking/frontier use the native
relationships — no body-convention fallback.

- **Map**: one issue labelled `wayfinder:map`. Its body carries Destination /
  Notes / Decisions-so-far / Not-yet-specified / Out-of-scope.
- **Child ticket**: an issue labelled `wayfinder:<type>` (`research` /
  `prototype` / `grilling` / `task`) **and** tied to the map via
  `--parent <map-num>`. Child tickets are *not* listed in the map body while
  open — they are found by query. The issue number is the ticket's identity;
  refer to it by its title in human-readable prose, with the `#NN` link riding
  inside the name.
- **Blocking**: the native `gh issue create --blocked-by <num,...>` /
  `gh issue edit <n> --add-blocked-by <num>` relationship. A ticket is
  unblocked when every issue blocking it is **closed**. GitHub renders these
  edges visually in the issue UI, so the human sees the takeable frontier
  without opening the map.
- **Frontier**: list open wayfinder tickets with
  `gh issue list --state open --label "wayfinder:research,wayfinder:prototype,wayfinder:grilling,wayfinder:task" --limit 200 --json number,title,assignees,blockedBy`,
  then keep issues whose `blockedBy` array is fully closed (each blocker's
  `gh issue view <n> --json state -q .state` returns `CLOSED`) and whose
  `assignees` is empty. First by number wins.
- **Claim**: assign the issue to the driving account before any work
  (`gh issue edit <n> --add-assignee @me`). The assignee *is* the claim; an
  open, unassigned ticket is unclaimed.
- **Resolve**: post the answer as a resolution **comment** (`gh issue comment`),
  **close** the issue with a one-line summary (`gh issue close <n> --comment "..."`),
  and **append a context pointer** to the map's Decisions-so-far via
  `gh issue edit <map-num> --body <updated>`.
- **Scope ruling**: if a ticket sits beyond the destination, **close it** and
  leave one line in the map's `## Out of scope` section linking the closed issue.
- **Fog graduation**: when a Not-yet-specified patch becomes specifiable, create
  the new child issue (`--parent <map-num> --label wayfinder:<type>`) and clear
  that patch from the map body.
