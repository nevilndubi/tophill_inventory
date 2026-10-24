import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ForbiddenPage from '@/app/(app)/forbidden/page';
import { permissionFailureDestination } from './route-authorization';

describe('hard-navigation authorization', () => {
  it('routes a STAFF user away from an administrative page', () => {
    expect(permissionFailureDestination('STAFF', 'user:manage')).toBe('/forbidden');
  });

  it('allows a role with the documented permission', () => {
    expect(permissionFailureDestination('ADMIN', 'user:manage')).toBeNull();
  });

  it('renders the dedicated signed-in 403 experience', () => {
    render(<ForbiddenPage />);
    expect(screen.getByText('403 — Permission denied')).toBeInTheDocument();
    expect(screen.getByText(/account is signed in/i)).toBeInTheDocument();
  });
});
