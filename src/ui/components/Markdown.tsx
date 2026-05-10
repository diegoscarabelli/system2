import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ remarkPlugins, children, ...rest }: Options) {
  const plugins = remarkPlugins ? [remarkGfm, ...remarkPlugins] : [remarkGfm];
  return (
    <ReactMarkdown remarkPlugins={plugins} {...rest}>
      {children}
    </ReactMarkdown>
  );
}

export default Markdown;
