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
        +
      </button>
    </div>
  );
}
