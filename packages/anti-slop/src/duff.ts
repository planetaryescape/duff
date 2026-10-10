import { defineRule, eslintCompatPlugin } from '@oxlint/plugins'

export const runtimeBoundary = defineRule({
  meta: {
    type: 'problem',
    messages: {
      runtime: 'Run Effect and construct ManagedRuntime only at the extension integration boundary.',
      span: 'Name meaningful operations with Effect.fn("Domain.operation").',
    },
  },
  create(context) {
    const entrypoint = context.filename.replaceAll('\\', '/').endsWith('/extension/src/extension.ts')

    return {
      CallExpression(node) {
        const callee = node.callee

        if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return

        const property = callee.property
        const name = !callee.computed && property.type === 'Identifier' ? property.name : undefined

        if (callee.object.name === 'Effect' && name === 'fn') {
          const argument = node.arguments[0]

          if (argument?.type !== 'Literal' || typeof argument.value !== 'string') {
            context.report({ node, messageId: 'span' })
          }
        }

        if (!entrypoint && (callee.object.name === 'ManagedRuntime' || (callee.object.name === 'Effect' && name?.startsWith('run')))) {
          context.report({ node, messageId: 'runtime' })
        }
      },
    }
  },
})

export default eslintCompatPlugin({
  meta: { name: 'duff' },
  rules: { 'runtime-boundary': runtimeBoundary },
})
