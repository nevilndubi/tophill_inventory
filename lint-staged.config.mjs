export default {
  '*.{ts,tsx}': ['eslint --fix --max-warnings=0', 'prettier --write'],
  '*.{js,mjs,cjs,json,jsonc,yml,yaml,md}': 'prettier --write',
};
