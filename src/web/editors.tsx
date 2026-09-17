import {DiffEditor, Editor, loader} from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as monaco from 'monaco-editor';

// 本地打包 Monaco（不走 CDN）。所有语言都复用基础 editor worker——这个项目只编辑
// markdown，不需要 ts/json/css/html 那几套语言服务，也省掉几个 MB 的 worker 产物。
self.MonacoEnvironment = {getWorker: () => new editorWorker()};
loader.config({monaco});

const THEME = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs';

const EDITOR_OPTIONS = {
  fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
  fontSize: 13,
  lineHeight: 20,
  minimap: {enabled: false},
  scrollBeyondLastLine: false,
  wordWrap: 'on' as const,
  renderLineHighlight: 'none' as const,
  padding: {top: 12, bottom: 12},
  tabSize: 2,
};

export function MarkdownEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="editor">
      <Editor
        language="markdown"
        onChange={next => onChange(next ?? '')}
        options={EDITOR_OPTIONS}
        theme={THEME}
        value={value}
      />
    </div>
  );
}

export function MarkdownDiff({
  original,
  modified,
  originalLabel,
  modifiedLabel,
}: {
  original: string;
  modified: string;
  originalLabel?: string;
  modifiedLabel?: string;
}) {
  return (
    <div className="editor">
      <DiffEditor
        language="markdown"
        modified={modified}
        options={{
          ...EDITOR_OPTIONS,
          readOnly: true,
          renderSideBySide: true,
          renderOverviewRuler: false,
          originalEditable: false,
        }}
        original={original}
        theme={THEME}
      />
      {originalLabel && modifiedLabel && (
        <p className="editor-caption">
          {originalLabel} → {modifiedLabel}
        </p>
      )}
    </div>
  );
}
