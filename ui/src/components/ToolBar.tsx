import React from 'react';
import { ToolbarIcon } from './Icons';

interface ToolBarProps {
  onAdd: () => void;
  onResume: () => void;
  onPause: () => void;
  onStopAll: () => void;
  onDelete: () => void;
  onStartQueue: () => void;
  onOpenSettings: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedCount: number;
  canResume: boolean;
  canPause: boolean;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

export const ToolBar: React.FC<ToolBarProps> = ({
  onAdd,
  onResume,
  onPause,
  onStopAll,
  onDelete,
  onStartQueue,
  onOpenSettings,
  searchQuery,
  onSearchChange,
  selectedCount,
  canResume,
  canPause,
  searchInputRef,
}) => {
  return (
    <div id="tool" role="toolbar" aria-label="Download Actions">
      <button type="button" className="tb" data-a="add" onClick={onAdd} title="Add URL (Ctrl+N)">
        <ToolbarIcon kind="add" />
        <span>Add URL</span>
      </button>

      <button
        type="button"
        className="tb"
        data-a="resume"
        onClick={onResume}
        disabled={selectedCount === 0 || !canResume}
        title={selectedCount > 1 ? `Resume ${selectedCount} Downloads` : 'Resume'}
      >
        <ToolbarIcon kind="resume" />
        <span>Resume</span>
      </button>

      <button
        type="button"
        className="tb"
        data-a="pause"
        onClick={onPause}
        disabled={selectedCount === 0 || !canPause}
        title={selectedCount > 1 ? `Pause ${selectedCount} Downloads` : 'Pause'}
      >
        <ToolbarIcon kind="pause" />
        <span>Pause</span>
      </button>

      <button type="button" className="tb" data-a="stopall" onClick={onStopAll} title="Stop all active downloads">
        <ToolbarIcon kind="stopall" />
        <span>Stop all</span>
      </button>

      <button
        type="button"
        className="tb"
        data-a="del"
        onClick={onDelete}
        disabled={selectedCount === 0}
        title={selectedCount > 1 ? `Delete ${selectedCount} Downloads` : 'Delete (Del)'}
      >
        <ToolbarIcon kind="del" />
        <span>{selectedCount > 1 ? `Delete (${selectedCount})` : 'Delete'}</span>
      </button>

      <span className="vs" aria-hidden="true" />

      <button type="button" className="tb" data-a="queue" onClick={onStartQueue} title="Start queued downloads">
        <ToolbarIcon kind="queue" />
        <span>Start queue</span>
      </button>

      <span className="vs" aria-hidden="true" />

      <button type="button" className="tb" data-a="settings" onClick={onOpenSettings} title="Settings (Ctrl+,)">
        <ToolbarIcon kind="settings" />
        <span>Settings</span>
      </button>

      <div className="qwrap">
        <input
          ref={searchInputRef}
          className="in"
          id="q"
          type="text"
          placeholder="Search downloads…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && searchQuery) {
              e.stopPropagation();
              onSearchChange('');
            }
          }}
          aria-label="Search downloads"
        />
        {searchQuery && (
          <button
            type="button"
            className="qclear"
            onClick={() => onSearchChange('')}
            title="Clear search"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
};
