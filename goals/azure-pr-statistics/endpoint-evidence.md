# Sanitized Azure endpoint evidence

Observed 2026-10-25 using the configured `az devops` defaults and an accessible active PR discovered with `az repos pr list`. Existing `az account get-access-token` authentication was consumed only inside trusted processes. Tokens and file contents were not printed or written to files. Content remained in memory and does not enter the application's completed-result cache or telemetry.

## Protocol

- Authenticated `OPTIONS /_apis/git?api-version=7.1` advertised resource ID `c4c5a7e6-e9f3-4730-a92b-84baacff694b`, resource `fileDiffs`, route template `{project}/_apis/git/repositories/{repositoryId}/{resource}`, resource version 1, minimum 5.0, maximum 7.2, released version 7.1.
- Read-only `POST .../fileDiffs?api-version=7.1-preview.1` succeeded. Batches of 1, 2, 5 and 10 succeeded; 11 and 13 returned 400. A thirteen-file request without the preview suffix also returned 400, but that did not isolate version support from the batch limit, so it is not proof that preview is required. The implementation uses the verified preview version and ten per batch. The guessed `/diffs` route was 404 and is not used.
- The response envelope is `{count,value}`. Each returned file contains `path`, `originalPath`, `lineDiffBlocks`. Blocks contain `changeType`, original/modified line starts, and original/modified counts. Live discriminants are lowercase strings, not the numeric SDK enum. All four types were observed.
- For added files, omitted or empty `originalPath` succeeded. Supplying the current path as the original path instead produced HTTP 500 `ItemNotFoundException`, including in a mixed batch. The implementation now sends an empty original path for add, and an empty current path for delete. Delete behavior is covered synthetically, not live-qualified.

## Comparison and totals

The selected PR had one iteration and thirteen changed files. Iteration source and target commit IDs matched metadata source/target IDs. `$compareTo=0` supplied a terminal thirteen-file comparison. Requests used the iteration common commit as base and source commit as target, never target HEAD or a synthetic merge commit. Source/target remained unchanged across the initial smoke check and corrected complete query.

Corrected batches of ten and three returned thirteen unique matching file path pairs, with no missing or empty block sets. Raw block aggregation produced 159 additions and 176 deletions. An earlier ten-file subset produced 51 additions and 83 deletions; that was partial and was not a complete PR total.

An independent in-memory source-content check of the added file found 68 newline-terminated lines and a trailing newline. Its diff block reports 69 additions, which equals the number of newline-separated segments including the trailing empty segment. This is a real semantic difference from ordinary Git numstat line counting. No content was saved or shown.

## Qualification limits

The route, preview version, ten-file successful batch size, response shape, full requested path coverage, stable immutable comparison and raw block aggregation were observed live. This is not evidence of Git-equivalent EOF/newline semantics, binary-file completeness, large-file truncation guarantees, server maximum response sizes, deletion semantics, or fork support. These remain delivery qualifications, not fabricated guarantees. Fork line totals are explicitly unavailable; empty or missing file blocks are never interpreted as zero.

## EOF correctness review and correction

A further bounded read-only check selected one existing edited text file with a trailing unchanged block. Original and modified content were held in memory only, with a one-MiB response bound per request. Both had terminal newlines. Independent line comparison and the provider blocks both yielded 4 additions and 4 deletions. The final unchanged block had equal original/modified counts.

The runtime no longer publishes the thirteen-file raw sums above as complete totals: that comparison includes an added file with ambiguous terminal-segment counting. It retains the complete file count but returns unavailable line totals. Added/deleted files, EOF edits and added/removed terminal newlines are deliberately unavailable. Interior changes can be counted only when each returned file has both original/current paths and a positive equal-count trailing unchanged block, which excludes the terminal segment from the changed counts. Any unavailable comparison remains retryable, not an immutable successful cache entry. No per-block subtraction or runtime content-download architecture was introduced. Tests cover added/deleted files with and without terminal newlines, EOF edits, terminal-newline addition/removal, ambiguous zero blocks, interior changes and verified empty comparisons.

## Bounded content fallback, superseding the conservative EOF restriction

The owner authorized narrow immutable content reads for ambiguous files. The implementation now counts common additions/deletions/EOF edits instead of leaving all such comparisons unavailable. The earlier conservative policy above records the review state before this authorization; it is no longer the current behavior.

The actual Azure adapter, real ProviderHttp/FetchHttpClient transport, and existing Azure CLI authentication produced Complete statistics for the thirteen-file PR: **158 additions, 176 deletions**. It used two file-diff POSTs and **one** additional content request, only for the ambiguous added file. Repeating the same comparison made zero further content requests and zero further diff POSTs. It still resolves the iteration before checking the immutable completed cache.

An independent verification read all thirteen changed files at the exact common/source commits, with at most four concurrent verification requests. Twenty-five nonempty-side blob reads were hash-verified; cumulative decoded content was 626,861 bytes, below a two-MiB verification cap. Python's separate line comparison, preserving line endings, independently produced **158 additions, 176 deletions**. Source and target revisions matched the iteration and remained stable through verification. No contents were retained or shown.

The added file is physically 68 lines; the provider's raw 69th terminal segment is excluded by counting verified content, not by subtracting from every diff block. Runtime `items` requests specify `includeContent=true`, `includeContentMetadata=true`, and `versionDescriptor.versionType=commit` with the exact common/source commit. Returned path and commit must match. A hash over the reconstructed Git blob object must match `objectId`, which detects altered/truncated/lossy-decoded content. ASCII content advertised as code page 1252 was observed live and accepted only because its UTF-8 reconstruction is lossless and the blob hash matches.

Runtime budgets: at most twenty fallback reads; 512-KiB JSON response cap per read; at most 256 KiB and 10,000 lines per decoded side; two MiB cumulative decoded content; max edit length 1,000 and a 25-ms library abort budget per EOF diff. Thus fallback JSON is also bounded to ten MiB worst case. Added/deleted files use physical line counts including an unterminated final line, excluding a phantom trailing segment; empty files are zero only after exact empty-blob verification. EOF edits use `diff@9.0.0`, preserving terminal-newline and CRLF/LF differences. Its pinned README, line tokenizer and bounded diff implementation were inspected, including installed source. Tests cover all these semantics and failed identity/hash/encoding/binary/truncation/budget/cancellation paths.

Remaining limits: non-UTF-8 non-ASCII encodings, binary content, fork comparisons, or exhausted content/diff budgets remain unavailable. Oversized or invalid HTTP responses remain typed failures. The live PR qualified the added-file fallback; deleted-file and EOF-edit cases have supplied-service/exact-content tests rather than live provider-mutation fixtures. This implementation does not claim unbounded large-file support or Git algorithm equivalence for every possible diff tie-break.
