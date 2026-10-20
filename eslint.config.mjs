import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

const webFiles = ['apps/web/**/*.{js,jsx,ts,tsx}'];
const nonWebTypeScriptFiles = ['apps/api/**/*.ts', 'packages/shared/**/*.ts'];
const allTypeScriptFiles = ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'];

const scopeConfigs = (configs, files) =>
  configs.map((config) => ({
    ...config,
    files,
  }));

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/.next/**',
    '**/dist/**',
    '**/coverage/**',
    '**/next-env.d.ts',
  ]),
  {
    ...js.configs.recommended,
    files: nonWebTypeScriptFiles,
  },
  ...scopeConfigs(tseslint.configs.recommended, nonWebTypeScriptFiles),
  ...scopeConfigs(nextVitals, webFiles),
  ...scopeConfigs(nextTypeScript, webFiles),
  {
    files: webFiles,
    settings: {
      next: {
        rootDir: 'apps/web/',
      },
    },
  },
  {
    files: allTypeScriptFiles,
    rules: {
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  prettier,
]);
