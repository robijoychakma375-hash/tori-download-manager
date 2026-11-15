import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DownloadJob, SortDirection, SortField } from '../types';
import {
  fmtB,
  fmtSp,
  fmtT,
  formatAdded,
  formatScheduledTime,
  stateLabel,
  typeOfJob,
} from '../utils';
import { CategoryChip } from './Icons';

const ROW_HEIGHT = 34;
const OVERSCAN = 5;

interface DownloadTableProps {
  downloads: DownloadJob[];
  selectedIds: Set<string>;
  focusedId: string | null;
  sortField: SortField | null;
  sortDir: SortDirection;
  onSortChange: (field: SortField) => void;
  onSelect: (e: React.MouseEvent, id: string) => void;
  onOpenProgress: (job: DownloadJob) => void;
  onContextMenu: (e: React.MouseEvent, job: DownloadJob) => void;
  onBackgroundClick?: (e: React.MouseEvent) => void;
}

interface TableRowProps {
  job: DownloadJob;
  rowIndex: number;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent, id: string) => void;
  onOpenProgress: (job: DownloadJob) => void;
  onContextMenu: (e: React.MouseEvent, job: DownloadJob) => void;
}

const RowThumb: React.FC<{ job: DownloadJob; category: string }> = React.memo(
  ({ job, category }) => {
    const [imgFailed, setImgFailed] = useState(false);

    if (job.thumbnail_url && !imgFailed) {
      return (
        <img
          src={job.thumbnail_url}
          alt=""
          width={24}
          height={24}
          loading="lazy"
          className="thumb-img"
          onError={() => setImgFailed(true)}
        />
      );
    }

    return <CategoryChip category={category} size={24} />;
  }
);
RowThumb.displayName = 'RowThumb';

const TableRow = React.memo<TableRowProps>(
  ({ job, rowIndex, isSelected, onSelect, onOpenProgress, onContextMenu }) => {
    const category = typeOfJob(job);
    const total = job.total_bytes || 0;
    const downloaded = job.downloaded_bytes || 0;
    const isComplete = job.state === 'completed';
    const isScheduled = job.state === 'scheduled';
    const isPaused =
      job.state === 'paused' ||
      job.state === 'queued' ||
      job.state === 'failed' ||
      job.state === 'cancelled' ||
      isScheduled;
    const isDownloading = job.state === 'downloading';
    const hasKnownTotal = total > 0;
    const isFinishing = isDownloading && hasKnownTotal && downloaded >= total;

    const percent = isComplete
      ? 100
      : hasKnownTotal
        ? Math.min(100, Math.max(0, (downloaded / total) * 100))
        : 0;

    return (
      <div
        className={`tr ${isSelected ? 'sel' : ''} ${rowIndex % 2 === 1 ? 'odd' : ''}`}
        data-id={job.id}
        data-idx={rowIndex}
        role="row"
        aria-selected={isSelected}
        onClick={(e) => onSelect(e, job.id)}
        onDoubleClick={() => onOpenProgress(job)}
        onContextMenu={(e) => onContextMenu(e, job)}
      >
        <span className="nm" title={job.filename}>
          <RowThumb job={job} category={category} />
          <em>{job.filename}</em>
        </span>

        <span className="mut">
          {job.total_bytes != null || downloaded > 0
            ? fmtB(job.total_bytes ?? downloaded)
            : 'Unknown'}
        </span>

        <span
          className="pb"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(e, job.id);
            onOpenProgress(job);
          }}
          title="Click to inspect transfer progress"
        >
          <i className={isPaused ? 'pz' : isComplete ? 'dn' : ''}>
            <b style={{ width: `${percent}%` }} />
          </i>
          <span>{isComplete ? '100%' : isFinishing ? 'Finishing…' : `${Math.floor(percent)}%`}</span>
        </span>

        <span className="mut">
          {isComplete
            ? ''
            : isFinishing
              ? 'Finishing…'
              : isDownloading
                ? fmtT(job.eta_seconds)
                : isScheduled
                  ? `⏰ ${formatScheduledTime(job.scheduled_at)}`
                  : stateLabel(job.state)}
        </span>

        <span className="mut">
          {isDownloading && !isFinishing ? fmtSp(job.speed_bps) : ''}
        </span>

        <span className="mut">{formatAdded(job.updated_at || job.created_at)}</span>
      </div>
    );
  }
);
TableRow.displayName = 'TableRow';

const COLUMNS: { field: SortField; label: string }[] = [
  { field: 'filename', label: 'File name' },
  { field: 'size', label: 'Size' },
  { field: 'status', label: 'Status' },
  { field: 'eta', label: 'Time left' },
  { field: 'speed', label: 'Transfer rate' },
  { field: 'date', label: 'Last try date' },
];

export const DownloadTable: React.FC<DownloadTableProps> = ({
  downloads,
  selectedIds,
  focusedId,
  sortField,
  sortDir,
  onSortChange,
  onSelect,
  onOpenProgress,
  onContextMenu,
  onBackgroundClick,
}) => {
  const rowsRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);

  useEffect(() => {
    const el = rowsRef.current;
    if (!el) return;

    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) setViewportHeight(h);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const handleScroll = useCallback(() => {
    const el = rowsRef.current;
    if (!el) return;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (rowsRef.current) {
        setScrollTop(rowsRef.current.scrollTop);
      }
    });
  }, []);

  // Scroll focused item into view on keyboard navigation
  useEffect(() => {
    if (!focusedId || !rowsRef.current) return;
    const idx = downloads.findIndex((d) => d.id === focusedId);
    if (idx < 0) return;
    const el = rowsRef.current;
    const itemTop = idx * ROW_HEIGHT;
    const itemBottom = itemTop + ROW_HEIGHT;
    if (itemTop < el.scrollTop) {
      el.scrollTop = itemTop;
      setScrollTop(itemTop);
    } else if (itemBottom > el.scrollTop + el.clientHeight) {
      const nextScroll = Math.max(0, itemBottom - el.clientHeight);
      el.scrollTop = nextScroll;
      setScrollTop(nextScroll);
    }
  }, [focusedId, downloads]);

  const { startIndex, endIndex, topPad, bottomPad } = useMemo(() => {
    const total = downloads.length;
    if (total === 0) {
      return { startIndex: 0, endIndex: 0, topPad: 0, bottomPad: 0 };
    }
    const maxScroll = Math.max(0, total * ROW_HEIGHT - viewportHeight);
    const clampedScroll = Math.min(scrollTop, maxScroll);
    const firstVisible = Math.floor(clampedScroll / ROW_HEIGHT);
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);
    const start = Math.max(0, firstVisible - OVERSCAN);
    const end = Math.min(total, firstVisible + visibleCount + OVERSCAN);
    return {
      startIndex: start,
      endIndex: end,
      topPad: start * ROW_HEIGHT,
      bottomPad: Math.max(0, (total - end) * ROW_HEIGHT),
    };
  }, [downloads.length, scrollTop, viewportHeight]);

  const visibleSlice = useMemo(
    () => downloads.slice(startIndex, endIndex),
    [downloads, startIndex, endIndex]
  );

  return (
    <div id="right" onClick={onBackgroundClick}>
      <div className="th" role="row">
        {COLUMNS.map((col) => {
          const isSorted = sortField === col.field;
          return (
            <button
              key={col.field}
              type="button"
              className={`th-btn ${isSorted ? 'sorted' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onSortChange(col.field);
              }}
              title={`Sort by ${col.label}`}
            >
              <span>{col.label}</span>
              {isSorted && <span className="sort-ind">{sortDir === 'asc' ? '▲' : '▼'}</span>}
            </button>
          );
        })}
      </div>

      <div id="rows" ref={rowsRef} onScroll={handleScroll} onClick={onBackgroundClick} role="rowgroup">
        {downloads.length === 0 ? (
          <div id="empty">
            <b>No downloads here</b>
            <br />
            Press Add URL, or use the browser extension.
          </div>
        ) : (
          <div
            className="vrows"
            style={{
              paddingTop: topPad,
              paddingBottom: bottomPad,
            }}
          >
            {visibleSlice.map((job, offset) => (
              <TableRow
                key={job.id}
                job={job}
                rowIndex={startIndex + offset}
                isSelected={selectedIds.has(job.id)}
                onSelect={onSelect}
                onOpenProgress={onOpenProgress}
                onContextMenu={onContextMenu}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
