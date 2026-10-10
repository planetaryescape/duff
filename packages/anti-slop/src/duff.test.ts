import { RuleTester } from 'oxlint/plugins-dev'

import { namedReturns, runtimeBoundary } from './duff.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('duff/named-returns', namedReturns, {
  valid: [
    'function build() { return Entry.make({ cursor }); }',
    'const build = () => new Entry({ cursor });',
    'const build = () => Service.of({ read: () => cursor });',
    'const build = () => Ready({ items: [{ id: "1" }] });',
    'function build() { const entry = Entry.make({ cursor }); return entry; }',
    'const refs = items.map((item) => item.ref);',
    'const build = () => (ready ? Ready({ items }) : undefined);',
    'const build = () => ({ ignored: true }, Entry.make({ cursor }));',
  ],
  invalid: [
    { code: 'function build() { return { cursor }; }', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => ({ cursor });', errors: [{ messageId: 'named' }] },
    { code: 'function* build() { return { cursor }; }', errors: [{ messageId: 'named' }] },
    { code: 'const build = async () => ({ cursor });', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => ready ? { cursor } : { error };', errors: [{ messageId: 'named' }, { messageId: 'named' }] },
    { code: 'function build() { return ready && { cursor }; }', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => existing ?? { cursor };', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => [{ cursor }];', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => [...[{ cursor }]];', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => (record(), { cursor });', errors: [{ messageId: 'named' }] },
    { code: 'const build = async () => await { cursor };', errors: [{ messageId: 'named' }] },
    { code: 'function build() { return <Entry>{ cursor }; }', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => ({ cursor } satisfies Entry);', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => ({ cursor } as Entry)!;', errors: [{ messageId: 'named' }] },
    { code: 'const build = () => Entry.make({ next: () => ({ cursor }) });', errors: [{ messageId: 'named' }] },
  ],
})

tester.run('duff/runtime-boundary', runtimeBoundary, {
  valid: [
    'Effect.fn("Review.compare")(function* () {});',
    'Effect.fnUntraced(function* () {});',
    { code: 'ManagedRuntime.make(layer); Effect.runPromise(work);', filename: '/duff/packages/extension/src/extension.ts' },
  ],
  invalid: [
    { code: 'Effect.fn(function* () {});', errors: [{ messageId: 'span' }] },
    { code: 'Effect.fn(name)(function* () {});', errors: [{ messageId: 'span' }] },
    { code: 'Effect.runPromise(work);', errors: [{ messageId: 'runtime' }] },
    { code: 'ManagedRuntime.make(layer);', errors: [{ messageId: 'runtime' }] },
  ],
})
