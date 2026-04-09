import { useMemo } from 'preact/hooks';

interface Props {
  content: string;
  className?: string;
}

// Simple markdown parser - handles common patterns without heavy dependencies
export function MarkdownViewer({ content, className = '' }: Props) {
  const html = useMemo(() => parseMarkdown(content), [content]);

  return (
    <div
      class={`markdown-viewer ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// Escape HTML entities
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Parse inline markdown (bold, italic, code, links)
function parseInline(text: string): string {
  let result = escapeHtml(text);

  // Code (backticks) - must be before other patterns
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // Bold (**text** or __text__)
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_)
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  result = result.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>');

  return result;
}

// Main parser
function parseMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeContent: string[] = [];
  let inList = false;
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      output.push('<ul class="md-list">');
      for (const item of listItems) {
        output.push(`<li>${parseInline(item)}</li>`);
      }
      output.push('</ul>');
      listItems = [];
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        output.push(`<pre class="md-code-block"><code class="language-${codeBlockLang}">${escapeHtml(codeContent.join('\n'))}</code></pre>`);
        codeContent = [];
        inCodeBlock = false;
        codeBlockLang = '';
      } else {
        // Start code block
        flushList();
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim() || 'text';
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent.push(line);
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      flushList();
      const level = headerMatch[1].length;
      output.push(`<h${level} class="md-h${level}">${parseInline(headerMatch[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushList();
      output.push('<hr class="md-hr"/>');
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList();
      output.push(`<blockquote class="md-blockquote">${parseInline(line.slice(2))}</blockquote>`);
      continue;
    }

    // Unordered list
    const listMatch = line.match(/^[\s]*[-*+]\s+(.*)$/);
    if (listMatch) {
      inList = true;
      listItems.push(listMatch[1]);
      continue;
    }

    // Ordered list
    const orderedMatch = line.match(/^[\s]*\d+\.\s+(.*)$/);
    if (orderedMatch) {
      inList = true;
      listItems.push(orderedMatch[1]);
      continue;
    }

    // Empty line ends list
    if (line.trim() === '') {
      flushList();
      continue;
    }

    // Paragraph
    flushList();
    output.push(`<p class="md-p">${parseInline(line)}</p>`);
  }

  // Flush remaining
  flushList();
  if (inCodeBlock && codeContent.length > 0) {
    output.push(`<pre class="md-code-block"><code>${escapeHtml(codeContent.join('\n'))}</code></pre>`);
  }

  return output.join('\n');
}

// Detect if text looks like markdown
export function isMarkdownText(text: string): boolean {
  // Check for common markdown patterns
  return /^#{1,6}\s/m.test(text) ||   // Headers
         /\*\*[^*]+\*\*/m.test(text) || // Bold
         /```[\s\S]*```/m.test(text) ||  // Code blocks
         /^\s*[-*+]\s/m.test(text) ||   // Lists
         /\[.+\]\(.+\)/m.test(text);     // Links
}
