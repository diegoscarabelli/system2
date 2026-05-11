import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const REMARK_PLUGINS = [remarkGfm];

export function Markdown(props: Omit<Options, 'remarkPlugins'>) {
  return <ReactMarkdown {...props} remarkPlugins={REMARK_PLUGINS} />;
}
