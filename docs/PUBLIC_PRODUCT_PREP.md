# Preparing the public product (phase 2 and later)

Status 2026-10-24: **nothing in this document is built or exposed.** Phase 1 shipped only the public information
site and the early-access list ([`PUBLIC_SITE.md`](PUBLIC_SITE.md)). This is the groundwork and the decisions to make
before anyone other than the owner can generate anything.

## Where the code stands

AZ Studio is single-owner by design, and that is what protects it today:

- `assertOwner` (functions/src/lib/owner.ts) gates every callable action; the owner UID and email come from Secret
  Manager. Firestore and Storage rules embed the owner UID at deploy time (`{{OWNER_UID}}`).
- Documents already carry `ownerUid` (53 backend files use it), media lives under `users/{uid}/…`, and spending,
  concurrency slots (`runtime/{uid}_slots`) and usage aggregates are keyed by UID. That is a good base for many users,
  but the checks that *enforce* separation all assume one UID.
- Auth is the **shared `az-learner` project's** Firebase Auth, also used by six other apps. Non-owners can sign in
  there today and are refused by the API and rules.
- Spending limits, confirmation thresholds, project budgets, quality-repair ceilings and provider-pause handling exist
  per owner and are enforced server-side on submission.

Route boundary reserved now: the studio lives under its existing prefixes and `/studio`; **`/app` is reserved for the
public product** (it returns the 404 page today). Nothing public may be added under the studio prefixes.

## 1. Public accounts, separate from owner access

- Keep the owner path exactly as it is (Secret Manager identity, owner-only rules) and add a **separate role** for
  public users rather than loosening `assertOwner`. Each action declares who may call it (`owner`, `member`), and a
  member action can never reach owner data or settings.
- Do not mix public users into the shared `az-learner` Auth pool. Options, in order of preference:
  1. a **separate Firebase project** for the public product (own Auth, Firestore, bucket, quotas and billing alerts;
     the owner studio stays where it is);
  2. Identity Platform **multi-tenancy** with a dedicated tenant (needs the Identity Platform upgrade on a shared project).
- Membership is invitation-only at first: an `invites/{code}` record created from the early-access list by the
  owner; sign-up without a valid invite is refused server-side (not just hidden).
- Require verified email; keep App Check on every callable; add MFA as an option.

## 2. Workspace and project isolation

- Introduce `workspaces/{id}` with `members.{uid}: role`; every project, asset, job, render and usage record gets a
  `workspaceId`. Rules check membership with `get()` on the workspace; the API checks it in one helper used by every
  action (a unit test enumerates actions and fails if any skips it).
- Storage paths become `workspaces/{workspaceId}/…`; signed URLs are only issued after the same membership check.
- Owner data never moves into a workspace that others can join. Emulator tests must prove cross-workspace reads,
  writes, listing queries, signed-URL requests and job submissions are all refused.

## 3. Which tools to offer first

Recommended order, by cost predictability and risk (to be confirmed):

1. **Audio editions / narration with prebuilt voices** — cheap per minute, easy to cap by characters. No voice
   replication for members (it requires the speaker's own consent recordings and raises impersonation risk).
2. **Narrated films from stills (Film Studio Lite)** — images + narration + score; bounded by scene count.
3. **Images** — per-image price is known; needs content filtering and likeness rules.
4. Later: music videos from stills, songs/score, then generated video (highest cost and abuse risk).

Keep advanced owner tools (quality-controlled film production, automatic repair, stems) owner-only until usage data
exists.

## 4. Usage limits and generation cost controls (server-side)

- Per member: daily and monthly allowances, max concurrent jobs, max job size (minutes of audio, scenes, images),
  and a per-job cost ceiling — enforced in the submission transaction like today's owner limits, never in the UI.
- Global: a daily spend circuit-breaker for all members together, per-model kill switches, provider-pause handling
  (already exists), and Cloud Billing budget alerts on the project.
- Every estimate is shown before confirmation (already the studio's pattern) and recorded with the job; actual cost is
  reconciled after completion.

## 5. A possible credit model (prices undecided)

- Credits as an internal unit mapped to estimated provider cost plus margin; one ledger collection per workspace with
  append-only entries (grant, reserve, settle, refund, expire). Reserve on submission, settle on completion, refund on
  failure that was not the member's fault.
- Free invitation allowance first; paid top-ups only after the decisions in §10. **No prices, plans or payment
  provider have been chosen.**

## 6. Jobs: queues, progress, cancellation, failures

The existing job system already provides durable jobs (`queued → … → completed | failed | cancelled`), Cloud Tasks
delivery with leases, idempotent workers, polling for long operations, maintenance recovery without resending paid
requests, and cancellation of queued work. For members add:

- per-workspace queue fairness (one member cannot fill the global concurrency), and priority for small jobs;
- progress events readable only by the workspace;
- clear failure classes for members (blocked by safety filters, provider busy, over allowance, internal) with
  automatic refunds where appropriate;
- a cap on retries per job and per day.

## 7. Files: ownership, private storage, sharing, retention, deletion

- Uploads and outputs belong to the workspace; storage stays private (public access prevention), served by short
  signed URLs after a membership check.
- Sharing = an explicit publish action creating a public copy (as the Narrator player does today), revocable.
- Retention: define defaults (e.g. delete inactive drafts after N days, keep exports until deleted) and a storage quota.
- Deletion: member-initiated deletion of a project or account removes documents, objects and derived files, with a
  short recovery window; record deletions for audit. Provider-side retention (e.g. stored interactions) must be listed
  in the privacy notice.

## 8. Reporting, support and abuse handling

- A report link on every shared item and in the app; reports land in an owner-only queue.
- Acceptable-use policy (likeness of real people, sexual content, harassment, impersonation, other brands' marks —
  the studio already fails ad takes that show another brand).
- Owner tools: suspend a member, revoke shares, freeze a workspace's jobs, export a member's data on request.
- Rate limits on sign-in, invites and job submission; App Check everywhere; alerting on unusual spend per member.

## 9. Feature flags and staged invitations

- `runtime/features` (server-read) with per-flag allowlists: which tools, for which workspaces, with which limits.
  The UI reads flags from `bootstrap`; the API enforces them.
- Waves: 5 → 20 → 100 invitees, chosen from the early-access list by interest, with a feedback form and a review of
  costs and reports between waves. The early-access list's `interest` field supports this selection.

## 10. Decisions needed before accepting payments or enabling generation

1. Separate Firebase project vs. Identity Platform tenant for public accounts.
2. First tool(s) and their per-member limits; monthly global spend ceiling for the beta.
3. Acceptable-use policy and moderation approach (automated filters, manual review, both).
4. Retention defaults and storage quotas; account deletion behaviour.
5. Pricing model (free allowance, credits, subscription), prices, refunds, taxes and the payment provider.
6. Legal entity, governing law, updated terms and privacy notice (data processors such as Google and any email or
   payment provider), and age requirements.
7. Support channel and response expectations.
8. Email provider for invitations and transactional mail, with unsubscribe handling.
