import { decodeQR } from 'qr/decode.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LABEL_SELECTION_STORAGE_KEY,
  MAX_LABEL_SELECTION,
  buildCanonicalAssetUrl,
  clearLabelSelection,
  createQrMatrix,
  isLabelSelectable,
  readLabelSelection,
  writeLabelSelection,
  type LabelMachine,
} from './asset-labels';

const machine = (
  index = 1,
  condition: LabelMachine['condition'] = 'OPERATIONAL',
): LabelMachine => ({
  assetTag: `HM-${String(index).padStart(6, '0')}`,
  condition,
  department: { code: 'ICU', id: '22222222-2222-4222-8222-222222222222', name: 'ICU' },
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  location: { id: '44444444-4444-4444-8444-444444444444', name: 'Bay A' },
  name: `Machine ${index}`,
});

const matrixImage = (matrix: boolean[][], scale = 8) => {
  const width = matrix.length * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = matrix[Math.floor(y / scale)]?.[Math.floor(x / scale)] ?? false;
      const offset = (y * width + x) * 4;
      data[offset] = dark ? 0 : 255;
      data[offset + 1] = dark ? 0 : 255;
      data[offset + 2] = dark ? 0 : 255;
      data[offset + 3] = 255;
    }
  }
  return { data, height: width, width };
};

describe('asset label contracts', () => {
  afterEach(() => clearLabelSelection());

  it('builds and decodes the exact canonical production payload', () => {
    const payload = buildCanonicalAssetUrl('https://inventory.tophill.example', ' hm-000123 ');
    expect(payload).toBe('https://inventory.tophill.example/scan/HM-000123');
    expect(decodeQR(matrixImage(createQrMatrix(payload)), { format: 'RGBA' })).toBe(payload);
  });

  it.each([
    'https://inventory.tophill.example/path',
    'https://inventory.tophill.example/',
    'https://user:secret@inventory.tophill.example',
    'http://inventory.tophill.example',
    'javascript:alert(1)',
  ])('rejects hostile or non-canonical application origin %s', (origin) => {
    expect(() => buildCanonicalAssetUrl(origin, 'HM-000001')).toThrow();
  });

  it('keeps a validated session-only selection capped at 48 and rejects retired labels', () => {
    const stored = writeLabelSelection(
      Array.from({ length: 55 }, (_, index) => machine(index + 1)),
    );
    expect(stored).toHaveLength(MAX_LABEL_SELECTION);
    expect(readLabelSelection()).toEqual(stored);
    expect(isLabelSelectable(machine(1, 'RETIRED'))).toBe(false);
    expect(isLabelSelectable(machine())).toBe(true);
    localStorage.setItem(LABEL_SELECTION_STORAGE_KEY, 'must remain unused');
    expect(localStorage.getItem(LABEL_SELECTION_STORAGE_KEY)).toBe('must remain unused');
  });
});
