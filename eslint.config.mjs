import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".amp/**"] },
  tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-restricted-syntax": ["error", {
        selector: "TSAsExpression, TSTypeAssertion",
        message: "Decode boundary input with Schema instead of asserting its type.",
      }, {
        selector: "CallExpression[callee.object.name='Effect'][callee.property.name='fn']:not([arguments.0.type='Literal'])",
        message: "Name meaningful operations with Effect.fn('Domain.operation'); use fnUntraced deliberately for small helpers.",
      }],
    },
  },
  {
    files: ["src/review.ts", "src/git-context.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: ["vscode", "node:*", "./git-review", "./extension", "./review-view", "./git-context-adapter", "./git-context-view"],
      }],
    },
  },
  {
    files: ["src/review-view.ts", "src/review.ts", "src/git-context.ts", "src/git-context-view.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "TSAsExpression, TSTypeAssertion", message: "Decode input instead of casting." },
        { selector: "CallExpression[callee.object.name='Effect'][callee.property.name=/^run/]", message: "Run Effect only at the VS Code integration boundary." },
        { selector: "CallExpression[callee.object.name='ManagedRuntime']", message: "The extension owns the runtime." },
      ],
    },
  },
);
