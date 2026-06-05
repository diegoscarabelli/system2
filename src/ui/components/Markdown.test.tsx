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

  it('disambiguates repeated headings within a document', () => {
    const { container } = render(<Markdown>{'## Repeat\n\n## Repeat'}</Markdown>);
    const ids = [...container.querySelectorAll('h2')].map((h) => h.id);
    expect(ids).toEqual(['repeat', 'repeat-1']);
  });

  it('renders inline LaTeX math via KaTeX', () => {
    const { container } = render(<Markdown>{'Mass-energy: $E = mc^2$.'}</Markdown>);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('renders block LaTeX math via KaTeX', () => {
    const { container } = render(<Markdown>{'$$\n\\int_0^1 x^2 \\, dx\n$$'}</Markdown>);
    expect(container.querySelector('.katex-display')).not.toBeNull();
  });
});
