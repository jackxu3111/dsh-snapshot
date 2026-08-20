export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.superpowers/**'],
    files: ['**/*.js', '**/*.mjs', '**/*.ts'],
    rules: {
      'no-trailing-spaces': 'error',
      'no-warning-comments': 'warn',
    },
  },
]
