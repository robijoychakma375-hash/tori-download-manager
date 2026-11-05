import React, { useEffect, useRef } from 'react';
import type { DownloadJob } from '../types';

interface ContextMenuProps {
  x: number;
  y: number;
  job: DownloadJob;
  selectedJobs: DownloadJob[];
  onClose: () => void;
  onOpenProgress: (job: DownloadJob) => void;
  onTogglePause: (job: DownloadJob) => void;
  onBulkTogglePause: (jobs: DownloadJob[]) => void;
  onOpenFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCopyUrl: (url: string) => void;
  onRetry: (job: DownloadJob) => void;
  onVerifyChecksum: (path: string) => void;
  onDelete: (jobs: DownloadJob[]) => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  job,
  selectedJobs,
  onClose,
  onOpenProgress,
  onTogglePause,
  onBulkTogglePause,
  onOpenFolder,
  onOpenFile,
  onCopyUrl,
  onRetry,
  onVerifyChecksum,
  onDelete,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [onClose]);

  const isMulti = selectedJobs.length > 1;
  const isComplete = job.state === 'completed';
  const isDownloading = job.state === 'downloading';

  const anyActive = selectedJobs.some(
    (j) => j.state === 'downloading' || j.state === 'probing'
  );

  // Ensure menu doesn't overflow window viewport
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - 260);

  if (isMulti) {
    return (
      <div id="ctx" ref={menuRef} style={{ left, top, display: 'block' }}>
        <div
          onClick={() => {
            onBulkTogglePause(selectedJobs);
            onClose();
          }}
        >
          {anyActive ? `Pause Selected (${selectedJobs.length})` : `Resume Selected (${selectedJobs.length})`}
        </div>

        <div
          onClick={() => {
            onOpenFolder(job.target_path);
            onClose();
          }}
        >
          Open folder
        </div>

        <hr />

        <div
          style={{ color: 'var(--bad)' }}
          onClick={() => {
            onDelete(selectedJobs);
            onClose();
          }}
        >
          Delete ({selectedJobs.length} items)
        </div>
      </div>
    );
  }

  return (
    <div id="ctx" ref={menuRef} style={{ left, top, display: 'block' }}>
      <div
        onClick={() => {
          onOpenProgress(job);
          onClose();
        }}
      >
        Show progress window
      </div>

      <div
        onClick={() => {
          if (isComplete) {
            onOpenFile(job.target_path);
          } else {
            onTogglePause(job);
          }
          onClose();
        }}
      >
        {isComplete ? 'Open file' : isDownloading ? 'Pause' : 'Resume'}
      </div>

      <div
        onClick={() => {
          onOpenFolder(job.target_path);
          onClose();
        }}
      >
        Open folder
      </div>

      <div
        onClick={() => {
          onCopyUrl(job.url);
          onClose();
        }}
      >
        Copy address
      </div>

      <div
        onClick={() => {
          onRetry(job);
          onClose();
        }}
      >
        Redownload
      </div>

      <hr />

      <div
        onClick={() => {
          onVerifyChecksum(job.target_path);
          onClose();
        }}
      >
        Verify checksum (SHA-256)
      </div>

      <hr />

      <div
        style={{ color: 'var(--bad)' }}
        onClick={() => {
          onDelete([job]);
          onClose();
        }}
      >
        Delete
      </div>
    </div>
  );
};

