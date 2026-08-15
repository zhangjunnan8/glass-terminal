import { memo } from 'react';
import ReactMarkdown, { type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentChatItem } from '../../shared/agent';

const MARKDOWN_ELEMENTS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'img', 'input', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td',
  'th', 'thead', 'tr', 'ul',
];

export function safeAgentMarkdownUrl(url: string): string {
  if (/^#[A-Za-z0-9_.:-]+$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

const markdownUrlTransform: UrlTransform = (url) => safeAgentMarkdownUrl(url);

interface AgentMessageContentProps {
  role: AgentChatItem['role'];
  content: string;
  streaming?: boolean;
}

export const AgentMessageContent = memo(function AgentMessageContent({
  role,
  content,
  streaming = false,
}: AgentMessageContentProps) {
  if (role === 'user') {
    return <p className="agent-plain-message">{content}</p>;
  }
  if (streaming) {
    return (
      <div className="agent-markdown streaming" data-streaming="true">
        <p className="agent-plain-message">{content}</p>
        <span className="agent-streaming-cursor" aria-label="正在生成" />
      </div>
    );
  }
  return (
    <div className="agent-markdown" data-streaming="false">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        allowedElements={MARKDOWN_ELEMENTS}
        urlTransform={markdownUrlTransform}
        components={{
          a: ({ href, children }) => (href
            ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            : <span className="agent-markdown-link-disabled">{children}</span>),
          img: ({ alt }) => (
            <span className="agent-markdown-image-hidden">
              {alt ? `[图片已隐藏：${alt}]` : '[图片已隐藏]'}
            </span>
          ),
          input: (props) => <input {...props} disabled />,
        }}
      >{content}</ReactMarkdown>
    </div>
  );
});
