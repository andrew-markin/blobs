import { fixupPluginRules } from '@eslint/compat'
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import pluginImport from 'eslint-plugin-import'
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
      import: fixupPluginRules(pluginImport),
      'simple-import-sort': pluginSimpleImportSort
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'import/first': 'error',
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error'
    }
  }
])
