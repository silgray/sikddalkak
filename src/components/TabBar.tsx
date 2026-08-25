import { useState } from 'react';
import type { Tab } from '../state/workspace';

type Props = {
  tabs: Tab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
};

export function TabBar({ tabs, activeTabId, onSelect, onAdd, onClose, onRename }: Props) {
  // 이름 변경 중인 탭 id. 더블클릭으로 진입, Enter/blur로 확정.
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTabId}
          className={tab.id === activeTabId ? 'tab tab-active' : 'tab'}
          onClick={() => onSelect(tab.id)}
          onDoubleClick={() => setEditingId(tab.id)}
        >
          {editingId === tab.id ? (
            <input
              className="tab-rename"
              autoFocus
              defaultValue={tab.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                onRename(tab.id, e.currentTarget.value);
                setEditingId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setEditingId(null);
              }}
            />
          ) : (
            <span className="tab-name">{tab.name}</span>
          )}
          {tabs.length > 1 && (
            <button
              type="button"
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button type="button" className="tab-add" title="New tab" onClick={onAdd}>
        {/* 데스크톱(탭 바 인라인)은 `+`, 서랍 안(모바일)은 "+ New tab" — 둘 다
            렌더하고 어느 쪽을 보일지는 미디어쿼리가 정한다(`tabBar.css`/
            `drawer.css`, `π`/`3.14` 라벨과 같은 요령, 대원칙 3). */}
        <span className="tab-add-compact" aria-hidden="true">
          +
        </span>
        <span className="tab-add-full">+ New tab</span>
      </button>
    </div>
  );
}
