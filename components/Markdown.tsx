"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

// react-markdown passes a `node` prop that must not reach the DOM.
function withoutNode<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

const components: Components = {
  a: (props) => <a {...withoutNode(props)} target="_blank" rel="noreferrer noopener" />,
  table: (props) => (
    <div className="md-table">
      <table {...withoutNode(props)} />
    </div>
  ),
};

// Renders model output. Memoized on the text, so finished replies do not
// re-parse while another seat is streaming.
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
