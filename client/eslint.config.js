import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

// Layer rules (plan §1):
//   core    -> core, ports
//   ports   -> ports
//   adapters-> ports (each adapter family is sealed; only adapters/gemini may import the SDK)
//   store   -> core, ports
//   ui      -> store, core, ports (types only by convention; never adapters)
//   app     -> anything (composition root)
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'core', pattern: 'src/core' },
        { type: 'ports', pattern: 'src/ports' },
        { type: 'adapters', pattern: 'src/adapters' },
        { type: 'store', pattern: 'src/store' },
        { type: 'ui', pattern: 'src/ui' },
        { type: 'app', pattern: 'src/app' },
      ],
      'boundaries/include': ['src/**/*.{ts,tsx}'],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'core', allow: ['core', 'ports'] },
            { from: 'ports', allow: ['ports'] },
            { from: 'adapters', allow: ['adapters', 'ports'] },
            { from: 'store', allow: ['store', 'core', 'ports'] },
            { from: 'ui', allow: ['ui', 'store', 'core', 'ports'] },
            { from: 'app', allow: ['app', 'core', 'ports', 'adapters', 'store', 'ui'] },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@google/genai',
              message: 'SDK imports are allowed only in src/adapters/gemini/ (plan §1 rule 3).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/adapters/gemini/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: { 'boundaries/element-types': 'off' },
  },
);
