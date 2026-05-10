import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ remarkPlugins, children, ...rest }: Options) {
  const extra = (remarkPlugins ?? []).filter((p) => p !== remarkGfm);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, ...extra]} {...rest}>
      {children}
    </ReactMarkdown>
  );
}

export default Markdown;
