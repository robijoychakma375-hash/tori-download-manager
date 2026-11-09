import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChunkRecord, DownloadJob } from '../types';
import { fmtB, fmtSp, fmtT, stateLabel, formatScheduledTime } from '../utils';

interface DetailsPaneProps {
  selectedJob: DownloadJob | null;
  visible: boolean;
}

export const DetailsPane: React.FC<DetailsPaneProps> = ({ selectedJob, visible }) => {
  const [chunks, setChunks] = useState<ChunkRecord[]>([]);

  useEffect(() => {
    if (!selectedJob) {
      setChunks([]);
      return;
    }

    let isMounted = true;
    const fetchChunks = async () => {
      try {
        const result = await invoke<ChunkRecord[]>('get_download_chunks', {
          id: selectedJob.id,
        });
        if (isMounted) {
          setChunks(result || []);
        }
      } catch {
        if (isMounted) {
          setChunks([]);
        }
      }
    };

    fetchChunks();
    // Refresh chunk progress periodically while downloading
    let interval: ReturnType<typeof setInterval> | null = null;
    if (selectedJob.state === 'downloading') {
      interval = setInterval(fetchChunks, 800);
    }

    return () => {
      isMounted = false;
      if (interval) clearInterval(interval);
    };
  }, [selectedJob?.id, selectedJob?.state]);

  if (!visible || !selectedJob) {
    return null;
  }

  const total = selectedJob.total_bytes || 0;
  const downloaded = selectedJob.downloaded_bytes || 0;
  const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : selectedJob.state === 'completed' ? 100 : 0;
  const isDownloading = selectedJob.state === 'downloading';

  // Prepare segment display
  const segmentCount = chunks.length > 0 ? chunks.length : Math.max(1, selectedJob.chunk_count || 1);
  const segments =
    chunks.length > 0
      ? chunks.map((c) => {
          const chunkLen = Math.max(1, c.end_byte - c.start_byte + 1);
          const chunkPct = c.is_complete ? 100 : Math.min(100, (c.written_bytes / chunkLen) * 100);
          return chunkPct;
        })
      : Array.from({ length: segmentCount }).map(() =>
          selectedJob.state === 'completed' ? 100 : percent
        );

  return (
    <div id="det">
      <div
        className="a"
        style={{
          left: 14,
          top: 6,
          right: 14,
          fontSize: 12,
          display: 'flex',
          gap: 18,
          alignItems: 'center',
        }}
      >
        <b
          style={{
            maxWidth: 380,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={selectedJob.filename}
        >
          {selectedJob.filename}
        </b>
        <span className="mut">
          {fmtB(downloaded)} of {fmtB(total)} ({percent.toFixed(2)} %)
        </span>
        <span className="mut">
          {isDownloading
            ? `${fmtSp(selectedJob.speed_bps)}   ${fmtT(selectedJob.eta_seconds)} left`
            : selectedJob.state === 'scheduled'
            ? `Scheduled for ${formatScheduledTime(selectedJob.scheduled_at)}`
            : stateLabel(selectedJob.state)}
        </span>
      </div>

      <div className="a bar2" style={{ left: 14, top: 28, right: 14 }}>
        <b style={{ width: `${percent}%` }} />
      </div>

      <div className="a segs" id="dsegs" style={{ left: 14, top: 50, right: 14 }}>
        {segments.map((segPct, idx) => (
          <div key={idx} className="seg">
            <b style={{ width: `${segPct}%` }} />
          </div>
        ))}
      </div>

      <div className="a mut" style={{ right: 14, top: 63, fontSize: '10.5px' }}>
        Segments : {segmentCount}
      </div>
    </div>
  );
};
