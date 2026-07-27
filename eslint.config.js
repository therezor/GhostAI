// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

/**
 * Package layering is enforced by two mechanisms working together:
 *
 *  1. pnpm's isolated node_modules. A package can only resolve `@ghostai/x`
 *     if it declares it in `dependencies`, so the dependency graph in the
 *     package manifests *is* the layer graph — an undeclared import fails to
 *     resolve rather than merely failing lint.
 *
 *  2. The rule below, which bans deep relative imports that would reach
 *     across a package boundary and bypass mechanism (1).
 *
 * Together these make an import cycle between packages impossible to
 * introduce accidentally, which matters because the agent loop must never
 * reach back into the HTTP server.
 */
const crossPackageImportRule = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['../../*'],
          message:
            'Deep relative imports across package boundaries are banned. Import the package by name (@ghostai/<pkg>) and declare it in package.json dependencies.',
        },
      ],
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'import-x': importX },
    rules: {
      ...crossPackageImportRule,

      // An agent runtime spawns background consolidation, subagents, MCP
      // reconnects and heartbeats. Unhandled floating promises are the #1
      // source of silent failure — this is why we use type-aware linting.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // The exec tool takes argv: string[] and runs execFile with shell:false.
      // There is no legitimate use of a shell anywhere in this codebase.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message:
            'shell: true is banned. The exec tool takes argv: string[] and runs execFile with shell: false.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'Math.random() breaks deterministic tests. Inject a generator, or use node:crypto for security-relevant randomness.',
        },
      ],
    },
  },
  {
    // Tests may be looser: fixtures use non-null assertions and unsafe casts freely.
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/testkit/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // A scripted async generator — a stream fixture — legitimately has
      // nothing to await; the rule only ever fires on those here.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Config files and scripts live outside every package tsconfig, so
    // type-aware rules cannot resolve them. Lint them syntactically only.
    files: ['**/*.config.{js,mjs,ts}', 'scripts/**/*.{js,mjs,ts}', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
