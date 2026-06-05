import 'katex/dist/katex.min.css';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeSlug, rehypeKatex];

export function Markdown(props: Omit<Options, 'remarkPlugins' | 'rehypePlugins'>) {
  return <ReactMarkdown {...props} remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} />;
}
