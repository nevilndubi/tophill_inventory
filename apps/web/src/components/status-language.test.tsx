import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusLanguage } from './status-language';

describe('StatusLanguage', () => {
  it.each([
    ['available', 'Available'],
    ['in-use', 'In use'],
    ['needs-service', 'Needs service'],
    ['maintenance', 'Under maintenance'],
    ['out-of-service', 'Out of service'],
    ['retired', 'Retired'],
  ])('renders %s with text, an icon, and semantic colour tokens', (status, label) => {
    const { container } = render(<StatusLanguage />);
    const item = container.querySelector(`[data-machine-status="${status}"]`);

    expect(item).not.toBeNull();
    expect(within(item as HTMLElement).getByText(label)).toBeInTheDocument();
    expect(item?.querySelector('svg')).toBeInTheDocument();
    expect(item?.className).toMatch(/text-status-/);
  });
});
