import { defineRule, eslintCompatPlugin, type ESTree } from '@oxlint/plugins'

function returnedObjects(node: ESTree.Expression): ReadonlyArray<ESTree.ObjectExpression> {
  switch (node.type) {
    case 'ObjectExpression':
      return [node]
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSTypeAssertion':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return returnedObjects(node.expression)
    case 'AwaitExpression':
      return returnedObjects(node.argument)
    case 'ConditionalExpression':
      return [...returnedObjects(node.consequent), ...returnedObjects(node.alternate)]
    case 'LogicalExpression':
      return [...returnedObjects(node.left), ...returnedObjects(node.right)]
    case 'ArrayExpression':
      return node.elements.flatMap((element) =>
        element ? returnedObjects(element.type === 'SpreadElement' ? element.argument : element) : [],
      )
    case 'SequenceExpression': {
      const last = node.expressions.at(-1)

      return last ? returnedObjects(last) : []
    }
    default:
      return []
  }
}

export const namedReturns = defineRule({
  meta: {
    type: 'problem',
    messages: {
      named: 'Return a named schema, variant, service, or class constructor instead of an anonymous object literal.',
    },
  },
  create(context) {
    return {
      ReturnStatement(node) {
        if (!node.argument) return

        for (const object of returnedObjects(node.argument))
          context.report({ node: object, messageId: 'named' })
      },
      ArrowFunctionExpression(node) {
        if (node.body.type === 'BlockStatement') return

        for (const object of returnedObjects(node.body))
          context.report({ node: object, messageId: 'named' })
      },
    }
  },
})

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
  rules: { 'runtime-boundary': runtimeBoundary, 'named-returns': namedReturns },
})
