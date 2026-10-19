import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig({
  files: ['src/**/*.ts'],
  extends: [js.configs.recommended, tseslint.configs.recommended],
  languageOptions: { globals: globals.browser },
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
  },
});
