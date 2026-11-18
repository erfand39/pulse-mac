import tseslint from 'typescript-eslint'

export default [
  { ignores: ['dist/**', 'out/**', 'node_modules/**'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-debugger': 'error',
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'error'
    }
  },
  { files: ['scripts/*.mjs'], rules: { 'no-debugger': 'error', 'no-unreachable': 'error' } }
]
