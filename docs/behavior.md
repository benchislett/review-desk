# Queue behavior and collection scope

## The review pool

The vLLM collector takes the union of open-PR searches using `author`, `assignee`,
`review-requested`, `mentions`, and `reviewed-by` for the configured GitHub user.
Previously verified involvement is retained, so removing a reviewer request does
not silently drop a PR. Membership does not itself create a new action signal.

FlashInfer uses only the union of `author` and `commenter` searches. It does not
enumerate the repository, retain additional historical candidates, or fall back
to reviewer or mention searches. Its default view is **My PRs**.

GitHub search can miss inline-only or review-summary mentions and can lag new
activity. The optional `scripts/collect.py --exhaustive` audits all open vLLM PRs
when complete discovery is needed; it is never invoked by normal refreshes.
All fetched discussion and metadata connections are paginated. Searches exceeding
GitHub's 1,000-result cap fail explicitly rather than silently truncating.

## Priority

Each PR has one discussion queue, in decreasing priority:

1. **Unanswered mentions:** someone explicitly mentioned you in a comment,
   submitted review, or inline reply, with no later response from you anywhere
   on the PR.
2. **My PRs · feedback:** new human feedback or an outstanding request for changes
   on a PR you authored.
3. **Review follow-ups:** a thread reply, explicit re-request, author response,
   or newer commit after your earlier review.
4. **Review requested:** a routine current reviewer request.
5. **Assigned to me:** an assignment without a stronger signal.
6. **Waiting on others:** already responded, or waiting for review on your own PR.
7. **Following:** historical involvement or a description mention without a
   current request.

An ordinary comment or a submitted review from you clears earlier mentions.
Empty approvals count as responses; unpublished pending reviews, commits, and
emoji reactions do not. Resolved threads do not erase unanswered mentions.
Description mentions establish membership but do not create high priority.

The follow-up view hides commit-only updates by default. A commit authored by
your linked GitHub account never creates the inferred newer-commit signal;
commit authorship is distinct from the PR author, pusher, or committer.

GitHub Bot actors, `[bot]` handles, and the service accounts in `bots.json` are
excluded from activity checks. Comments beginning with `/ci` after leading
whitespace, case-insensitively, are also excluded. These comments cannot answer
a mention or expire a dismissal. Formal review state can still affect readiness
and velocity independently of discussion activity.

Routine review requests on drafts are deferred, while direct mentions remain
visible. Natural-language intent and team mentions are not interpreted. The
sidebar shows the specific evidence behind each classification.

## Dismissals and independent views

**Dismiss current activity** moves a PR to Following. It stays in All PRs and any
applicable My PRs, Approved, or Ready view. Undo restores automatic classification.
Dismissals persist across sessions and restarts and make no GitHub requests.
New human activity or changed priority evidence expires a dismissal; unchanged
refreshes, bot comments, and CI command comments preserve it. A stale browser
cannot dismiss activity it has not loaded.

**Approved** shows open PRs with your current formal approval. Later Comment or
pending reviews do not revoke it; changes requested or a dismissal does.

**Ready** requires an open, non-draft PR you authored or formally reviewed, a
current approval from a non-bot reviewer with write access, and passing checks.
All reported head and test-merge check rollups must succeed, with at least one
result. GitHub must report mergeable and clean, with review requirements met.
Conflicts, unknown mergeability, out-of-date branches, and merge queues exclude
a PR. Readiness reflects the last fetch; GitHub performs the final merge checks.
Approval permission and check metadata are included in existing detail queries.

## Refresh and API usage

All browser sessions use one backend queue. Global refreshes collect the vLLM
pool, vLLM review history, and FlashInfer participation. Data is staged before
publishing, so a collection failure preserves the served snapshots. Targeted
refreshes update one known PR and its contribution to review history.

Opening a preview schedules a refresh after 350 ms. Recent data is reused for
60 seconds; manual refresh explicitly requests a fresh read. Clicking the
preview's Open PR link or the row's GitHub shortcut arms one refresh on return.
Tab or desktop-workspace switching alone does not. Duplicate jobs are coalesced,
including between browser sessions.

The API indicator uses quota information from actual API replies. Local status
polling occurs every two seconds and makes no GitHub calls. A dedicated quota read
runs at startup unless frozen, or on unfreezing when the cached observation has
expired. Transient requests retry with 5, 10, and 15 second delays.

Freezing is shared and persistent. Active work pauses before its next request;
new refresh triggers are refused and queued jobs wait. Already-admitted requests
may finish. Cached browsing and dismissals continue while frozen.

## Review velocity

Velocity counts actual submitted GitHub `PullRequestReview` records, including
`COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, and submitted reviews subsequently
marked `DISMISSED`. Ordinary conversation comments and pending reviews do not
count. Review IDs are deduplicated and bot reviews are excluded.

Each daily, Monday-based weekly, or calendar-month bucket counts a PR once,
regardless of repeated submissions. A separate measure counts submissions.
Distinct-PR totals are not additive across buckets. Dates use the configured
timezone; zero-activity buckets and partial periods are shown.

History includes open, closed, and merged vLLM PRs. FlashInfer does not collect
review-velocity history. Clicking a chart bar shows the underlying reviews.

## Limits

Comment edits use the original creation time because the API does not reveal
when a mention was introduced. Force pushes and rebases can make commit-time
inference imperfect. Deleted content and activity after a fetch cannot be
reconstructed. Collection happens over an interval, not as an atomic GitHub
snapshot.

See GitHub's [search documentation](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests),
[pull request review API](https://docs.github.com/en/rest/pulls/reviews), and
[GraphQL reference](https://docs.github.com/en/graphql/reference) for the upstream
objects used by the collectors.
