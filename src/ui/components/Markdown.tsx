import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSlug];

export function Markdown(props: Omit<Options, 'remarkPlugins' | 'rehypePlugins'>) {
  return <ReactMarkdown {...props} remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} />;
}
