module.exports = {
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  setupFiles: ['<rootDir>/test/setup-env.cjs'],
  testEnvironment: 'node',
  testRegex: '.*(?:\\.spec|\\.e2e-spec)\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json', useESM: true }],
  },
};
