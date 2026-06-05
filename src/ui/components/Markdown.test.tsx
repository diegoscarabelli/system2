import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

describe('Markdown', () => {
  it('assigns slug ids to headings so in-page anchor links resolve', () => {
    const { container } = render(<Markdown>{'# Hello World'}</Markdown>);
    const heading = container.querySelector('h1');
    expect(heading?.id).toBe('hello-world');
  });

  it('normalizes punctuation and case into GitHub-style slugs', () => {
    const { container } = render(<Markdown>{'## Final Results!'}</Markdown>);
    const heading = container.querySelector('h2');
    // Matches what an author writes for GitHub: `#final-results`.
    expect(heading?.id).toBe('final-results');
  });

  it('renders an anchor link whose href targets the generated heading id', () => {
    const { container } = render(<Markdown>{'[Go](#section)\n\n## Section'}</Markdown>);
    const link = container.querySelector('a');
    const heading = container.querySelector('h2');
    expect(link?.getAttribute('href')).toBe('#section');
    expect(heading?.id).toBe('section');
  });
});
