import {DiffEditor, Editor, loader} from '@monaco-editor/react';
import {useEffect, useRef, useState} from 'react';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
// 只引编辑器核心 + markdown 高亮，不引整套语言与 LSP：dev 的依赖预打包和线上包体积
// 都会小一个量级。
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/languages/definitions/markdown/register.js';

// 本地打包 Monaco（不走 CDN）。所有语言都复用基础 editor worker——这个项目只编辑
// markdown，不需要 ts/json/css/html 那几套语言服务，也省掉几个 MB 的 worker 产物。
self.MonacoEnvironment = {getWorker: () => new editorWorker()};
loader.config({monaco});

// 编辑器主题跟着界面色板走，别让编辑器像嵌进来的另一个产品。
monaco.editor.defineTheme('derivedoc-light', {
  base: 'vs',
  inherit: true,
  rules: [
    {token: 'keyword', foreground: 'b23a1a', fontStyle: 'bold'},
    {token: 'string', foreground: '1d5a8e'},
    {token: 'comment', foreground: 'a89f8e', fontStyle: 'italic'},
    {token: 'type', foreground: '8a6d1f'},
    {token: 'variable', foreground: '8a6d1f'},
    {token: 'strong', fontStyle: 'bold'},
  ],
  colors: {
    'editor.background': '#fffdf9',
    'editor.foreground': '#1b1917',
    'editor.lineHighlightBackground': '#f5efe3',
    'editorLineNumber.foreground': '#c8bfae',
    'editorLineNumber.activeForeground': '#7a7264',
    'editorCursor.foreground': '#b23a1a',
    'editor.selectionBackground': '#f0dfd4',
    'editorIndentGuide.background1': '#ece4d6',
    'scrollbarSlider.background': '#00000012',
    'scrollbarSlider.hoverBackground': '#00000022',
    'diffEditor.insertedLineBackground': '#2f7a4f14',
    'diffEditor.insertedTextBackground': '#2f7a4f26',
    'diffEditor.removedLineBackground': '#a32b1e12',
    'diffEditor.removedTextBackground': '#a32b1e26',
  },
});

monaco.editor.defineTheme('derivedoc-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    {token: 'keyword', foreground: 'e8896a', fontStyle: 'bold'},
    {token: 'string', foreground: '7fb3d5'},
    {token: 'comment', foreground: '77705f', fontStyle: 'italic'},
    {token: 'type', foreground: 'd6c07a'},
    {token: 'variable', foreground: 'd6c07a'},
    {token: 'strong', fontStyle: 'bold'},
  ],
  colors: {
    'editor.background': '#1c1a17',
    'editor.foreground': '#e8e2d6',
    'editor.lineHighlightBackground': '#252220',
    'editorLineNumber.foreground': '#4f4a42',
    'editorLineNumber.activeForeground': '#a39a8a',
    'editorCursor.foreground': '#e8896a',
    'editor.selectionBackground': '#4a3a30',
    'editorIndentGuide.background1': '#2a2724',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff26',
    'diffEditor.insertedLineBackground': '#7bbf8e14',
    'diffEditor.insertedTextBackground': '#7bbf8e26',
    'diffEditor.removedLineBackground': '#e8896a12',
    'diffEditor.removedTextBackground': '#e8896a26',
  },
});

function currentTheme(): string {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'derivedoc-dark'
    : 'derivedoc-light';
}

/** 跟随系统深浅色：切主题时编辑器一起换，别让两边不一致。 */
function useTheme(): string {
  const [theme, setTheme] = useState(currentTheme);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');

    if (!media) {
      return;
    }

    const onChange = () => setTheme(currentTheme());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return theme;
}

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

export interface Pick {
  from: number;
  to: number;
  text: string;
}

const PICK_LABEL = '已选中，agent 可读';

/** 选区上方的小标：说明这段已经交给 agent 了。 */
function createPickBadge(): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'pick-badge';

  const label = document.createElement('span');
  label.className = 'pick-label';
  label.textContent = PICK_LABEL;

  dom.append(label);
  return dom;
}

/**
 * 选中非空就回报（行号 1 起、含两端），并在选区开头**上方**挂一条提示——用 Monaco 的 content
 * widget，位置和滚动都由编辑器管。拖拽过程中先不显示：widget 压在正文上会挡住正在拉的选区。
 */
function watchSelection(
  editor: monaco.editor.ICodeEditor,
  report: (pick: Pick | undefined) => void,
): void {
  let position: monaco.IPosition | undefined;
  let dragging = false;
  const dom = createPickBadge();
  const widget: monaco.editor.IContentWidget = {
    allowEditorOverflow: true,
    getId: () => 'derivedoc.pick',
    getDomNode: () => dom,
    getPosition: () =>
      position
        ? {
            position,
            preference: [
              monaco.editor.ContentWidgetPositionPreference.ABOVE,
              monaco.editor.ContentWidgetPositionPreference.BELOW,
            ],
          }
        : null,
  };

  editor.addContentWidget(widget);

  const hidePosition = () => {
    position = undefined;
    editor.layoutContentWidget(widget);
  };

  const refresh = (place: boolean) => {
    const model = editor.getModel();
    const selection = editor.getSelection();
    const text = model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';

    if (!selection || !text.trim()) {
      hidePosition();
      report(undefined);
      return;
    }

    report({from: selection.startLineNumber, to: selection.endLineNumber, text});

    if (place) {
      position = selection.getStartPosition();
      editor.layoutContentWidget(widget);
    }
  };

  // 鼠标按下先把提示收起来，松手之后再贴出来：否则它正好压住正在拉的选区。
  editor.onMouseDown(() => {
    dragging = true;
    hidePosition();
  });
  editor.onMouseUp(() => {
    dragging = false;
    refresh(true);
  });
  editor.onDidChangeCursorSelection(() => refresh(!dragging));
}

export function MarkdownEditor({
  value,
  onChange,
  onPick,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onPick?: (pick: Pick | undefined) => void;
  autoFocus?: boolean;
}) {
  const theme = useTheme();

  return (
    <div className="editor">
      <Editor
        language="markdown"
        loading={
          <div className="editor-loading">
            <span>正在加载编辑器…</span>
          </div>
        }
        onChange={next => onChange(next ?? '')}
        onMount={editor => {
          if (autoFocus) {
            editor.focus();
          }

          if (onPick) {
            watchSelection(editor, onPick);
          }
        }}
        options={EDITOR_OPTIONS}
        theme={theme}
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
  onPick,
}: {
  original: string;
  modified: string;
  originalLabel?: string;
  modifiedLabel?: string;
  onPick?: (pick: Pick | undefined) => void;
}) {
  const theme = useTheme();

  return (
    <div className="editor">
      <DiffEditor
        language="markdown"
        loading={
          <div className="editor-loading">
            <span>正在加载编辑器…</span>
          </div>
        }
        modified={modified}
        onMount={editor => {
          if (onPick) {
            // 右侧是工作区内容，用户能选的就是它。
            watchSelection(editor.getModifiedEditor(), onPick);
          }
        }}
        options={{
          ...EDITOR_OPTIONS,
          readOnly: true,
          renderSideBySide: true,
          renderOverviewRuler: false,
          originalEditable: false,
        }}
        original={original}
        theme={theme}
      />
      {originalLabel && modifiedLabel && (
        <p className="editor-caption">
          {originalLabel} → {modifiedLabel}
        </p>
      )}
    </div>
  );
}
