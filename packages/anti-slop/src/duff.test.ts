import { RuleTester } from 'oxlint/plugins-dev'

import { runtimeBoundary } from './duff.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

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
