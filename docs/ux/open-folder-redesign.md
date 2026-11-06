# Open-folder redesign: discovery-first opening from the location bar

Design for the desktop WebUI. The user picks a folder from the bar's
path chip (`location-bar-path-chip`); instead of silently landing a
workspace, the shell first discovers what the folder is and shows the
right list: existing worktrees, existing branches, or neither. Every
branch and worktree the lists offer can be opened or created, with the
base chosen from local refs first and extendable remote refs.

Analysis session 2026-11-04. Implementation branch `open_folder_redesign`.

Design read: a desktop repository chooser for developers, retaining the
existing IDE chip and popover language. Dials: ENERGY 1, RHYTHM 1,
MOTION 1. Fixed anchoring avoids clipping by the scrolling location bar;
existing theme tokens and native controls keep the shell consistent.

## Problem

Today `openFolderAsWorkspace(dir)` (open_folder_flow.js) runs a fixed
3-step ladder: focus an open workspace on the folder, else
`/api/worktrees/open` when the folder is a checkout, else create a
plain workspace. The user picks a folder blind. The bar's branch chip
already gives a branch list popover and the worktree chip a worktree
list popover, but those only exist AFTER a workspace is open on a git
folder, and creation of a new branch bases itself on the current branch
only, with no base picker.

## Signed-off decisions

1. **The path chip stays the folder entry point.** Clicking
   `location-bar-path-chip` still opens `HerdrDirectoryPicker` (tree,
   search, git status colors). What changes is the AFTERMATH of the
   pick: instead of running the fixed ladder immediately, the pick
   opens the new folder-discovery surface (below).
2. **Discovery decides the list, automatically.** After a folder pick
   the shell probes the folder:
   - git repo with 2+ worktrees in the repo -> **worktree list**
   - git repo with a single checkout -> **branch list**
   - no git repo -> **no list**, plain workspace opens (existing step 3
     behavior, unchanged)
   The user never chooses which list to see; discovery picks it. This
   is the "depending on what have been discovered" requirement.
3. **One popover family.** The new surface reuses the existing popover
   components and classes (`git-ui-branch-list`, `git-ui-worktree-list`)
   already used by the branch/worktree chips, anchored to the path
   chip. New state lives in the location bar module's `bar` state, same
   pattern as `bar.branchList` and `bar.worktreeList`.
4. **Rows open what they name.** A worktree row runs the existing
   folder-change flow (`openFolderAsWorkspace(row.path)`), which
   focuses an open workspace or opens a new one. A branch row: if an
   open workspace already sits on that folder, switch its branch
   (existing `/api/git-ui/switch`), else open the folder first then
   switch. The current-branch row in a not-yet-open folder just opens
   the workspace (no switch needed).
5. **Create flows carry a base picker fed with local + remote refs.**
   - Create branch: name + base. Base defaults to the checked-out
     branch of the picked folder; the base field is a datalist fed by
     `/api/git-branches?cwd=<folder>&remote=true` (local first, remote
     section extendable by the existing "Fetch remote branches" afford
     when the endpoint is asked with `&fetch=true`).
   - Create worktree: branch name + base, inside this same discovery
     dialog. No action modal opens. Checkout path and label follow the
     existing generated defaults instead of adding two more inputs.
6. **No git repo = plain workspace, immediately.** No popover at all;
   the existing 3-step ladder runs to completion (focus, else open
   checkout, else create workspace + recents record). This keeps the
   common "just open my notes folder" path exactly as fast as today.
   Entries that merely seed a folder the user never chose (Open
   workspace button, palette action, newWorkspace shortcut) no longer
   seed discovery at all: they open the folder picker first, because
   silently opening the seeded folder would pick the workspace for
   the user (2026-11-05 regression fix). The pick then follows this
   rule.
7. **The bar's in-workspace chips keep working.** Branch chip and
   worktree chip popovers are unchanged. The new discovery popover is a
   third surface with its own state key (`bar.discoveryList`), opened
   by the path chip pick, closed by the same document-click and Esc
   dismissal pattern.

## Flow

```
path chip click -> HerdrDirectoryPicker
pick folder F
  probe 1: GET /api/worktrees?cwd=F (fresh fetch, never trusted cache alone)
    rows >= 2 -> WORKTREE LIST popover
    rows == 1 and row.path == F (single checkout) -> probe 2
    rows == 1 but row.path != F, or rows == 0 -> probe 2
  probe 2 (only when probe 1 does not decide): GET /api/git-ui/branches?cwd=F
    ok -> BRANCH LIST popover (single-checkout shape)
    error whose text says "not a git repository" -> plain ladder (decision 6)
    any other error (transport, auth, broken repo) -> ERROR popover with footer,
      NOT a silent plain open: a failed probe is not evidence of a plain folder
```

### Decisions folded in from review (v2)

- **Explicit single-checkout route.** Probe 1 returning exactly one row
  whose path matches F routes to probe 2, not to a dead end. Probe 1
  returning zero rows also routes to probe 2 (the backend returns rows
  for the containing repo only when one exists).
- **Footer in every non-empty state.** The "Open folder as workspace"
  footer renders during LOADING and ERROR too, not only with rows: a
  stalled probe must never trap the user. Acting on the footer cancels
  the probe: its requestId is bumped so late completions land on a dead
  opening and never mutate a closed popover. The footer reuses the shared
  folder ladder. If its worktree probe reports the specific not-git
  error, recovery calls the shared direct workspace-create step
  (POST /api/workspaces + recents record), without repeating that probe.
  Transport/auth errors still surface to the user as the blocking
  alert, never a silent wrong open.
- **Branch row contract (three destinations, one precedence).** A branch
  row carries `worktree_path` from /api/git-ui/branches. Precedence:
  1. row's worktree_path is a DIFFERENT folder -> the row reroutes to
     that worktree folder through the plain ladder (same behavior the
     chip popover already has), no switch posted.
  2. row is the picked folder's current branch -> plain ladder on F,
     no switch.
  3. otherwise -> open F through the plain ladder, then POST
     /api/git-ui/switch {cwd: F, branch}. No confirmation gates the
     open (2026-11-06: every open flow runs confirm-free; destructive
     actions keep theirs). The switch captures F at row
     render time, never reads currentCwd() after navigation. If the open
     succeeds but the switch fails, the blocking overlay drops and an
     alert states the folder opened on its original branch with the git
     error. Partial success is honest, never silent.
- **New branch in a possibly-unopened folder.** Create branch from the
  discovery popover: open F through the plain ladder first (no confirm),
  then POST /api/git-ui/switch {cwd: F, branch: name, create: true,
  base}. On switch failure the same partial-success alert fires. On
  success the drawer is notified (notifyBranchChanged(F)) and the
  popover closes. The base defaults to the picked folder's current
  branch (probe 2's current row); empty current branch (unborn HEAD)
  defaults to HEAD.
- **Base picker (branch create).** Two inputs: name, base. Base is a
  text input with a datalist fed lazily on first create-mode entry by
  GET /api/git-branches?cwd=F&remote=true (local refs first; the
  datalist carries no fetch=true: remote extension is the explicit
  "Fetch remote branches..." option pattern the worktree modal uses,
  re-fetching with &fetch=true only on user action). Fetch failure
  degrades to the empty datalist and the base stays a free-text input
  (git resolves any ref, so an unfed picker never blocks creation).
  Drafts (name, base) survive re-renders through bar.discoveryList
  state, same pattern as the chip popover's newBranch draft. Name and
  base have separate visible labels. Fetching remote refs is an explicit
  action, not a side effect of picking a folder or typing a filter.
- **Worktree create, revised by user on 2026-11-04 (v3).** Clicking
  Create worktree keeps the discovery dialog and its list open. The
  create area shows two labeled inputs: Worktree branch name and Base
  ref, plus Create worktree and Cancel worktree buttons. In the branch
  chooser this reuses its existing name/base area, changing the submit
  action rather than duplicating fields. In the worktree chooser the
  area expands below its rows. Focus moves to the name input. Cancel
  collapses worktree creation, keeps the list and drafts, and returns
  focus to the Create worktree row. Esc still closes the whole dialog.
  No existing action modal, directory picker, label input or path input
  is opened by this action. Existing chip creation flows are unchanged.
- **Inline worktree submit.** A nonblank branch name enables Create
  worktree. The base defaults to the picked checkout's current branch,
  else HEAD. It shares lazy local/cached refs, explicit Fetch remotes,
  free-text fallback, draft retention and focus behavior with branch
  creation. Local refs precede remote refs in either discovery shape.
  Submit uses existing POST /api/worktrees, with cwd captured as F,
  branch, base, generated checkout path, default label and the user's
  pull-base choice (unchecked by default). Reuse pure
  naming/default-directory helpers, not modal actions.
  During the request, show Creating worktree, disable duplicate submits
  and keep the draft visible. Failure shows an inline alert and retry,
  keeping name/base. Success closes discovery and selects the returned
  workspace/tab/pane. A stale opening never navigates after completion.
  There is no pre-submit navigation to F and no extra confirmation modal.
- **Authoritative refs and source.** Lazy base loading obtains the
  local-only list from GET /api/git-branches?cwd=F and the combined list
  with remote=true, emitting local entries first and then combined
  entries absent from that local set. Do not guess remote prefixes.
  Fetch remotes uses fetch=true only on the combined request and refreshes
  local membership without a second fetch. Retain probe 1's source metadata
  for worktreeRootForSource(source), source.repo_name and branchPathSlug
  when generating the checkout path. A failed first probe is retried on
  inline worktree entry, with inline error/retry if source is still
  unavailable. Do not submit a malformed path. The request's source is
  separately fixed to {cwd:F, workspace_id:null} and label:null, never
  the origin workspace or modal state; pull_base carries the checkbox.
- **Pending worktree creation.** Freeze the submitted name/base and all
  competing in-dialog actions until the request settles: list rows,
  mode changes, ref loads, Cancel worktree and the plain-open footer.
  Announce Creating worktree with role=status. Esc/outside dismissal
  remains available and invalidates the opening, but does not cancel
  the server-side creation. A short pending hint states that distinction.
  On failure announce role=alert, restore controls and retain drafts for
  retry. A late result must not repaint or navigate another opening.
- **Short desktop and zoom.** At 200% zoom on a short desktop viewport,
  the discovery dialog fits the available height below its live anchor.
  Name, base, ref loading/fetching, submit, Cancel, error/retry and footer
  remain reachable by keyboard and vertical scrolling, without horizontal
  clipping. Focusing the expanded form or retry control scrolls it into
  view. Verify this in the running preview, not only a DOM mock.
- **Discovery popover exclusivity and Esc.** Opening discovery closes
  branch and worktree chip popovers; opening either chip popover closes
  discovery. The document-capture Esc handler extends to discovery
  (close all three, same handler). The drawer shortcut guard
  (locationBarPopoverOpen in git_ui/shortcuts.js) gains the discovery
  class so the drawer yields while discovery is open.
- **Anchor and focus.** Anchor recomputes at open time from the live
  path chip (anchorFromEvent(null, ".location-bar-path-chip")), never
  from the retained picker event. On close, focus returns to the path
  chip node currently in the DOM (re-queried, since sync() rewrites bar
  DOM). Branch shape autofocuses the filter input; worktree shape
  (no filter) autofocuses the first row button. Filter typing keeps
  focus and caret through popover-only re-render (the chip popover's
  replaceWith pattern, reused).
- **Signature.** renderSignature gains a discovery token (open,
  loading, error, mode, row count, drafts) so popover-only changes
  repaint the bar alone.
- **Escaped-surface contract.** Every inline handler argument goes
  through encodeArg; every text node through escapeHtml; every
  attribute through escapeAttr/escapeAttrQuoted. Row labels carry
  paths and branch names, which are hostile-string surfaces exactly
  like the chip popovers.

```
row click (worktree) -> openFolderAsWorkspace(row.path), popover closes
row click (branch)   -> branch row contract above
"Create worktree"    -> inline name + base area in this discovery dialog
inline submit       -> POST /api/worktrees, then select created workspace
"New branch"         -> name + base picker, open-then-create contract above
footer "Open folder as workspace" -> plain ladder on F, always present
```

### Same-folder re-pick

The path chip picker currently no-ops when the picked path equals the
selected workspace folder. Discovery redefines that: picking the same
folder opens the discovery popover for it (the user may want to see
branches or create one). The no-op guard moves from the picker change
handler into the popover's row contract (destination 2 above), so
same-folder picks become useful rather than dead.

## Keyboard and a11y contract

- Popover is `role="dialog"` with `aria-label` naming the picked folder,
  same as the chip popovers.
- Branch shape: filter input autofocuses on open; Tab order: rows, create
  row, footer. Worktree shape (no filter): first row button autofocuses;
  Space/Enter activate rows as native buttons. Esc closes from anywhere
  (document capture handler, extended to the discovery class).
- Rows are buttons with accessible names (branch name + author + relative
  date title; worktree label + branch + path).
- The popover must survive the focus contract of the chip popovers:
  closing hands focus back to the live path chip node in the DOM.
- Repo context row at the top of the popover names the repo and the
  picked folder ("Picked folder" wording, not "Current", because the
  picked folder may differ from the active workspace and may sit below
  the checkout root).

## Backend surface (all existing, zero new endpoints)

| Need | Endpoint | Notes |
|---|---|---|
| Worktree rows of a folder's repo | GET `/api/worktrees?cwd=` | Enriched rows; a row with `path == picked` marks "current" |
| Branch rows (local+remote, tip details, worktree_path stamps) | GET `/api/git-ui/branches?cwd=` | Branch rows carry `worktree_path` so the branch list can reroute to a worktree exactly like the chip popover does |
| Plain branch list for datalists | GET `/api/git-branches?cwd=&remote=true[&fetch=true]` | Base picker; extendable remote section |
| Switch/create branch | POST `/api/git-ui/switch` `{cwd, branch[, create, base]}` | unchanged |
| Create worktree | POST `/api/worktrees` `{cwd, branch, base, path, label, pull_base}` | unchanged, inline form uses generated path/default label |
| Open checkout | POST `/api/worktrees/open` | unchanged, via the shared folder ladder |
| Create workspace | POST `/api/workspaces` | unchanged, via the shared folder ladder |

Non-goal: backend protocol changes. The mobile worktrees screen and the
TUI prompt chain stay separate surfaces, but both speak the same
contract: pull_base on the worktree create POST and the same
diverged-base continuation (mobile confirm sheet; TUI surfaces the raw
git error).

## Files touched (desktop only)

- `src/assets/desktop/app_js/location_bar.js`: discovery popover state
  + renderer + handlers; path-chip pick routes through it.
- `src/assets/desktop/app_js/open_folder_flow.js`: export the ladder
  steps so the popover can reuse focus/open/replace semantics without
  re-implementing them.
- `src/assets/desktop/app_css/location_bar.css`: any popover anchoring
  tweaks for the discovery surface.
- Tests: `src/assets/location_bar.test.mjs` (new suite), and the
  existing `open_folder_flow.test.mjs` extended for the probe steps.
- Docs: this file plus a release-notes entry.

## Risks

- The `/api/worktrees?cwd=` probe lists worktrees of the repo CONTAINING
  the folder, so picking `~/proj` inside a repo whose main checkout is
  `~/proj-main` still shows `~/proj-main`. That is desired (discovery by
  repo), but the popover labels must carry the repo name so the rows are
  not confusing.
- Two fetches per folder pick (worktrees then branches when the first is
  inconclusive). Acceptable: one-shot per pick, no polling.
- Popover anchored to the path chip while the picker modal just closed:
  anchor must be recomputed at open time (existing anchorFromEvent
  handles it).
