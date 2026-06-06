import 'katex/dist/katex.min.css';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

// Disable single-`$` inline math: `$5 and $10` is currency, not an equation.
// Math uses `$$…$$` (inline within text, or on its own lines for a display block).
const REMARK_PLUGINS: Options['remarkPlugins'] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
];
const REHYPE_PLUGINS = [rehypeKatex];
const REHYPE_PLUGINS_WITH_HEADING_IDS = [rehypeSlug, rehypeKatex];

type MarkdownProps = Omit<Options, 'remarkPlugins' | 'rehypePlugins'> & {
  /**
   * Assign slug `id`s to headings (via `rehype-slug`) so in-page `#fragment`
   * links resolve. Opt-in because the shared component renders many times per
   * page (e.g. the chat message list); enabling it globally would produce
   * duplicate DOM ids across instances. Enable it only for single-document
   * surfaces such as the artifact viewer.
   */
  enableHeadingIds?: boolean;
};

export function Markdown({ enableHeadingIds = false, ...props }: MarkdownProps) {
  return (
    <ReactMarkdown
      {...props}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={enableHeadingIds ? REHYPE_PLUGINS_WITH_HEADING_IDS : REHYPE_PLUGINS}
    />
  );
}
