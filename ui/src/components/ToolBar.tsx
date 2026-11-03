import React from 'react';

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
  hasSelection: boolean;
  selectedState?: string;
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
  hasSelection,
  selectedState,
}) => {
  const isSelectedActive = selectedState === 'downloading' || selectedState === 'probing';
  const isSelectedResumable =
    selectedState === 'paused' ||
    selectedState === 'queued' ||
    selectedState === 'failed' ||
    selectedState === 'cancelled';

  return (
    <div id="tool">
      <button className="tb" data-a="add" onClick={onAdd} title="Add URL">
        <img src="/icons/toolbar/add-url.svg" alt="Add" width={24} height={24} />
        Add URL
      </button>

      <button
        className="tb"
        data-a="resume"
        onClick={onResume}
        disabled={!hasSelection || !isSelectedResumable}
        title="Resume"
      >
        <img src="/icons/toolbar/resume.svg" alt="Resume" width={24} height={24} />
        Resume
      </button>

      <button
        className="tb"
        data-a="pause"
        onClick={onPause}
        disabled={!hasSelection || !isSelectedActive}
        title="Pause"
      >
        <img src="/icons/toolbar/pause.svg" alt="Pause" width={24} height={24} />
        Pause
      </button>

      <button className="tb" data-a="stopall" onClick={onStopAll} title="Stop all">
        <img src="/icons/toolbar/stop-all.svg" alt="Stop all" width={24} height={24} />
        Stop all
      </button>

      <button
        className="tb"
        data-a="del"
        onClick={onDelete}
        disabled={!hasSelection}
        title="Delete"
      >
        <img src="/icons/toolbar/delete.svg" alt="Delete" width={24} height={24} />
        Delete
      </button>

      <span className="vs" />

      <button className="tb" data-a="queue" onClick={onStartQueue} title="Start queue">
        <img src="/icons/toolbar/start-queue.svg" alt="Queue" width={24} height={24} />
        Start queue
      </button>

      <span className="vs" />

      <button className="tb" data-a="settings" onClick={onOpenSettings} title="Settings">
        <img src="/icons/toolbar/settings.svg" alt="Settings" width={24} height={24} />
        Settings
      </button>

      <input
        className="in"
        id="q"
        type="text"
        placeholder="Search"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </div>
  );
};

