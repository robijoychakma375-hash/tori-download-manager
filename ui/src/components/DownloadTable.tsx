import React from 'react';
import type { DownloadJob } from '../types';
import { typeOfJob, getChipSrc, fmtB, fmtSp, fmtT, formatAdded, stateLabel } from '../utils';

interface DownloadTableProps {
  downloads: DownloadJob[];
  selectedIds: Set<string>;
  onSelect: (e: React.MouseEvent, id: string) => void;
  onOpenProgress: (job: DownloadJob) => void;
  onContextMenu: (e: React.MouseEvent, job: DownloadJob) => void;
  onBackgroundClick?: (e: React.MouseEvent) => void;
}

interface TableRowProps {
  job: DownloadJob;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent, id: string) => void;
  onOpenProgress: (job: DownloadJob) => void;
  onContextMenu: (e: React.MouseEvent, job: DownloadJob) => void;
}

const TableRow = React.memo<TableRowProps>(
  ({ job, isSelected, onSelect, onOpenProgress, onContextMenu }) => {
    const category = typeOfJob(job);
    const total = job.total_bytes || 0;
    const downloaded = job.downloaded_bytes || 0;
    const percent =
      total > 0
        ? Math.min(100, (downloaded / total) * 100)
        : job.state === 'completed'
        ? 100
        : 0;
    const isComplete = job.state === 'completed';
    const isPaused =
      job.state === 'paused' || job.state === 'queued' || job.state === 'failed';
    const isDownloading = job.state === 'downloading';

    return (
      <div
        className={`tr ${isSelected ? 'sel' : ''}`}
        onClick={(e) => onSelect(e, job.id)}
        onDoubleClick={() => onOpenProgress(job)}
        onContextMenu={(e) => onContextMenu(e, job)}
      >
        <span className="nm">
          {job.thumbnail_url ? (
            <img
              src={job.thumbnail_url}
              alt=""
              width={24}
              height={24}
              style={{
                width: '24px',
                height: '24px',
                borderRadius: '6px',
                flexShrink: 0,
                objectFit: 'cover',
              }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = getChipSrc(category);
              }}
            />
          ) : (
            <img
              src={getChipSrc(category)}
              alt={category}
              width={24}
              height={24}
              style={{ width: '24px', height: '24px', borderRadius: '6px', flexShrink: 0 }}
            />
          )}
          <em>{job.filename}</em>
        </span>

        <span className="mut">{fmtB(job.total_bytes ?? job.downloaded_bytes)}</span>

        <span
          className="pb"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(e, job.id);
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
  }
);

TableRow.displayName = 'TableRow';

export const DownloadTable: React.FC<DownloadTableProps> = ({
  downloads,
  selectedIds,
  onSelect,
  onOpenProgress,
  onContextMenu,
  onBackgroundClick,
}) => {
  return (
    <div id="right" onClick={onBackgroundClick}>
      <div className="th">
        <span>File name</span>
        <span>Size</span>
        <span>Status</span>
        <span>Time left</span>
        <span>Speed</span>
        <span>Added</span>
      </div>

      <div id="rows" onClick={onBackgroundClick}>
        {downloads.length === 0 ? (
          <div id="empty">
            <b>No downloads here</b>
            <br />
            Press Add URL, or use the browser extension.
          </div>
        ) : (
          downloads.map((job) => (
            <TableRow
              key={job.id}
              job={job}
              isSelected={selectedIds.has(job.id)}
              onSelect={onSelect}
              onOpenProgress={onOpenProgress}
              onContextMenu={onContextMenu}
            />
          ))
        )}
      </div>
    </div>
  );
};
