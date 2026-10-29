import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-(\w+)/.exec(className || '')?.[1];
    const text = String(children ?? '');
    if (!lang && !text.includes('\n')) return <code>{children}</code>;
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang ?? ''} />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="scroll-y my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

/** Streaming-safe markdown (GFM). Raw HTML is not rendered. */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-desk">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
