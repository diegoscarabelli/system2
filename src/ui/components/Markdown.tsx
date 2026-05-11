import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown(props: Omit<Options, 'remarkPlugins'>) {
  return <ReactMarkdown {...props} remarkPlugins={[remarkGfm]} />;
}

export default Markdown;
