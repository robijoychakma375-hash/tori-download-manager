import React, { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DownloadEvent, DownloadJob, ChunkRecord } from '../types';
import { typeOfJob, fmtB, fmtSp } from '../utils';
import './DownloadToast.css';

const CIRCUMFERENCE = 2 * Math.PI * 21; // ~131.95

interface DownloadToastProps {
  initialId?: string;
}

// Category chip definitions matching design/tori-final/icons/chips/
const CATEGORY_CHIPS: Record<
  string,
  { grad: [string, string]; path: string }
> = {
  Programs: {
    grad: ['#0a84ff', '#075aad'],
    path: 'M8 8l-4 4 4 4M16 8l4 4-4 4',
  },
  Video: {
    grad: ['#ff453a', '#ad2f27'],
    path: 'M9 6.5v11l9-5.5z',
  },
  Music: {
    grad: ['#ff375f', '#ad2541'],
    path: 'M9 18V6l10-2v12M7 20a2 2 0 100-4 2 2 0 000 4zM17 18a2 2 0 100-4 2 2 0 000 4z',
  },
  Compressed: {
    grad: ['#bf5af2', '#823da5'],
    path: 'M12 3v10M10 6h4M10 9h4M8 13h8v6H8z',
  },
  Documents: {
    grad: ['#32ade6', '#22769c'],
    path: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  },
  Other: {
    grad: ['#8e8e93', '#616164'],
    path: 'M7 3h7l5 5v13H7z',
  },
};

function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '--';
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  }
  return `${Math.round(seconds)}s`;
}

export const DownloadToast: React.FC<DownloadToastProps> = ({ initialId }) => {
  const [activeIds, setActiveIds] = useState<string[]>(() => (initialId ? [initialId] : []));
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const [chunks, setChunks] = useState<Record<string, ChunkRecord[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const hoveredRef = useRef<Record<string, boolean>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  // Apply theme & accent from stored settings
  useEffect(() => {
    document.documentElement.classList.add('toast-mode');
    try {
      const stored = localStorage.getItem('tori_settings_v2') || localStorage.getItem('tori_settings');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.theme) {
          if (parsed.theme === 'system') {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
          } else {
            document.documentElement.dataset.theme = parsed.theme;
          }
        }
        if (parsed.accent) {
          document.documentElement.dataset.accent = parsed.accent;
        }
      }
    } catch {
      // fallback default
    }
  }, []);

  // Fetch job helper
  const fetchJob = useCallback(async (id: string) => {
    try {
      const job = await invoke<DownloadJob | null>('get_download', { id });
      if (job) {
        setJobs((prev) => ({ ...prev, [id]: job }));
        const c = await invoke<ChunkRecord[]>('get_download_chunks', { id }).catch(() => []);
        if (c && c.length > 0) {
          setChunks((prev) => ({ ...prev, [id]: c }));
        }
      }
    } catch (err) {
      console.warn(`Failed to fetch job ${id}:`, err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') {
      const st = params.get('state') || 'down';
      const isOpen = params.get('open') === '1' || st === 'expanded';
      const demoState = st === 'expanded' ? 'down' : st;
      const jobState =
        demoState === 'paused'
          ? 'paused'
          : demoState === 'done'
          ? 'completed'
          : demoState === 'failed'
          ? 'failed'
          : 'downloading';

      const F0 = [1, 1, 0.78, 1, 0.9, 1, 0.62, 1, 0.96, 0.7, 1];
      const demoChunks: ChunkRecord[] = F0.map((ratio, i) => ({
        id: i,
        download_id: 'demo-toast',
        chunk_index: i,
        start_byte: i * 5025727,
        end_byte: (i + 1) * 5025727 - 1,
        written_bytes: Math.round(5025727 * (jobState === 'completed' ? 1 : ratio)),
        is_complete: jobState === 'completed' || ratio >= 1,
      }));

      const demoJob: DownloadJob = {
        id: 'demo-toast',
        url: 'https://download-installer.cdn.mozilla.net/pub/firefox/releases/61.0.2/mac/en-US/Firefox%2061.0.2.dmg',
        resolved_url: null,
        filename: 'Firefox 61.0.2.dmg',
        target_path: 'C:\\Users\\ritud\\Downloads\\Tori\\Programs',
        temp_path: 'C:\\Users\\ritud\\Downloads\\Tori\\Programs\\Firefox 61.0.2.dmg.tdm-part',
        total_bytes: 57968590,
        downloaded_bytes: jobState === 'completed' ? 57968590 : 51227000,
        state: jobState,
        job_type: 'http_file',
        etag: null,
        last_modified: null,
        is_resumable: true,
        chunk_count: 11,
        priority: 'normal',
        error_message: jobState === 'failed' ? 'Connection lost · 3 retries failed' : null,
        created_at: 'Today 10:42',
        updated_at: 'Today 10:42',
        speed_bps: 512000,
        eta_seconds: 3,
      };

      setActiveIds(['demo-toast']);
      setJobs({ 'demo-toast': demoJob });
      setChunks({ 'demo-toast': demoChunks });
      if (isOpen) {
        setExpanded({ 'demo-toast': true });
      }
    } else if (initialId) {
      fetchJob(initialId);
    }
  }, [initialId, fetchJob]);

  // Listen to Tauri events
  useEffect(() => {
    const unlistenProgress = listen<DownloadEvent>('download-event', (event) => {
      const payload = event.payload;
      if (payload.type === 'Progress') {
        const prog = payload.payload;
        setJobs((prev) => {
          const existing = prev[prog.id];
          if (!existing) return prev;
          return {
            ...prev,
            [prog.id]: {
              ...existing,
              downloaded_bytes: prog.downloaded_bytes,
              total_bytes: prog.total_bytes ?? existing.total_bytes,
              speed_bps: prog.speed_bps,
              eta_seconds: prog.eta_seconds,
              state: prog.state,
            },
          };
        });
      } else if (payload.type === 'StateChanged') {
        const { id, state } = payload.payload;
        setJobs((prev) => {
          const existing = prev[id];
          if (!existing) return prev;
          return {
            ...prev,
            [id]: { ...existing, state },
          };
        });
      } else if (payload.type === 'OpenProgressWindow') {
        const { id } = payload.payload;
        setActiveIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        fetchJob(id);
      }
    });

    const unlistenAdd = listen<string>('toast-add-download', (event) => {
      const id = event.payload;
      if (id) {
        setActiveIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        fetchJob(id);
      }
    });

    return () => {
      unlistenProgress.then((u) => u());
      unlistenAdd.then((u) => u());
    };
  }, [fetchJob]);

  // Auto-dismiss countdown timer for completed items
  useEffect(() => {
    const timer = setInterval(() => {
      activeIds.forEach((id) => {
        const job = jobs[id];
        if (!job) return;

        // Auto-dismiss completed jobs after 9 seconds if not hovered
        if (job.state === 'completed' && !hoveredRef.current[id]) {
          const elapsed = (Date.now() - new Date(job.updated_at).getTime()) / 1000;
          if (elapsed >= 9) {
            handleDismiss(id);
          }
        }
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [activeIds, jobs]);

  // Adjust window bounds whenever container size changes
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.ceil(entry.contentRect.height) + 18;
        invoke('update_toast_bounds', { width: 490.0, height: Math.max(94.0, h) }).catch(
          () => {}
        );
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleDismiss = useCallback(
    async (id: string) => {
      const next = activeIds.filter((x) => x !== id);
      setActiveIds(next);
      if (next.length === 0) {
        try {
          await invoke('hide_toast_window');
        } catch {
          // ignore
        }
      }
    },
    [activeIds]
  );

  const handleTogglePause = async (job: DownloadJob) => {
    try {
      if (job.state === 'downloading' || job.state === 'probing') {
        await invoke('pause_download', { id: job.id });
      } else {
        await invoke('resume_download', { id: job.id });
      }
    } catch (err) {
      console.error('Failed to toggle pause:', err);
    }
  };

  const handleOpenFile = async (path: string) => {
    try {
      await invoke('open_file', { path });
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  const handleOpenFolder = async (path: string) => {
    try {
      await invoke('open_folder', { path });
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  };

  const handleToggleExpand = async (id: string) => {
    setExpanded((prev) => {
      const willOpen = !prev[id];
      if (willOpen && (!chunks[id] || chunks[id].length === 0)) {
        invoke<ChunkRecord[]>('get_download_chunks', { id })
          .then((c) => {
            if (c && c.length > 0) {
              setChunks((ch) => ({ ...ch, [id]: c }));
            }
          })
          .catch(() => {});
      }
      return { ...prev, [id]: willOpen };
    });
  };

  const visibleIds = activeIds.slice(0, 3);
  const remainingCount = Math.max(0, activeIds.length - 3);

  return (
    <div className="toast-host-container" ref={containerRef}>
      {visibleIds.map((id) => {
        const job = jobs[id];
        if (!job) return null;

        const isComplete = job.state === 'completed';
        const isFailed = job.state === 'failed';
        const isPaused = job.state === 'paused';
        const isDown = !isComplete && !isFailed && !isPaused;

        // Ring color variable
        const ringColor = isComplete
          ? 'var(--green)'
          : isFailed
          ? 'var(--bad)'
          : isPaused
          ? 'var(--amber)'
          : 'var(--a3)';

        // Percent calculation
        const total = job.total_bytes || 0;
        const downloaded = job.downloaded_bytes || 0;
        const pct = total > 0 ? Math.min(100, Math.max(0, (downloaded / total) * 100)) : 0;
        const offset = isComplete ? 0 : CIRCUMFERENCE * (1 - pct / 100);

        // Subtext line
        const subtext = isComplete
          ? `${fmtB(total || downloaded)} · Download complete`
          : isFailed
          ? job.error_message || 'Connection lost · 3 retries failed'
          : isPaused
          ? `${fmtB(downloaded)}${total > 0 ? ` of ${fmtB(total)}` : ''} · Paused`
          : `${fmtB(downloaded)}${total > 0 ? ` of ${fmtB(total)}` : ''} · ${fmtSp(
              job.speed_bps || 0
            )}`;

        // ETA display
        let etaNum = '--';
        let etaSub = 'left';
        if (isComplete) {
          etaNum = 'Done';
          etaSub = 'Finished';
        } else if (isFailed) {
          etaNum = 'Failed';
          etaSub = `${Math.floor(pct)}%`;
        } else if (isPaused) {
          etaNum = 'Paused';
          etaSub = `${Math.floor(pct)}%`;
        } else {
          etaNum = formatEta(job.eta_seconds);
          etaSub = 'left';
        }

        // Category icon
        const catName = typeOfJob(job);
        const chip = CATEGORY_CHIPS[catName] || CATEGORY_CHIPS.Other;

        // Hostname parsing
        let host = 'download';
        try {
          host = new URL(job.url).hostname;
        } catch {
          host = job.url.split('/')[2] || 'source';
        }

        // Chunks meter
        const jobChunks = chunks[id] || [];
        const isResumable = job.is_resumable;
        const connCount = jobChunks.length > 0 ? jobChunks.length : 1;

        const isOpen = !!expanded[id];

        return (
          <div
            key={id}
            className={`toast ${isOpen ? 'open' : ''}`}
            style={{ ['--rc' as any]: ringColor }}
            onMouseEnter={() => {
              hoveredRef.current[id] = true;
            }}
            onMouseLeave={() => {
              hoveredRef.current[id] = false;
            }}
          >
            <div className="row">
              <div className="rg">
                <svg className="r" viewBox="0 0 52 52">
                  <circle className="rt" cx="26" cy="26" r="21" />
                  <circle
                    className="rp"
                    cx="26"
                    cy="26"
                    r="21"
                    strokeDasharray={CIRCUMFERENCE.toFixed(1)}
                    strokeDashoffset={offset.toFixed(1)}
                  />
                </svg>
                <span
                  className="chip"
                  style={{
                    background: `linear-gradient(${chip.grad[0]}, ${chip.grad[1]})`,
                  }}
                >
                  <svg viewBox="0 0 24 24">
                    <path d={chip.path} />
                  </svg>
                </span>
                {isComplete && (
                  <span className="bd">
                    <svg viewBox="0 0 24 24">
                      <path d="M5 12l5 5 9-10" />
                    </svg>
                  </span>
                )}
                {isFailed && (
                  <span className="bd">
                    <svg viewBox="0 0 24 24">
                      <path d="M12 6v8M12 18h.01" />
                    </svg>
                  </span>
                )}
              </div>

              <div className="tx" onClick={() => handleToggleExpand(id)} title="Click for details">
                <b>{job.filename}</b>
                <span>{subtext}</span>
              </div>

              <div className="eta" onClick={() => handleToggleExpand(id)} title="Click for details">
                <b>{etaNum}</b>
                <span>{etaSub}</span>
              </div>

              {isDown && (
                <button
                  className="ib"
                  title="Pause"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTogglePause(job);
                  }}
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M9 5v14M15 5v14" />
                  </svg>
                </button>
              )}

              {isPaused && (
                <button
                  className="ib pr"
                  title="Resume"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTogglePause(job);
                  }}
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M7 4v16l13-8z" />
                  </svg>
                </button>
              )}

              {isComplete && (
                <>
                  <button
                    className="ib pr"
                    title="Open"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenFile(job.target_path);
                    }}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />
                    </svg>
                  </button>
                  <button
                    className="ib"
                    title="Show in folder"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenFolder(job.target_path);
                    }}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                    </svg>
                  </button>
                </>
              )}

              {isFailed && (
                <button
                  className="ib pr"
                  title="Retry"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTogglePause(job);
                  }}
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M20 12a8 8 0 11-2.6-5.9M20 4v5h-5" />
                  </svg>
                </button>
              )}

              <button
                className="cx"
                title="Dismiss"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDismiss(id);
                }}
              >
                <svg viewBox="0 0 10 10">
                  <path d="M0 0l10 10M10 0L0 10" />
                </svg>
              </button>
            </div>

            {isOpen && (
              <div className="dr">
                <div className="ms">
                  {jobChunks.length > 0 ? (
                    jobChunks.map((chunk, idx) => {
                      const totalChunk = chunk.end_byte - chunk.start_byte + 1;
                      const ratio =
                        totalChunk > 0
                          ? Math.min(1, Math.max(0, chunk.written_bytes / totalChunk))
                          : 0;
                      return (
                        <i key={idx}>
                          <b style={{ width: `${(isComplete ? 1 : ratio) * 100}%` }} />
                        </i>
                      );
                    })
                  ) : (
                    <i>
                      <b style={{ width: `${(isComplete ? 1 : pct / 100) * 100}%` }} />
                    </i>
                  )}
                </div>
                <div className="l">
                  <span>Source</span>
                  <b>{host}</b>
                </div>
                <div className="l">
                  <span>Save to</span>
                  <b>{job.target_path}</b>
                </div>
                <div className="l">
                  <span>Connections</span>
                  <b>
                    {connCount} · {isResumable ? 'resumable' : 'non-resumable'}
                  </b>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {remainingCount > 0 && (
        <div className="toast-more">+{remainingCount} more active download(s)</div>
      )}
    </div>
  );
};
