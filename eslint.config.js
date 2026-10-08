// -----------------------------------------------------------------------------
// ESLint flat config.
//
//   - `@eslint/js` recommended  -> real mistakes (undefined vars, dead code…);
//   - layering rule              -> `src/frigate/` must never import the Gladys
//                                   SDK nor the Gladys adapter, so the Frigate
//                                   client stays testable alone and extractable
//                                   as its own npm package;
//   - `eslint-config-prettier`   -> Prettier owns formatting.
// -----------------------------------------------------------------------------

import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/', 'data/', 'coverage/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },
  {
    files: ['src/frigate/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@gladysassistant/*'],
              message: 'src/frigate/ must not depend on the Gladys SDK (layering rule).',
            },
            {
              group: ['**/gladys/**', '../gladys/*', '../config.js'],
              message: 'src/frigate/ must not depend on the Gladys adapter (layering rule).',
            },
          ],
        },
      ],
    },
  },
  prettier,
];
