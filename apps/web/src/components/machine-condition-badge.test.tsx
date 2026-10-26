import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MACHINE_CONDITIONS } from '@app/shared';
import { MachineConditionBadge } from './machine-condition-badge';

const labels = ['Operational', 'Needs service', 'Under maintenance', 'Out of service', 'Retired'];

describe('MachineConditionBadge', () => {
  it('renders every stored condition with icon, text and colour classes', () => {
    MACHINE_CONDITIONS.forEach((condition) => {
      const { unmount } = render(<MachineConditionBadge condition={condition} />);
      const badge = screen.getByText(labels[MACHINE_CONDITIONS.indexOf(condition)]!);
      expect(badge.querySelector('svg')).toBeInTheDocument();
      expect(badge.className).toContain('text-status-');
      unmount();
    });
  });

  it('does not introduce derived usage labels', () => {
    render(<MachineConditionBadge condition="OPERATIONAL" />);
    expect(screen.queryByText('Available')).not.toBeInTheDocument();
    expect(screen.queryByText('In use')).not.toBeInTheDocument();
  });
});
