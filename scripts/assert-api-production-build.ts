import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const apiBuildDirectory = join(process.cwd(), 'apps', 'api', 'dist');
const forbiddenMarker = 'RBAC_TEST_ONLY_CONTROLLER';

const compiledFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? compiledFiles(path) : [path];
  });

if (!existsSync(apiBuildDirectory)) {
  throw new Error('API production build directory is missing');
}

const leakedFixture = compiledFiles(apiBuildDirectory).find((file) => {
  if (!['.js', '.cjs', '.mjs', '.map'].includes(extname(file))) return false;
  return readFileSync(file, 'utf8').includes(forbiddenMarker);
});

if (leakedFixture !== undefined) {
  throw new Error('Test-only RBAC controller leaked into the API production build');
}

console.log('API production build excludes the test-only RBAC controller');
