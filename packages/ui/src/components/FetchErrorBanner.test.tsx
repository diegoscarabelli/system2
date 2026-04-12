import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchErrorBanner } from './FetchErrorBanner';

afterEach(cleanup);

describe('FetchErrorBanner', () => {
  it('renders the error message', () => {
    render(<FetchErrorBanner message="404 Not Found" onRetry={vi.fn()} />);
    expect(screen.getByText(/404 Not Found/)).toBeDefined();
  });

  it('has role="alert" for accessibility', () => {
    render(<FetchErrorBanner message="server error" onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('calls onRetry when the Retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<FetchErrorBanner message="timeout" onRetry={onRetry} />);
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
