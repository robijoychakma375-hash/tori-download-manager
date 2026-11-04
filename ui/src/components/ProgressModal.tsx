import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TitleBar } from './TitleBar';
import type { ChunkRecord, DownloadJob } from '../types';
import { fmtB, fmtSp, fmtT, stateLabel } from '../utils';

interface ProgressModalProps {
  job: DownloadJob;
  onClose: () => void;
  onTogglePause: (job: DownloadJob) => void;
  onCancel: (job: DownloadJob) => void;
  onOpenFile: (path: string) => void;
  standalone?: boolean;
}

export const ProgressModal: React.FC<ProgressModalProps> = ({
  job,
  onClose,
  onTogglePause,
  onCancel,
  onOpenFile,
  standalone = false,
}) => {
  const [activeTab, setActiveTab] = useState<'pp1' | 'pp2' | 'pp3'>('pp1');
  const [chunks, setChunks] = useState<ChunkRecord[]>([]);

  useEffect(() => {
    let isMounted = true;
    const fetchChunks = async () => {
      try {
        const result = await invoke<ChunkRecord[]>('get_download_chunks', { id: job.id });
        if (isMounted) {
          setChunks(result || []);
        }
      } catch {
        if (isMounted) setChunks([]);
      }
    };

    fetchChunks();
    let interval: ReturnType<typeof setInterval> | null = null;
    if (job.state === 'downloading') {
      interval = setInterval(fetchChunks, 800);
    }
    return () => {
      isMounted = false;
      if (interval) clearInterval(interval);
    };
  }, [job.id, job.state]);

  const total = job.total_bytes || 0;
  const downloaded = job.downloaded_bytes || 0;
  const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : job.state === 'completed' ? 100 : 0;
  const isComplete = job.state === 'completed';
  const isDownloading = job.state === 'downloading';
  const isPaused = job.state === 'paused' || job.state === 'queued' || job.state === 'failed';

  const segmentCount = chunks.length > 0 ? chunks.length : Math.max(1, job.chunk_count || 1);
  const segments =
    chunks.length > 0
      ? chunks.map((c) => {
          const chunkLen = Math.max(1, c.end_byte - c.start_byte + 1);
          return c.is_complete ? 100 : Math.min(100, (c.written_bytes / chunkLen) * 100);
        })
      : Array.from({ length: segmentCount }).map(() => (isComplete ? 100 : percent));

  return (
    <>
      {!standalone && <div id="dim" onClick={onClose} />}
      <div className={`win pop ${standalone ? 'standalone' : ''}`} id="prog">
        <TitleBar
          title={`${Math.floor(percent)}%  ${job.filename}`}
          onClose={onClose}
          isModal={!standalone}
        />

        <div className="a segtabs" id="ptabs">
          <button
            className={activeTab === 'pp1' ? 'on' : ''}
            onClick={() => setActiveTab('pp1')}
            style={{ width: 114 }}
          >
            Download
          </button>
          <button
            className={activeTab === 'pp2' ? 'on' : ''}
            onClick={() => setActiveTab('pp2')}
            style={{ width: 96 }}
          >
            Options
          </button>
          <button
            className={activeTab === 'pp3' ? 'on' : ''}
            onClick={() => setActiveTab('pp3')}
            style={{ width: 128 }}
          >
            Connections
          </button>
        </div>

        <div className="a" id="ppanel" />

        {activeTab === 'pp1' && (
          <div className="pp on" id="pp1">
            <div className="a" id="purl" title={job.url}>
              {job.url}
            </div>

            <div className="t l" style={{ top: 115 }}>
              Status
            </div>
            <div
              className={`t v ${isComplete ? 'green' : isDownloading ? 'blue' : 'bad'}`}
              id="pst"
              style={{ top: 115 }}
            >
              {stateLabel(job.state)}
            </div>

            <div className="t l" style={{ top: 144 }}>
              File size
            </div>
            <div className="t v" id="pfs" style={{ top: 144 }}>
              {fmtB(job.total_bytes ?? job.downloaded_bytes)}
            </div>

            <div className="t l" style={{ top: 173 }}>
              Downloaded
            </div>
            <div className="t v" id="pdl" style={{ top: 173 }}>
              {fmtB(downloaded)} ( {percent.toFixed(2)} % )
            </div>

            <div className="t l" style={{ top: 202 }}>
              BandWidth
            </div>
            <div className="t v" id="pbw" style={{ top: 202 }}>
              {isDownloading ? fmtSp(job.speed_bps) : '0 KB/sec'}
            </div>

            <div className="t l" style={{ top: 231 }}>
              Time remained
            </div>
            <div className="t v" id="ptr" style={{ top: 231 }}>
              {isComplete ? '0 sec' : isDownloading ? fmtT(job.eta_seconds) : '--'}
            </div>

            <div className="t l" style={{ top: 260 }}>
              Resumable
            </div>
            <div className="t v green" id="prs" style={{ top: 260 }}>
              {job.is_resumable ? 'Yes' : 'No'}
            </div>

            <svg
              className="a"
              style={{ left: 680, top: 165 }}
              width="56"
              height="56"
              viewBox="0 0 56 56"
            >
              <defs>
                <linearGradient id="ig" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#dcdcdc" />
                  <stop offset="1" stopColor="#8d8d8d" />
                </linearGradient>
              </defs>
              <path d="M15 5h21l6 7v15H15z" fill="#f6f6f6" stroke="#9a9a9a" />
              <rect x="5" y="24" width="46" height="23" rx="5" fill="url(#ig)" stroke="#7b7b7b" />
              <rect x="14" y="39" width="28" height="9" rx="2" fill="#f1f1f1" stroke="#9a9a9a" />
              <circle cx="43" cy="31" r="2" fill="#6c6c6c" />
            </svg>
          </div>
        )}

        {activeTab === 'pp2' && (
          <div className="pp on" id="pp2">
            <div className="t l" style={{ top: 90 }}>
              Connections
            </div>
            <div className="t v" id="po1" style={{ top: 90 }}>
              {job.chunk_count || 1}
            </div>

            <div className="t l" style={{ top: 125 }}>
              Save to
            </div>
            <div className="t v" id="po2" style={{ top: 125 }} title={job.target_path}>
              {job.target_path}
            </div>

            <div className="t l" style={{ top: 160 }}>
              Priority
            </div>
            <div className="t v" id="po3" style={{ top: 160, textTransform: 'capitalize' }}>
              {job.priority}
            </div>

            <div className="t l" style={{ top: 195 }}>
              Resume support
            </div>
            <div className="t v green" style={{ top: 195 }}>
              {job.is_resumable ? 'Yes' : 'No'}
            </div>
          </div>
        )}

        {activeTab === 'pp3' && (
          <div className="pp on" id="pp3">
            <div className="a" id="pcons">
              <div className="h">
                <span>No.</span>
                <span>Range</span>
                <span>Downloaded</span>
                <span>Status</span>
              </div>
              {chunks.length > 0 ? (
                chunks.map((c, k) => (
                  <div key={k}>
                    <span>{k + 1}</span>
                    <span>
                      {Math.round(c.start_byte / 1024)} - {Math.round(c.end_byte / 1024)} KB
                    </span>
                    <span>{fmtB(c.written_bytes)}</span>
                    <span className={c.is_complete ? 'green' : 'blue'}>
                      {c.is_complete
                        ? 'Complete'
                        : isDownloading
                        ? 'Downloading'
                        : stateLabel(job.state)}
                    </span>
                  </div>
                ))
              ) : (
                <div>
                  <span>1</span>
                  <span>0 - {Math.round(total / 1024)} KB</span>
                  <span>{fmtB(downloaded)}</span>
                  <span>{isComplete ? 'Complete' : stateLabel(job.state)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="a bar2" id="pbar">
          <b id="pfill" style={{ width: `${percent}%` }} />
        </div>

        <div className="a" id="psegl">
          Segments : {segmentCount}
        </div>

        <div className="a segs" id="psegs">
          {segments.map((sPct, idx) => (
            <div key={idx} className="seg">
              <b style={{ width: `${sPct}%` }} />
            </div>
          ))}
        </div>

        <button
          className="btn pbtn"
          id="pb1"
          style={{ left: 242 }}
          onClick={() => {
            if (isComplete) {
              onOpenFile(job.target_path);
            } else {
              onTogglePause(job);
            }
          }}
        >
          {isComplete ? 'Open File' : isPaused ? 'Resume' : 'Pause'}
        </button>

        <button
          className="btn pbtn"
          id="pb2"
          style={{ left: 434 }}
          onClick={() => {
            if (isComplete || isPaused) {
              onClose();
            } else {
              onCancel(job);
            }
          }}
        >
          {isComplete || isPaused ? 'Close' : 'Cancel'}
        </button>
      </div>
    </>
  );
};
