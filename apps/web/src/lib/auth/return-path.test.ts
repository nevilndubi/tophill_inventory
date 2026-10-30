import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './return-path';

describe('safeReturnPath', () => {
  it.each([
    [undefined, '/status'],
    [null, '/status'],
    ['', '/status'],
    ['dashboard', '/status'],
    ['//attacker.example/path', '/status'],
    ['/\\attacker.example/path', '/status'],
    ['https://attacker.example/path', '/status'],
    ['javascript:alert(1)', '/status'],
    ['/javascript:alert(1)', '/status'],
    ['/dashboard', '/dashboard'],
    ['/machines?status=available#results', '/machines?status=available#results'],
    ['/scan/HM-000123', '/scan/HM-000123'],
    ['/scan%2fHM-000123', '/status'],
    ['/scan%5cHM-000123', '/status'],
  ])('maps %s to %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });
});
