import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './return-path';

describe('safeReturnPath', () => {
  it.each([
    [undefined, '/'],
    [null, '/'],
    ['', '/'],
    ['dashboard', '/'],
    ['//attacker.example/path', '/'],
    ['/\\attacker.example/path', '/'],
    ['https://attacker.example/path', '/'],
    ['javascript:alert(1)', '/'],
    ['/javascript:alert(1)', '/'],
    ['/dashboard', '/dashboard'],
    ['/machines?status=available#results', '/machines?status=available#results'],
  ])('maps %s to %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });
});
