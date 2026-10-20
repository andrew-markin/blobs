import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import pluginImportX from 'eslint-plugin-import-x'
import pluginSimpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'

export default defineConfig([
  {
    name: 'app/files-to-lint',
    files: ['**/*.{js,mjs,jsx}']
  },
  globalIgnores(['**/dist/**']),
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    }
  },
  js.configs.recommended,
  {
    plugins: {
      'import-x': pluginImportX,
      'simple-import-sort': pluginSimpleImportSort
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/no-duplicates': 'error'
    }
  }
])
