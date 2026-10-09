# Shape: built-in plugin interface

Status: proposed, awaiting feedback. Built-in distribution is accepted in [D005](../02-decision-log.md#d005-trusted-built-in-registry-for-the-first-plugins); the interface below is not implemented.
Scope and invariants: [problem frame](00-problem.md).

## Key domain concepts

| Concept | Responsibility |
| --- | --- |
| Plugin definition | Static identity and a recipe for constructing its contributions. Importing it performs no I/O. |
| Plugin instance | Constructed identity plus typed contributions, owned by the extension lifetime. |
| Contribution | Implementation of a specific Duff-owned capability contract. The first kind is provider discovery. |
| Registry | Explicit collection of built-in instances with unique plugin IDs. Not a loader or mutable global. |
| Discovery workflow | Matches remotes, selects contributions, performs bounded reads, and returns independent outcomes. |
| Provider repository handle | Recognized provider/repository identity bound to the contribution that recognized it. It is not a credential or local Git path. |

The general interface contains identity and contributions, not GitHub/Azure methods. Contributions use a closed, typed set of kinds, starting with provider discovery. Do not add a string-keyed map of arbitrary handlers or a method for every hypothetical extension point.

The registry is a supplied value. The discovery workflow earns an Effect service because it owns multi-plugin selection, execution, and failure policy. Do not add a service that merely forwards registry lookup.

## Boundaries and seams

```text
Extension composition root: one runtime and owning scope
    |
    +-- local Git Layers --------------------> BranchReview / GitContext
    |
    +-- supplied HTTP/auth dependencies
    |       |
    |       +-- GitHub plugin Layer ----------> provider contribution
    |       +-- Azure plugin Layer ----------> provider contribution
    |                                                |
    +-- explicit registry ---------------------------+
            |
            v
    Discovery workflow in core
            |
            v
    Normalized outcomes -> native commands and view
```

Core owns the contribution contract, its schemas/errors, and discovery policy. Built-in adapters implement that contract and hide provider protocol/authentication details. The extension composition root selects adapters and supplies dependencies; native views do not import adapters.

Keep provider network implementations outside core. Their exact location within the existing two packages belongs in the file-map layer; this does not introduce a third package or undo core's accepted local Git adapters.

Plugin definitions do not receive ExtensionContext, ManagedRuntime, process.env, a broad dependency bag, or direct mutable view access. Construction requirements propagate through Layers. Operations receive only the domain inputs they need and return Effects with typed results and failures.

Authentication acquisition remains inside the selected adapter. Provider-account metadata is a safe local projection, not an authorization token. A host-mediated login action can be designed once the authentication strategy is chosen; background inspection must not prompt.

## High-level flow

1. Activation assembles the explicit built-in definitions. Duplicate IDs are a programming/configuration error, never last-registration-wins behavior.
2. Their Layers construct contribution implementations in Duff's existing managed lifetime. Construction does not make network requests or require login. Expected provider unavailability is reported when the operation runs, not as failure of the local review runtime.
3. Local GitContext inspection produces sanitized remote metadata. Discovery is separate from branch comparison.
4. The workflow asks provider contributions to recognize each remote without network I/O or credential execution.
5. No match produces unsupported. One match binds the repository handle to that contribution. Multiple matches produce visible ambiguity, not a registry-order winner.
6. For a selected match, the contribution performs authentication inspection and paginated, read-only PR discovery through its supplied dependencies. Authentication may expire after inspection; listing still reports authorization failures truthfully.
7. The workflow preserves per-remote outcomes and pagination completeness. One expected failure does not discard successful results from another remote. It does not turn defects into successful empty results.
8. The editor boundary publishes only the current request generation. Repository changes or refresh interrupt stale discovery; deactivation disposes the runtime and plugin resources.

## Key decisions in this proposal

- **Static composition, not runtime loading.** Built-ins ship in the same bundle and compile against the same contracts. No manifest-version negotiation or dynamic registration API is needed.
- **Identity plus typed contributions.** Provider-specific jobs belong to the provider contribution, not the general plugin envelope. Add another kind only when a real feature needs it.
- **Layers own construction and cleanup.** Do not duplicate resource lifetime with a parallel activate/deactivate hook system or a runtime per plugin.
- **Recognition is a pure decision.** A sanitized remote is enough to recognize supported forms. Custom-host mappings are supplied configuration, not guessed from authentication.
- **Local review is independent.** No startup authentication or provider availability dependency is added to BranchReview.
- **Operations are observable, data stays private.** Meaningful workflow and adapter operations have named spans. Export only the existing safe outcome projection, never URLs, handles, PR titles, identities, cursors, or credentials.

## Risks and checks to design

- A shared service tag could overwrite one plugin with another. Contracts must preserve separate instances in the registry rather than repeatedly provide one provider tag.
- A repository handle could be sent to the wrong contribution. Bind recognition output to its owner and keep routing inside the discovery workflow.
- A plugin startup failure could break every command. Keep network/authentication out of Layer construction and test local review with absent or unavailable providers.
- Dynamic handler maps or catch-all host contexts could bypass the intended boundary. Prefer concrete contribution types and dependency requirements that the compiler can inspect.
- Interruption alone does not prevent late publication. Preserve request-generation checks at the editor boundary, as existing Git-context commands do.
- Trusted built-ins can still leak secrets or mutate Git. The interface is not a sandbox; adapter checks, privacy tests, and review remain necessary. No provider-specific fence ships with this document.

Next checkpoint: confirm this shape, then compare meaningful alternatives if needed and write the TypeScript contracts. Authentication transport can remain open while defining the capability boundary.
