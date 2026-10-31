# Delivery within PR26

Continue the existing prototype branch/PR rather than create a dependent PR with an unmerged native prerequisite. Keep logical atomic commits and leave unrelated Zed/root changes unstaged.

1. **Latest Rune + correct interaction seam:** pin current upstream, reproducible local patch/bootstrap, original source coordinates and tests. Existing review still works before language controls are wired.
2. **Real revision-aware analysis:** immutable source context, trusted language-server ownership, explicit enablement, typed hover/definition operations, cancellation and real-seam tests. No changes to VS Code behaviour.
3. **Native hover/definition UX:** use the seam end to end, readiness/trust/limited states, return navigation, selection compatibility, real native evidence and accurate documentation.

Review the combined PR, not just each commit. Fix confirmed findings and rerun affected checks. Merge only after actual native and backend evidence, passing CI and no unresolved material review findings. Opening or pushing does not itself mean the feature is done.

After PR26 is merged, start a separate **Claude** thread from the merged remote `main` for the requested UI/UX audit. It must inspect actual rendered states and interactions, make warranted changes and stop at an open PR. It must not merge its own audit PR or inherit private artifacts into public evidence. Pass it concrete known limitations and native launch instructions rather than suggesting the audit proves language correctness.
