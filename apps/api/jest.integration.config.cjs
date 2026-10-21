const baseConfig = require('./jest.config.cjs');

module.exports = {
  ...baseConfig,
  collectCoverageFrom: [],
  setupFiles: [],
  testTimeout: 60_000,
  testRegex: '.*\\.integration-spec\\.ts$',
};
