# Plugin interface design: progress

## Status: Paused

This tech-spec-pro design lives in the blueprint at the owner's request.
It covers the general plugin interface, with provider discovery as its first concrete contribution.
Drafted layers are not accepted decisions or implemented behavior.

- [x] Layer 0: Problem frame (confirmed; built-ins accepted in D005)
- [x] Layer 1: Shape (confirmed; one shared provider capability)
- [x] Layer 2: Alternatives (skipped; no competing design requested)
- [x] Layer 3: Contracts (design confirmed; sketches not implemented)
- [ ] Layer 4: Flows (drafted, awaiting feedback)
- [ ] Layer 5: File map
- [ ] Layer 6: Test plan
- [ ] Layer 7: PR delivery slices
- [ ] Plannotator review

## Log

- 2026-10-09: Created design record under docs/blueprint/plugins.
- 2026-10-09: Drafted problem frame for the general plugin boundary; paused before shape and typed contracts.
- 2026-10-09: Owner confirmed built-in plugins; recorded D005 as accepted and confirmed the problem frame.
- 2026-10-09: Drafted [shape](01-shape.md); paused before alternatives and typed contracts.
- 2026-10-09: Owner confirmed the shape and equal GitHub/Azure capability through one contract. Skipped alternatives.
- 2026-10-09: Drafted [contracts](03-contracts.md), separating local credential strategy from provider API authentication; paused for feedback.
- 2026-10-10: Owner confirmed the contract direction and asked to continue.
- 2026-10-10: Drafted [flows](04-flows.md), including partial pagination, interruption, and startup authentication policy; paused before file map.
