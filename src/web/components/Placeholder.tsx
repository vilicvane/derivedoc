/** 没选中文档时的空状态：空项目、失效链接、以及默认提示。 */
export function Placeholder({
  missing,
  selected,
  hasDocs,
  onOpenFirst,
}: {
  missing: boolean;
  selected?: string;
  hasDocs: boolean;
  onOpenFirst: () => void;
}) {
  return (
    <div className="placeholder">
      <p>
        {missing
          ? `找不到这篇文档：${selected}`
          : hasDocs
            ? '左侧选一篇文档开始。'
            : '还没有任何文档。点左侧 source 的 ＋，写下第一条决定。'}
      </p>
      {missing && (
        <button className="placeholder-action" onClick={onOpenFirst} type="button">
          回到第一篇
        </button>
      )}
      <div className="keys">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> 切换文档
        </span>
        <span>
          <kbd>⌘K</kbd> 搜索
        </span>
        <span>
          <kbd>⌘S</kbd> 保存
        </span>
        <span>
          <kbd>Esc</kbd> 关闭 diff
        </span>
      </div>
    </div>
  );
}
