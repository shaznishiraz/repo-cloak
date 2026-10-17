import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'archive/', 'node_modules/', 'e2e/.build/', 'e2e/.e2e/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
);
