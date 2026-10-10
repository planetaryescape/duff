import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", ".amp/**"] },
  tseslint.configs.recommendedTypeChecked,
  {
    files: ["packages/**/*.ts"],
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
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: ["vscode", "duff", "duff/*", "**/extension/**"],
      }],
    },
  },
  {
    files: ["packages/extension/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["**/core/src/**", "@duff/core/pull-requests/github/*", "@duff/core/pull-requests/azure-devops/*"], message: "Import core through its declared service exports, not provider implementations." }],
      }],
    },
  },
  {
    files: ["packages/extension/src/**/*Commands.ts", "packages/extension/src/**/*View.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          "**/core/src/**", "**/github/**", "**/azure-devops/**", "**/ProviderHttp", "**/ProviderAuthentication", "@duff/core/pull-request-providers", "@duff/core/provider-authentication", "effect/http", "effect/http/*",
        ],
      }],
    },
  },
  {
    files: ["packages/**/*.ts"],
    ignores: ["packages/extension/src/extension.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "TSAsExpression, TSTypeAssertion", message: "Decode input instead of casting." },
        { selector: "CallExpression[callee.object.name='Effect'][callee.property.name='fn']:not([arguments.0.type='Literal'])", message: "Name meaningful operations with Effect.fn('Domain.operation')." },
        { selector: "CallExpression[callee.object.name='Effect'][callee.property.name=/^run/]", message: "Run Effect only at the extension integration boundary." },
        { selector: "CallExpression[callee.object.name='ManagedRuntime']", message: "The extension owns the runtime." },
      ],
    },
  },
);
