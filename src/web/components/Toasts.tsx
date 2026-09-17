import {AlertTriangle, Check} from 'lucide-react';

import type {Toast} from '../types.ts';

/** 右下角的提示条。 */
export function Toasts({items}: {items: Toast[]}) {
  return (
    <div className="toasts">
      {items.map(item => (
        <div className={`toast ${item.kind}`} key={item.id}>
          {item.kind !== 'info' && (
            <span className="icon">
              {item.kind === 'ok' ? <Check size={13} /> : <AlertTriangle size={13} />}
            </span>
          )}
          {item.text}
        </div>
      ))}
    </div>
  );
}
