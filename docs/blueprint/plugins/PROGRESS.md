# Plugin interface design: progress

## Status: Implementation started

This tech-spec-pro design lives in the blueprint at the owner's request.
It covers the general plugin interface, with provider discovery as its first concrete contribution.
Drafted layers are not accepted decisions or implemented behavior.

- [x] Layer 0: Problem frame (confirmed; built-ins accepted in D005)
- [x] Layer 1: Shape (confirmed; one shared provider capability)
- [x] Layer 2: Alternatives (skipped; no competing design requested)
- [x] Layer 3: Contracts (design confirmed; sketches not implemented)
- [x] Layer 4: Flows (confirmed by request to continue)
- [x] Layer 5: File map (confirmed)
- [x] Layer 6: Test plan (confirmed; frontend checkouts approved for local ADO testing)
- [x] Layer 7: PR delivery slices (owner asked to implement)
- [ ] Plannotator review (flows session closed without annotations; full-spec review pending)

## Log

- 2026-10-09: Created design record under docs/blueprint/plugins.
- 2026-10-09: Drafted problem frame for the general plugin boundary; paused before shape and typed contracts.
- 2026-10-09: Owner confirmed built-in plugins; recorded D005 as accepted and confirmed the problem frame.
- 2026-10-09: Drafted [shape](01-shape.md); paused before alternatives and typed contracts.
- 2026-10-09: Owner confirmed the shape and equal GitHub/Azure capability through one contract. Skipped alternatives.
- 2026-10-09: Drafted [contracts](03-contracts.md), separating local credential strategy from provider API authentication; paused for feedback.
- 2026-10-10: Owner confirmed the contract direction and asked to continue.
- 2026-10-10: Drafted [flows](04-flows.md), including partial pagination, interruption, and startup authentication policy; paused before file map.
- 2026-10-10: Opened flows in Plannotator at the owner's request; session closed with no returned annotations. Owner asked to continue.
- 2026-10-10: Drafted [file map](05-file-map.md) within the existing two packages; paused before test plan.
- 2026-10-10: Owner confirmed the file map. Drafted [test plan](06-test-plan.md) with vertical red/green cycles and separate native/API evidence; paused before delivery slices.
- 2026-10-10: Owner confirmed the test plan and approved frontend checkouts for local ADO tests. Read-only remote-host inspection confirmed srx-app, srx-ui-lib, and srx-engine use Azure SSH.
- 2026-10-10: Drafted [delivery slices](07-pr-slices.md): finish Git context, integrated GitHub discovery, then Azure parity. Full-folder review remains pending.
- 2026-10-10: Owner asked to implement and permitted subagents. Started Slice 1 with conventional HTTP(S) credential-policy resolution and grouped native presentation. Unsupported contexts remain unresolved; the shared plugin contract and provider adapters are not implemented. Full-folder Plannotator session remains open, with no returned annotations at this check.
