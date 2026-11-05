import React, { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
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
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  }
  return `${Math.round(seconds)}s`;
}

function fmtProgressBytes(downloaded: number, total: number): string {
  if (total <= 0) return fmtB(downloaded);
  if (total >= 1e9 && downloaded >= 1e8) {
    return `${(downloaded / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB`;
  }
  if (total >= 1e6 && downloaded >= 1e5) {
    return `${(downloaded / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`;
  }
  return `${fmtB(downloaded)} of ${fmtB(total)}`;
}

export const DownloadToast: React.FC<DownloadToastProps> = ({ initialId }) => {
  const [activeIds, setActiveIds] = useState<string[]>(() => (initialId ? [initialId] : []));
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const [chunks, setChunks] = useState<Record<string, ChunkRecord[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const hoveredRef = useRef<Record<string, boolean>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const dismissedIdsRef = useRef<Set<string>>(new Set());
  const isUserDraggingRef = useRef<boolean>(false);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const isTextMovedRef = useRef<boolean>(false);
  const lastBoundsRef = useRef<{ w: number; h: number }>({ w: 494, h: 100 });

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

      const isUnknownDemo = params.get('unknown') === '1';
      const demoJob: DownloadJob = {
        id: 'demo-toast',
        url: isUnknownDemo
          ? 'https://live.example.com/hls/stream.m3u8'
          : 'https://download-installer.cdn.mozilla.net/pub/firefox/releases/61.0.2/mac/en-US/Firefox%2061.0.2.dmg',
        resolved_url: null,
        filename: isUnknownDemo ? 'live_event_stream.mp4' : 'Firefox 61.0.2.dmg',
        target_path: isUnknownDemo
          ? 'C:\\Users\\ritud\\Downloads\\Tori\\Video'
          : 'C:\\Users\\ritud\\Downloads\\Tori\\Programs',
        temp_path: isUnknownDemo
          ? 'C:\\Users\\ritud\\Downloads\\Tori\\Video\\live_event_stream.mp4.tdm-part'
          : 'C:\\Users\\ritud\\Downloads\\Tori\\Programs\\Firefox 61.0.2.dmg.tdm-part',
        total_bytes: isUnknownDemo ? null : 57968590,
        downloaded_bytes: isUnknownDemo
          ? 48900000
          : jobState === 'completed'
          ? 57968590
          : 51227000,
        state: jobState,
        job_type: isUnknownDemo ? 'live_stream' : 'http_file',
        etag: null,
        last_modified: null,
        is_resumable: !isUnknownDemo,
        chunk_count: isUnknownDemo ? 1 : 11,
        priority: 'normal',
        error_message: jobState === 'failed' ? 'Connection lost · 3 retries failed' : null,
        created_at: 'Today 10:42',
        updated_at: 'Today 10:42',
        speed_bps: 512000,
        eta_seconds: isUnknownDemo ? null : 3,
      };

      setActiveIds(['demo-toast']);
      setJobs({ 'demo-toast': demoJob });
      setChunks({ 'demo-toast': demoChunks });
      if (isOpen) {
        setExpanded({ 'demo-toast': true });
      }
    } else {
      if (initialId) {
        fetchJob(initialId);
      }
      invoke<DownloadJob[]>('list_downloads')
        .then((allJobs) => {
          if (allJobs && allJobs.length > 0) {
            const active = allJobs.filter((j) =>
              ['downloading', 'probing', 'pausing', 'paused', 'verifying', 'queued'].includes(j.state)
            );
            if (active.length > 0) {
              const jobMap: Record<string, DownloadJob> = {};
              const ids: string[] = [];
              for (const j of active) {
                jobMap[j.id] = j;
                ids.push(j.id);
              }
              setJobs((prev) => ({ ...jobMap, ...prev }));
              setActiveIds((prev) => {
                const combined = [...prev];
                for (const id of ids) {
                  if (!combined.includes(id)) combined.push(id);
                }
                return combined;
              });
            }
          }
        })
        .catch(() => {});
    }
  }, [initialId, fetchJob]);

  // Listen to Tauri events
  useEffect(() => {
    const unlistenProgress = listen<DownloadEvent>('download-event', (event) => {
      const payload = event.payload;
      if (payload.type === 'Progress') {
        const prog = payload.payload;
        if (!dismissedIdsRef.current.has(prog.id)) {
          setActiveIds((prev) => (prev.includes(prog.id) ? prev : [...prev, prog.id]));
        }
        setJobs((prev) => {
          const existing = prev[prog.id];
          if (!existing) {
            fetchJob(prog.id);
            return prev;
          }
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
        dismissedIdsRef.current.delete(id);
        setActiveIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        fetchJob(id);
      }
    });

    const unlistenAdd = listen<string>('toast-add-download', (event) => {
      const id = event.payload;
      if (id) {
        dismissedIdsRef.current.delete(id);
        setActiveIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        fetchJob(id);
      }
    });

    return () => {
      unlistenProgress.then((u) => u());
      unlistenAdd.then((u) => u());
    };
  }, [fetchJob]);

  // Active reconciliation polling while active downloads exist
  useEffect(() => {
    const activeRunning = activeIds.some(
      (id) => jobs[id] && ['downloading', 'probing', 'pausing', 'verifying'].includes(jobs[id].state)
    );
    if (!activeRunning) return;

    const interval = setInterval(async () => {
      try {
        const all = await invoke<DownloadJob[]>('list_downloads');
        if (all) {
          setJobs((prev) => {
            let changed = false;
            const updated = { ...prev };
            for (const j of all) {
              if (prev[j.id]) {
                updated[j.id] = { ...prev[j.id], ...j };
                changed = true;
              }
            }
            return changed ? updated : prev;
          });
        }
      } catch {
        // ignore
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [activeIds, jobs]);

  const handleToggleExpand = useCallback(async (id: string) => {
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
  }, [chunks]);

  // Handle native window dragging on safe neutral areas
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (
      target.closest('button') ||
      target.closest('a') ||
      target.closest('input') ||
      target.closest('.action-btn') ||
      target.closest('.ib') ||
      target.closest('.cx') ||
      target.closest('.chip') ||
      target.closest('.rg') ||
      target.closest('.dr') ||
      target.closest('.toast-thumb-img') ||
      target.closest('.tx') ||
      target.closest('.eta')
    ) {
      return;
    }
    try {
      isUserDraggingRef.current = true;
      getCurrentWebviewWindow().startDragging();
    } catch {
      // ignore if not running in Tauri window
    }
  }, []);

  const handleTextMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragStartPosRef.current = { x: e.clientX, y: e.clientY };
    isTextMovedRef.current = false;
  }, []);

  const handleTextMouseMove = useCallback((e: React.MouseEvent) => {
    if (e.buttons === 1 && dragStartPosRef.current && !isTextMovedRef.current) {
      const dist = Math.hypot(
        e.clientX - dragStartPosRef.current.x,
        e.clientY - dragStartPosRef.current.y
      );
      if (dist > 5) {
        isTextMovedRef.current = true;
        isUserDraggingRef.current = true;
        try {
          getCurrentWebviewWindow().startDragging();
        } catch {
          // ignore if not running in Tauri window
        }
      }
    }
  }, []);

  const handleTextClick = useCallback(
    (id: string) => {
      if (isTextMovedRef.current) {
        isTextMovedRef.current = false;
        dragStartPosRef.current = null;
        return;
      }
      dragStartPosRef.current = null;
      handleToggleExpand(id);
    },
    [handleToggleExpand]
  );

  // Listen to window moved event to persist position
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: any = null;
    try {
      const win = getCurrentWebviewWindow();
      win.onMoved(({ payload: pos }) => {
        if (!isUserDraggingRef.current) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          isUserDraggingRef.current = false;
          try {
            const scale = await win.scaleFactor();
            const x = pos.x / scale;
            const y = pos.y / scale;
            await invoke('save_toast_position', { x, y });
          } catch {
            await invoke('save_toast_position', { x: pos.x, y: pos.y }).catch(() => {});
          }
        }, 300);
      }).then((u) => {
        unlisten = u;
      }).catch(() => {});
    } catch {
      // ignore
    }
    return () => {
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
    };
  }, []);

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

    const updateBounds = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const w = Math.max(494, Math.ceil(rect.width));
      const h = Math.max(100, Math.ceil(rect.height));

      if (
        Math.abs(lastBoundsRef.current.w - w) >= 1 ||
        Math.abs(lastBoundsRef.current.h - h) >= 1
      ) {
        lastBoundsRef.current = { w, h };
        invoke('update_toast_bounds', { width: w, height: h }).catch(() => {});
      }
    };

    const observer = new ResizeObserver(() => {
      updateBounds();
    });

    observer.observe(containerRef.current);
    updateBounds();

    return () => observer.disconnect();
  }, []);

  const handleDismiss = useCallback(
    async (id: string) => {
      dismissedIdsRef.current.add(id);
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

        // Percent & bytes calculation
        const total = job.total_bytes && job.total_bytes > 0 ? job.total_bytes : 0;
        const downloaded = job.downloaded_bytes || 0;
        const hasKnownTotal = total > 0;
        const pct = hasKnownTotal ? Math.min(100, Math.max(0, (downloaded / total) * 100)) : 0;

        // Empty ring if total is unknown or starting, full ring if complete, else dashoffset
        const offset = isComplete
          ? 0
          : hasKnownTotal
          ? CIRCUMFERENCE * (1 - pct / 100)
          : CIRCUMFERENCE;

        // Speed string
        const speedStr = fmtSp(job.speed_bps);
        const speedPart = speedStr ? ` · ${speedStr}` : '';

        // Subtext line
        let subtext = '';
        if (isComplete) {
          const finalBytes = hasKnownTotal ? total : downloaded;
          subtext = `${fmtB(finalBytes)} · Download complete`;
        } else if (isFailed) {
          subtext = job.error_message || 'Connection lost · 3 retries failed';
        } else if (isPaused) {
          subtext = hasKnownTotal
            ? `${fmtProgressBytes(downloaded, total)} · Paused`
            : `${fmtB(downloaded)} · Paused`;
        } else {
          // Active states: downloading, probing, verifying
          if (downloaded === 0) {
            subtext = 'Starting…';
          } else if (hasKnownTotal) {
            subtext = `${fmtProgressBytes(downloaded, total)}${speedPart}`;
          } else {
            subtext = `${fmtB(downloaded)}${speedPart}`;
          }
        }

        // ETA display
        let etaNum = '--';
        let etaSub = 'left';
        if (isComplete) {
          etaNum = 'Done';
          etaSub = 'Finished';
        } else if (isFailed) {
          etaNum = 'Failed';
          etaSub = hasKnownTotal ? `${Math.floor(pct)}%` : '';
        } else if (isPaused) {
          etaNum = 'Paused';
          etaSub = hasKnownTotal ? `${Math.floor(pct)}%` : '';
        } else {
          // Active downloading
          if (downloaded === 0) {
            etaNum = 'Starting…';
            etaSub = '';
          } else if (!hasKnownTotal) {
            etaNum = 'Live';
            etaSub = 'Unknown size';
          } else {
            const formatted = formatEta(job.eta_seconds);
            if (formatted === '--') {
              etaNum = '--';
              etaSub = 'calculating';
            } else {
              etaNum = formatted;
              etaSub = 'left';
            }
          }
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
            onMouseDown={handleDragStart}
            onMouseEnter={() => {
              hoveredRef.current[id] = true;
            }}
            onMouseLeave={() => {
              hoveredRef.current[id] = false;
            }}
          >
            <div className="row" onMouseDown={handleDragStart}>
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
                  className={`chip ${job.thumbnail_url ? 'has-thumb' : ''}`}
                  style={{
                    background: job.thumbnail_url
                      ? 'transparent'
                      : `linear-gradient(${chip.grad[0]}, ${chip.grad[1]})`,
                  }}
                >
                  {job.thumbnail_url ? (
                    <img
                      src={job.thumbnail_url}
                      alt=""
                      className="toast-thumb-img"
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                        const fallback = e.currentTarget.parentElement?.querySelector('.chip-fallback-svg');
                        if (fallback) (fallback as HTMLElement).style.display = 'block';
                      }}
                    />
                  ) : null}
                  <svg
                    viewBox="0 0 24 24"
                    className="chip-fallback-svg"
                    style={{ display: job.thumbnail_url ? 'none' : 'block' }}
                  >
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

              <div
                className="tx"
                onMouseDown={handleTextMouseDown}
                onMouseMove={handleTextMouseMove}
                onClick={() => handleTextClick(id)}
                title="Click for details"
              >
                <b>{job.filename}</b>
                <span>{subtext}</span>
              </div>

              <div
                className="eta"
                onMouseDown={handleTextMouseDown}
                onMouseMove={handleTextMouseMove}
                onClick={() => handleTextClick(id)}
                title="Click for details"
              >
                <b>{etaNum}</b>
                {etaSub ? <span>{etaSub}</span> : null}
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
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await invoke('retry_download', { id: job.id });
                    } catch (err) {
                      console.error('Failed to retry download:', err);
                    }
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
