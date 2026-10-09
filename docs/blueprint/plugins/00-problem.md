# General plugin interface

Status: proposed problem frame, awaiting feedback. No plugin runtime exists yet.

## Summary

Define how a plugin contributes a capability to Duff without changing the local review engine or putting provider behavior in editor callbacks. Start with GitHub and Azure DevOps PR discovery, but separate the common plugin boundary from the provider-specific operation contract. Use Effect for construction, dependencies, typed failures, and resource lifetime.

## Current state

- [BranchReview](../../../packages/core/src/review/BranchReview.ts) compares local Git snapshots and reads immutable content through the Git CLI.
- [GitContext](../../../packages/core/src/git-context/GitContext.ts) inspects safe local identity and remote metadata. Per-remote credential selection remains incomplete.
- [extension.ts](../../../packages/extension/src/extension.ts) composes Layers and owns one managed runtime. Feature modules own native commands and views.
- There is no plugin registry, plugin loader, provider API adapter, or PR-discovery UI.
- [D004](../02-decision-log.md#d004-provider-behavior-belongs-in-plugins) accepts plugins, starting with GitHub and Azure DevOps.
- [D005](../02-decision-log.md#d005-trusted-built-in-registry-for-the-first-plugins) proposes trusted built-ins. Distribution and authentication remain undecided.

## Problem

The [provider proposal](../03-identity-and-provider-strategies.md#2-provider-plugin-contract) names recognition, authentication inspection, and PR discovery, but does not define the common plugin boundary. We need to distinguish plugin identity and construction from the capability it contributes. Otherwise a general plugin interface could become a bag of optional provider methods, editor APIs, hooks, and secrets.

## Users and callers

- The reviewer selects a repository, inspects its Git context, and sees supported remotes and PR-discovery outcomes.
- The extension composition root selects available plugin implementations and supplies their dependencies.
- A discovery workflow uses the provider contribution without knowing its SDK, authentication transport, or URL spelling.
- Plugin authors implement a declared contribution and translate external results into Duff-owned values.

## Goals

1. A small common plugin definition, with stable identity and explicit typed contributions.
2. Provider discovery is a contribution contract, not a mandatory method set on every plugin.
3. Add or remove a provider without adding provider conditions to BranchReview or native views.
4. Dependencies and resource lifetime are explicit through Effect Layers and host-owned scopes.
5. Unsupported remotes, missing authentication, empty results, incomplete pagination, and failed requests remain distinct.
6. Multiple remotes and overlapping recognition cannot silently select the wrong repository or account.
7. Meaningful operations have named spans by default; credentials and private repository data stay out of exported telemetry.

## Non-goals

- Implementing plugins or changing the existing UI during this design.
- A marketplace, arbitrary repository scripts, dynamic code loading, or hot-swapping plugins.
- A generic command bus, universal event system, or generated interface framework.
- Plugin-defined views, custom diff renderers, Git mutations, or PR mutations.
- Credential storage or automatic login prompts.
- Replacing the Git CLI, adding infrastructure, or reorganizing the two workspace packages.

These exclusions limit the first design. They do not decide how independently distributed plugins would work later.

## Constraints

- Keep the accepted feature-owned core/extension structure from [D006](../02-decision-log.md#d006-feature-owned-core-and-editor-packages).
- Core contracts cannot import VS Code or provider SDK types. The host supplies editor-specific authentication adapters if that strategy is selected.
- Follow the pinned Effect 4.0.2 APIs and local Schema, tagged-error, service, and Layer conventions.
- Keep errors beside the capability that owns them, not in a central error package.
- Rat-stack is a reference, not a mandate to copy its package graph or projection framework.
- Preserve the [delivery order](../../implementation-plan.md): finish effective Git context before authenticated provider discovery.

## Invariants

- Local review works with no plugins, no session, and no network connection.
- Git commit attribution is not a verified provider account.
- Sanitized remote metadata is not an authentication credential.
- Plugin imports do not start I/O, acquire sessions, or register editor callbacks.
- The host owns cancellation and stale-result rejection. Plugin operations cooperate with interruption; plugin resources are released with their owning scope.
- One plugin's expected failure cannot turn another plugin's successful result into an empty discovery result.
- Discovery never silently fetches, checks out, or modifies the repository.
- Secrets stay behind adapters. Safe account metadata may reach the local UI, not exported telemetry.
- An in-process plugin is trusted code. A declared capability is an API boundary, not a sandbox or enforceable security permission.

## Open questions

1. Should the first contract target trusted built-in modules only, or independently installed VS Code extensions too? Recommendation: built-ins first, keep D005 proposed until confirmed.
2. Which authentication mechanism should each provider use? This may affect construction but must not leak into discovery callers.
3. Is there a concrete second contribution beyond provider discovery? Without one, avoid inventing a general hook catalog. Define a small envelope and one explicit contribution first.
4. How should overlapping recognition be resolved? Recommendation: surface ambiguity rather than select by registration order.

## Design references

- [Rat-stack: ports and adapters](https://ratstack.sh/lore/hexagonal-architecture): application-owned job interfaces and provider translation at adapters.
- [Rat-stack: uncomplect](https://ratstack.sh/skills/uncomplect): separate responsibilities and pressure-test removal rather than add pass-through services.
- [Existing architecture references](../01-architecture.md#reference-codebases-and-deferred-effect-tools): OpenCode v2 and the documented differences from rat-stack.
- Owner's tech-spec-pro and maintaining-blueprints skills: staged design, owner feedback, and separate proposal/delivery evidence.

Next layer: shape. Describe the plugin definition, contribution boundary, registration, construction, selection, and disposal before writing full TypeScript contracts.
