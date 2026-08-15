import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentMessageContent, safeAgentMarkdownUrl } from './AgentMessageContent';

describe('AgentMessageContent', () => {
  it('renders completed assistant CommonMark and GFM as semantic markup', () => {
    const html = renderToStaticMarkup(
      <AgentMessageContent
        role="assistant"
        content={'## 结果\n\n**完成**，~~旧值~~。\n\n- [x] 已验证\n\n| 项目 | 状态 |\n| --- | --- |\n| 构建 | 通过 |\n\n```sh\necho ok\n```'}
      />,
    );

    expect(html).toContain('<h2>结果</h2>');
    expect(html).toContain('<strong>完成</strong>');
    expect(html).toContain('<del>旧值</del>');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code class="language-sh">echo ok');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-streaming="false"');
  });

  it('keeps growing output as escaped plain text until streaming completes', () => {
    const html = renderToStaticMarkup(
      <AgentMessageContent role="assistant" streaming content={'**尚未完成** <script>alert(1)</script>'} />,
    );

    expect(html).toContain('**尚未完成**');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('data-streaming="true"');
    expect(html).toContain('aria-label="正在生成"');
  });

  it('drops raw HTML, hides images, and permits only safe links', () => {
    const html = renderToStaticMarkup(
      <AgentMessageContent
        role="assistant"
        content={'<script>alert(1)</script>\n\n[x](javascript:alert(1)) [网页](https://example.com/a) ![追踪](https://tracker.invalid/pixel.png)'}
      />,
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)</script>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('[图片已隐藏：追踪]');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps user commands as literal plain text', () => {
    const html = renderToStaticMarkup(
      <AgentMessageContent role="user" content={'rm *.tmp && echo **literal**'} />,
    );
    expect(html).toContain('rm *.tmp &amp;&amp; echo **literal**');
    expect(html).not.toContain('<strong>');
  });

  it('rejects dangerous, relative, and credential-bearing URLs', () => {
    expect(safeAgentMarkdownUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(safeAgentMarkdownUrl('#section-1')).toBe('#section-1');
    expect(safeAgentMarkdownUrl('http://example.com')).toBe('');
    expect(safeAgentMarkdownUrl('javascript:alert(1)')).toBe('');
    expect(safeAgentMarkdownUrl('data:text/html,test')).toBe('');
    expect(safeAgentMarkdownUrl('file:///C:/secret')).toBe('');
    expect(safeAgentMarkdownUrl('//example.com/path')).toBe('');
    expect(safeAgentMarkdownUrl('/relative')).toBe('');
    expect(safeAgentMarkdownUrl('https://user:pass@example.com')).toBe('');
  });
});
