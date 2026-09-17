import {useCallback, useEffect, useRef, useState} from 'react';

import type {Toast} from '../types.ts';

/** 顺手把文案翻成提示条的语义色。 */
function kindOf(text: string): Toast['kind'] {
  if (/失败|错误|无法|不在/.test(text)) {
    return 'error';
  }

  return /已保存|已提交|已删除|已载入|生效/.test(text) ? 'ok' : 'info';
}

/**
 * 右下角的提示条。同 key 的提示原地更新（「保存中…」变成「已保存」），不叠两条；
 * 最多同时留三条，每条 3.2 秒后自己消失。
 */
export function useToasts(): {
  toasts: Toast[];
  notify: (text: string, key?: string) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const latest = useRef<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  latest.current = toasts;

  const notify = useCallback((text: string, key?: string) => {
    if (!text) {
      return;
    }

    const existing = key ? latest.current.find(toast => toast.key === key) : undefined;
    const id = existing?.id ?? Date.now() + Math.random();
    const next: Toast = {id, kind: kindOf(text), text, ...(key ? {key} : {})};

    setToasts(current => {
      if (!existing) {
        return [...current.filter(toast => toast.id !== id).slice(-2), next];
      }

      return current.map(toast => (toast.id === id ? next : toast));
    });

    if (existing) {
      clearTimeout(timers.current.get(id));
    }

    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setToasts(current => current.filter(toast => toast.id !== id));
      }, 3200),
    );
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  return {toasts, notify};
}
