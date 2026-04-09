import { useMemo } from 'preact/hooks';

interface DiffLine {
  type: 'header' | 'hunk' | 'add' | 'del' | 'context' | 'meta';
  content: string;
}

interface DiffFile {
  filename: string;
  lines: DiffLine[];
}

// Parse raw diff text into structured format
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;

  const lines = text.split('\n');

  for (const line of lines) {
    // New file header
    if (line.startsWith('diff --git')) {
      if (currentFile) files.push(currentFile);
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      currentFile = {
        filename: match?.[2] || match?.[1] || 'unknown',
        lines: [{ type: 'header', content: line }],
      };
      continue;
    }

    if (!currentFile) continue;

    // File metadata
    if (line.startsWith('index ') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('rename from') ||
        line.startsWith('rename to') ||
        line.startsWith('similarity index') ||
        line.startsWith('Binary files')) {
      currentFile.lines.push({ type: 'meta', content: line });
      continue;
    }

    // Hunk header
    if (line.startsWith('@@')) {
      currentFile.lines.push({ type: 'hunk', content: line });
      continue;
    }

    // Added line
    if (line.startsWith('+')) {
      currentFile.lines.push({ type: 'add', content: line });
      continue;
    }

    // Deleted line
    if (line.startsWith('-')) {
      currentFile.lines.push({ type: 'del', content: line });
      continue;
    }

    // Context line (unchanged)
    currentFile.lines.push({ type: 'context', content: line });
  }

  if (currentFile) files.push(currentFile);
  return files;
}

// Detect if text looks like a git diff
export function isDiffText(text: string): boolean {
  return text.includes('diff --git') ||
         (text.includes('@@') && (text.includes('+') || text.includes('-')));
}

interface Props {
  diff: string;
}

export function DiffViewer({ diff }: Props) {
  const files = useMemo(() => parseDiff(diff), [diff]);

  if (files.length === 0) {
    return <div class="diff-viewer-empty">No diff content</div>;
  }

  return (
    <div class="diff-viewer">
      {files.map((file, idx) => (
        <div key={idx} class="diff-file">
          <div class="diff-file-header">{file.filename}</div>
          <div class="diff-file-content">
            {file.lines.map((line, lineIdx) => (
              <div key={lineIdx} class={`diff-line diff-${line.type}`}>
                <span class="diff-line-prefix">
                  {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                </span>
                <span class="diff-line-content">
                  {line.type === 'add' || line.type === 'del'
                    ? line.content.slice(1)
                    : line.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
