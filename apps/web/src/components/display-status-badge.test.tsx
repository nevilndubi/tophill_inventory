import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DISPLAY_STATUSES, DISPLAY_STATUS_METADATA } from '@app/shared';
import { DisplayStatusBadge } from './display-status-badge';

describe('DisplayStatusBadge', () => {
  it.each(DISPLAY_STATUSES)(
    'uses shared icon, text and semantic colour metadata for %s',
    (status) => {
      const { container } = render(<DisplayStatusBadge status={status} />);
      expect(screen.getByText(DISPLAY_STATUS_METADATA[status].label)).toBeInTheDocument();
      expect(container.querySelector('svg')).toBeInTheDocument();
      expect(container.firstElementChild?.className).toMatch(/text-status-/);
    },
  );
});
