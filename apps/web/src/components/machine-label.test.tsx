import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ROLES, can } from '@app/shared';
import { MachineLabel } from './machine-label';

const machine = {
  assetTag: 'HM-000123',
  condition: 'OPERATIONAL' as const,
  department: { code: 'ICU', id: '22222222-2222-4222-8222-222222222222', name: 'ICU' },
  id: '00000000-0000-4000-8000-000000000123',
  location: { id: '44444444-4444-4444-8444-444444444444', name: 'Bay A' },
  name: 'Ward ventilator',
  registryStatus: 'ACTIVE' as const,
};

describe('MachineLabel', () => {
  it.each(['single', 'sheet'] as const)(
    'renders a scannable %s label with human fallback',
    (preset) => {
      const { container } = render(
        <MachineLabel
          appOrigin="https://inventory.example.test"
          machine={machine}
          preset={preset}
        />,
      );
      expect(screen.getByText('HM-000123')).toBeInTheDocument();
      expect(screen.getByText('Ward ventilator')).toBeInTheDocument();
      expect(screen.getByText(/open inventory\.example\.test\/scan/i)).toBeInTheDocument();
      expect(container.querySelector('[data-qr-payload]')).toHaveAttribute(
        'data-qr-payload',
        'https://inventory.example.test/scan/HM-000123',
      );
      expect(container.querySelector('[data-label-preset]')).toHaveAttribute(
        'data-label-preset',
        preset,
      );
    },
  );

  it('keeps scan and print reads available to every documented active role', () => {
    for (const role of ROLES) expect(can(role, 'machine:read'), role).toBe(true);
  });
});
