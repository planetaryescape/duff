# Inline discussion: combined code review

Date: 2026-10-26. Review target: original main `12fa0e0`, PR #22 through `eca34db`, and the integrated inline-discussion working tree, including new files. Reviews were read-only Sol 6.1 passes using the owner's `code-review` skill and topic standards. Implementation agents applied fixes separately.

## Findings and closure

| Area | Proven finding | Correction and evidence | Status |
| --- | --- | --- | --- |
| Existing dashboard work | Cached Open → Closed → Open navigation restored an invalid Azure continuation | Continuations now include filter state. Real adapter/directory/cache regression failed before the fix; PR #22 commit `eca34db` passes required checks and 272 application tests. | Closed |
| Discussion providers | Pending GitHub review comments lost per-comment publication state | Required publication state is preserved and labelled; pending roots stay read-only while published-root actions remain valid with pending children. Independent focused review and 15 provider tests confirmed the correction. | Closed |
| Durable mutation recovery | Late uncertainty reclaimed an explicitly released reservation | Transactional update preserves the current reservation flag. Two real-SQLite, two-instance regressions cover released targets with and without a replacement reservation. Both failed before the fix; all ten store tests pass afterward. Independent reviewer closed the finding. | Closed |

The core review covered identities, exact anchors, provider protocol projections, pagination bounds, mutation uncertainty, attempt transitions, global recovery, stale reads and read-only creation preflight. The extension review covered qualified URI construction/readers, command targets, pending comment display, save/send handling, recovery paging, runtime disposal, permissions, inert provider content, manifest and upstream dashboard integration. No other actionable findings survived those passes.

## Evidence limits

- Supplied-provider native checks and installed-artifact smoke are distinct. Local fixtures do not qualify live GitHub/Azure writes or Azure server tracking/offset semantics.
- SQLite tests cover multiple store instances and restart behavior; they do not prove power-loss durability on every filesystem.
- Native concurrent editing during an in-flight Send and true cross-process fault injection were not exhaustively qualified. Version/race invariants have deterministic seam tests.
- Test-runner diagnosis reproduced the same real-Git timeouts on unchanged upstream. Parent inspected the sole runner change, `--maxWorkers=1`: no tests, deadlines, assertions or hooks were bypassed. Three single-worker full runs passed, followed by green full checks/build. See the delivery log for timings.

See the [spec](../.specs/inline-pr-comments/PROGRESS.md) and [delivery log](implementation-log.md) for implementation limits and final verification status. No PR is merged by this review.
