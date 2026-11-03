import React from 'react';
import type { DownloadJob } from '../types';
import { typeOfJob, getChipSrc, fmtB, fmtSp, fmtT, formatAdded, stateLabel } from '../utils';

interface DownloadTableProps {
  downloads: DownloadJob[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenProgress: (job: DownloadJob) => void;
  onContextMenu: (e: React.MouseEvent, job: DownloadJob) => void;
}

export const DownloadTable: React.FC<DownloadTableProps> = ({
  downloads,
  selectedId,
  onSelect,
  onOpenProgress,
  onContextMenu,
}) => {
  return (
    <div id="right">
      <div className="th">
        <span>File name</span>
        <span>Size</span>
        <span>Status</span>
        <span>Time left</span>
        <span>Speed</span>
        <span>Added</span>
      </div>

      <div id="rows">
        {downloads.length === 0 ? (
          <div id="empty">
            <b>No downloads here</b>
            <br />
            Press Add URL, or use the browser extension.
          </div>
        ) : (
          downloads.map((job) => {
            const isSelected = selectedId === job.id;
            const category = typeOfJob(job);
            const total = job.total_bytes || 0;
            const downloaded = job.downloaded_bytes || 0;
            const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : job.state === 'completed' ? 100 : 0;
            const isComplete = job.state === 'completed';
            const isPaused = job.state === 'paused' || job.state === 'queued' || job.state === 'failed';
            const isDownloading = job.state === 'downloading';

            return (
              <div
                key={job.id}
                className={`tr ${isSelected ? 'sel' : ''}`}
                onClick={() => onSelect(job.id)}
                onDoubleClick={() => onOpenProgress(job)}
                onContextMenu={(e) => onContextMenu(e, job)}
              >
                <span className="nm">
                  <img
                    src={getChipSrc(category)}
                    alt={category}
                    width={20}
                    height={20}
                    style={{ borderRadius: '6px', flexShrink: 0 }}
                  />
                  <em>{job.filename}</em>
                </span>

                <span className="mut">{fmtB(job.total_bytes ?? job.downloaded_bytes)}</span>

                <span
                  className="pb"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(job.id);
                    onOpenProgress(job);
                  }}
                  title="Click to view details"
                >
                  <i className={isPaused ? 'pz' : isComplete ? 'dn' : ''}>
                    <b style={{ width: `${percent}%` }} />
                  </i>
                  <span>{isComplete ? '100%' : `${Math.floor(percent)}%`}</span>
                </span>

                <span className="mut">
                  {isDownloading
                    ? fmtT(job.eta_seconds)
                    : isComplete
                    ? ''
                    : stateLabel(job.state)}
                </span>

                <span className="mut">
                  {isDownloading ? fmtSp(job.speed_bps) : ''}
                </span>

                <span className="mut">{formatAdded(job.created_at)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

