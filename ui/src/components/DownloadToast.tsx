import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type {
  AppSettings,
  ChunkRecord,
  DownloadCompletionOptions,
  DownloadEvent,
  DownloadJob,
  DownloadProgress,
  DownloadStatusDetails,
  JobState,
} from '../types';
import { fmtB, fmtSp, fmtT } from '../utils';
import './DownloadToast.css';

type PopupTab = 'status' | 'limiter' | 'completion';

interface DownloadToastProps {
  initialId?: string;
}

const DEFAULT_SPEED_KBPS = 512;

function applyDocumentAppearance(theme?: string, accent?: string, motion?: boolean) {
  const effectiveThemePref = theme && ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  const isDark =
    effectiveThemePref === 'dark' ||
    (effectiveThemePref === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  document.documentElement.dataset.accent =
    accent && ['indigo', 'ocean', 'emerald', 'rose'].includes(accent) ? accent : 'indigo';
  document.documentElement.dataset.reduceMotion = motion ? 'true' : 'false';
  const bg = isDark ? '#232326' : '#f5f5f8';
  document.documentElement.style.backgroundColor = bg;
  if (document.body) {
    document.body.style.backgroundColor = bg;
  }
}

function readStoredAppearance(): { theme?: string; accent?: string; motion?: boolean } {
  try {
    const raw = localStorage.getItem('tori_settings_v2');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        theme: parsed?.theme,
        accent: parsed?.accent,
        motion: Boolean(parsed?.motion),
      };
    }
  } catch {
    // ignore storage parse failure
  }
  return {};
}

function isTransferActive(state: JobState): boolean {
  return state === 'downloading' || state === 'probing' || state === 'verifying';
}

function parentFolderLabel(targetPath: string): string {
  if (!targetPath) return '';
  const idx = Math.max(targetPath.lastIndexOf('\\'), targetPath.lastIndexOf('/'));
  if (idx <= 0) return targetPath;
  return targetPath.slice(0, idx);
}

function formatStatusLabel(job: DownloadJob): { text: string; cls: string } {
  switch (job.state) {
    case 'downloading':
      return { text: 'Downloading', cls: 'v b' };
    case 'probing':
      return { text: 'Connecting…', cls: 'v b' };
    case 'created':
    case 'queued':
      return { text: 'Queued', cls: 'v' };
    case 'scheduled':
      return {
        text: job.scheduled_at ? `Scheduled (${job.scheduled_at})` : 'Scheduled',
        cls: 'v',
      };
    case 'pausing':
      return { text: 'Pausing…', cls: 'v' };
    case 'paused':
      return { text: 'Paused', cls: 'v' };
    case 'verifying':
      return { text: 'Verifying & finalizing…', cls: 'v b' };
    case 'completed':
      return { text: 'Complete', cls: 'v g' };
    case 'failed':
      return { text: 'Failed', cls: 'v e' };
    case 'cancelled':
      return { text: 'Cancelled', cls: 'v' };
    default:
      return { text: String(job.state), cls: 'v' };
  }
}

function formatWindowTitle(job: DownloadJob | null, pctKnown: number | null): string {
  if (!job) return 'TORI Download';
  const pctStr = pctKnown !== null ? `${Math.floor(pctKnown)}% ` : '';
  switch (job.state) {
    case 'completed':
      return 'Download complete';
    case 'failed':
      return 'Download failed';
    case 'cancelled':
      return 'Download cancelled';
    case 'paused':
      return `${pctStr}Paused - ${job.filename}`.trim();
    case 'pausing':
      return `${pctStr}${job.filename} (Pausing)`.trim();
    case 'verifying':
      return `100% ${job.filename}`;
    case 'queued':
      return `Queued - ${job.filename}`;
    case 'scheduled':
      return `Scheduled - ${job.filename}`;
    case 'probing':
      return `Connecting - ${job.filename}`;
    default:
      return pctKnown !== null ? `${Math.floor(pctKnown)}% ${job.filename}` : job.filename;
  }
}

function computeBarClass(state: JobState, totalKnown: boolean): string {
  if (state === 'completed') return 'done';
  if (state === 'paused' || state === 'pausing') return 'paused';
  if (state === 'failed' || state === 'cancelled') return 'failed';
  if (!totalKnown && (state === 'downloading' || state === 'probing')) return 'unknown';
  return '';
}

export const DownloadToast: React.FC<DownloadToastProps> = ({ initialId }) => {
  const [targetId, setTargetId] = useState<string | null>(() => {
    if (initialId) return initialId;
    try {
      return new URLSearchParams(window.location.search).get('id');
    } catch {
      return null;
    }
  });

  const [job, setJob] = useState<DownloadJob | null>(null);
  const [details, setDetails] = useState<DownloadStatusDetails | null>(null);
  const [activeTab, setActiveTab] = useState<PopupTab>('status');
  const [compact, setCompact] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [isVisible, setIsVisible] = useState(() =>
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
  );

  // Speed limiter tab controlled UI state
  const [limiterEnabled, setLimiterEnabled] = useState(false);
  const [limiterKbpsInput, setLimiterKbpsInput] = useState<string>(String(DEFAULT_SPEED_KBPS));
  const limiterInitializedRef = useRef(false);
  const limiterEditingRef = useRef(false);
  const limiterDebounceRef = useRef<number | null>(null);

  // Completion options tab state
  const [completionOpts, setCompletionOpts] = useState<DownloadCompletionOptions>({
    close_on_complete: false,
    notify_on_complete: false,
    open_on_complete: false,
  });

  const winRef = useRef<HTMLDivElement>(null);
  const lastMeasuredHeightRef = useRef<number>(0);
  const pendingProgressRef = useRef<DownloadProgress | null>(null);
  const actionLockRef = useRef(false);
  const themePrefRef = useRef<string>('system');
  const targetIdRef = useRef<string | null>(targetId);
  const compactRef = useRef(compact);
  const activeTabRef = useRef(activeTab);

  useEffect(() => {
    targetIdRef.current = targetId;
  }, [targetId]);
  useEffect(() => {
    compactRef.current = compact;
  }, [compact]);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // Apply reactive theme, accent & motion across MainWindow -> ProgressWindow
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paramTheme = params.get('theme') || undefined;
    const paramAccent = params.get('accent') || undefined;
    const stored = readStoredAppearance();

    const initTheme = paramTheme || stored.theme || 'system';
    const initAccent = paramAccent || stored.accent || 'indigo';
    themePrefRef.current = initTheme;
    applyDocumentAppearance(initTheme, initAccent, stored.motion);

    invoke<AppSettings | null>('get_engine_settings')
      .then((s) => {
        if (s) {
          const nextTheme = paramTheme || s.theme || initTheme;
          const nextAccent = paramAccent || s.accent || initAccent;
          themePrefRef.current = nextTheme;
          applyDocumentAppearance(nextTheme, nextAccent, Boolean(s.motion));
        }
      })
      .catch(() => {});

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (themePrefRef.current === 'system') {
        applyDocumentAppearance('system', document.documentElement.dataset.accent, document.documentElement.dataset.reduceMotion === 'true');
      }
    };
    mql.addEventListener('change', onSystemChange);

    const onStorage = (e: StorageEvent) => {
      if (e.key === 'tori_settings_v2' && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          themePrefRef.current = parsed.theme || 'system';
          applyDocumentAppearance(parsed.theme, parsed.accent, Boolean(parsed.motion));
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener('storage', onStorage);

    const unlistenSettings = listen<AppSettings>('settings-updated', (ev) => {
      const s = ev.payload;
      if (s) {
        themePrefRef.current = s.theme || 'system';
        applyDocumentAppearance(s.theme, s.accent, Boolean(s.motion));
      }
    });

    return () => {
      mql.removeEventListener('change', onSystemChange);
      window.removeEventListener('storage', onStorage);
      unlistenSettings.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const syncDetailsFromBackend = useCallback((d: DownloadStatusDetails) => {
    setDetails(d);
    if (!limiterEditingRef.current) {
      if (d.job_speed_limit_bps > 0) {
        setLimiterEnabled(true);
        setLimiterKbpsInput(String(Math.max(1, Math.round(d.job_speed_limit_bps / 1000))));
      } else if (!limiterInitializedRef.current) {
        setLimiterEnabled(false);
        setLimiterKbpsInput(String(DEFAULT_SPEED_KBPS));
      } else {
        setLimiterEnabled(false);
      }
      limiterInitializedRef.current = true;
    }
  }, []);

  const refreshFullState = useCallback(
    async (id: string) => {
      try {
        const [fetchedJob, fetchedDetails, fetchedOpts] = await Promise.all([
          invoke<DownloadJob | null>('get_download', { id }),
          invoke<DownloadStatusDetails>('get_download_status_details', { id }).catch(() => null),
          invoke<DownloadCompletionOptions>('get_download_completion_options', { id }).catch(
            () => null
          ),
        ]);

        if (!fetchedJob) {
          return;
        }
        setJob(fetchedJob);
        if (fetchedDetails) {
          syncDetailsFromBackend(fetchedDetails);
        }
        if (fetchedOpts) {
          setCompletionOpts(fetchedOpts);
        }
      } catch (err) {
        console.error('Failed to refresh progress window state:', err);
      }
    },
    [syncDetailsFromBackend]
  );

  const closePopupWindow = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().close();
    } catch {
      invoke('hide_toast_window').catch(() => {});
    }
  }, []);

  // Resolve target download ID if none passed via URL, and load initial state
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let id = targetIdRef.current;
      if (!id) {
        try {
          const all = await invoke<DownloadJob[]>('list_downloads');
          const preferred = all.find((j) => isTransferActive(j.state)) || all[0];
          if (preferred && !cancelled) {
            id = preferred.id;
            setTargetId(id);
          }
        } catch {
          // ignore
        }
      }
      if (id && !cancelled) {
        await refreshFullState(id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshFullState]);

  // Listen to backend download events & restore/delete notifications
  useEffect(() => {
    let disposed = false;

    const unlistenDownload = listen<DownloadEvent>('download-event', (event) => {
      if (disposed) return;
      const ev = event.payload;
      const curId = targetIdRef.current;
      if (!curId) return;

      if (ev.type === 'Progress' && ev.payload.id === curId) {
        // Buffer progress updates; interval commits strictly at <= 1 Hz
        pendingProgressRef.current = ev.payload;
      } else if (ev.type === 'StateChanged' && ev.payload.id === curId) {
        pendingProgressRef.current = null;
        const { state, error } = ev.payload;
        setJob((prev) =>
          prev
            ? {
                ...prev,
                state,
                error_message: error,
                speed_bps: state === 'downloading' ? prev.speed_bps : 0,
              }
            : prev
        );
        refreshFullState(curId);
      } else if (ev.type === 'Deleted' && ev.payload.id === curId) {
        closePopupWindow();
      }
    });

    const unlistenDeleted = listen<string>('download-deleted', (event) => {
      if (!disposed && event.payload === targetIdRef.current) {
        closePopupWindow();
      }
    });

    const unlistenRestore = listen<string>('progress-restore-full', (event) => {
      if (!disposed && event.payload === targetIdRef.current) {
        setCompact(false);
      }
    });

    const onVisibility = () => {
      const visible = document.visibilityState === 'visible';
      setIsVisible(visible);
      if (visible && targetIdRef.current) {
        pendingProgressRef.current = null;
        refreshFullState(targetIdRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      unlistenDownload.then((fn) => fn()).catch(() => {});
      unlistenDeleted.then((fn) => fn()).catch(() => {});
      unlistenRestore.then((fn) => fn()).catch(() => {});
    };
  }, [closePopupWindow, refreshFullState]);

  // Strict <= 1 Hz UI progress/telemetry commit loop (active ONLY while downloading & visible)
  const jobState = job?.state;
  useEffect(() => {
    if (!targetId || !isVisible || !jobState || !isTransferActive(jobState)) {
      return;
    }

    const flushTick = async () => {
      const p = pendingProgressRef.current;
      if (p && p.id === targetId) {
        pendingProgressRef.current = null;
        setJob((prev) =>
          prev
            ? {
                ...prev,
                downloaded_bytes: p.downloaded_bytes,
                total_bytes: p.total_bytes,
                speed_bps: p.speed_bps,
                eta_seconds: p.eta_seconds,
                state: p.state,
                error_message: p.error_message,
              }
            : prev
        );
      }

      if (!compactRef.current && activeTabRef.current === 'status') {
        try {
          const d = await invoke<DownloadStatusDetails>('get_download_status_details', {
            id: targetId,
          });
          syncDetailsFromBackend(d);
        } catch {
          // ignore transient read errors
        }
      }
    };

    const timerId = window.setInterval(flushTick, 1000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [targetId, isVisible, jobState, syncDetailsFromBackend]);

  // Save window position after manual drags
  useEffect(() => {
    let unlistenMove: (() => void) | undefined;
    let moveTimer: number | null = null;
    try {
      const win = getCurrentWebviewWindow();
      win
        .onMoved((ev) => {
          if (moveTimer !== null) {
            window.clearTimeout(moveTimer);
          }
          moveTimer = window.setTimeout(async () => {
            try {
              const scale = await win.scaleFactor();
              const x = ev.payload.x / (scale || 1);
              const y = ev.payload.y / (scale || 1);
              await invoke('save_toast_position', { x, y });
            } catch {
              // ignore
            }
          }, 250);
        })
        .then((fn) => {
          unlistenMove = fn;
        })
        .catch(() => {});
    } catch {
      // ignore outside Tauri
    }
    return () => {
      if (moveTimer !== null) window.clearTimeout(moveTimer);
      if (unlistenMove) unlistenMove();
    };
  }, []);

  // Resize native WebView2 window height cleanly to match .dl-win without slack or clipping
  useLayoutEffect(() => {
    const syncWindowHeight = () => {
      if (!winRef.current) return;
      const measured = Math.ceil(winRef.current.getBoundingClientRect().height);
      const targetHeight = Math.max(36, measured);
      if (Math.abs(lastMeasuredHeightRef.current - targetHeight) >= 1) {
        lastMeasuredHeightRef.current = targetHeight;
        invoke('update_toast_bounds', { width: 460, height: targetHeight }).catch(() => {});
      }
    };

    syncWindowHeight();
    if (!winRef.current) return;
    const ro = new ResizeObserver(syncWindowHeight);
    ro.observe(winRef.current);
    return () => {
      ro.disconnect();
    };
  }, [compact, activeTab, job?.state, job?.error_message, details?.chunks.length]);

  const pctKnown = useMemo<number | null>(() => {
    if (!job) return null;
    if (job.state === 'completed') return 100;
    if (job.total_bytes != null && job.total_bytes > 0) {
      return Math.min(100, Math.max(0, (job.downloaded_bytes / job.total_bytes) * 100));
    }
    return null;
  }, [job]);

  const windowTitle = useMemo(() => formatWindowTitle(job, pctKnown), [job, pctKnown]);

  // Keep native OS title in sync at <= 1 Hz with window bar title
  useEffect(() => {
    try {
      getCurrentWebviewWindow().setTitle(windowTitle).catch(() => {});
    } catch {
      // ignore
    }
  }, [windowTitle]);

  const runAction = useCallback(async (fn: () => Promise<void>) => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setActionBusy(true);
    try {
      await fn();
    } catch (err) {
      console.error('Progress window action failed:', err);
    } finally {
      actionLockRef.current = false;
      setActionBusy(false);
    }
  }, []);

  const handleTitleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest('.dl-wc') || el.closest('button')) return;
    try {
      getCurrentWebviewWindow().startDragging().catch(() => {});
    } catch {
      // ignore
    }
  };

  const commitSpeedLimit = useCallback(
    async (enabled: boolean, kbpsStr: string) => {
      if (!targetId) return;
      const parsed = parseInt(kbpsStr, 10);
      const safeKbps = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1_048_576) : DEFAULT_SPEED_KBPS;
      if (enabled && (!Number.isFinite(parsed) || parsed <= 0)) {
        setLimiterKbpsInput(String(safeKbps));
      }
      const limitBps = enabled ? safeKbps * 1000 : 0;
      try {
        await invoke('set_download_speed_limit', { id: targetId, limitBps });
        setDetails((prev) => (prev ? { ...prev, job_speed_limit_bps: limitBps } : prev));
      } catch (err) {
        console.error('Failed to set download speed limit:', err);
      }
    },
    [targetId]
  );

  const handleToggleLimiter = (checked: boolean) => {
    setLimiterEnabled(checked);
    if (limiterDebounceRef.current !== null) {
      window.clearTimeout(limiterDebounceRef.current);
      limiterDebounceRef.current = null;
    }
    commitSpeedLimit(checked, limiterKbpsInput);
  };

  const handleKbpsChange = (val: string) => {
    setLimiterKbpsInput(val);
    if (limiterDebounceRef.current !== null) {
      window.clearTimeout(limiterDebounceRef.current);
      limiterDebounceRef.current = null;
    }
    if (limiterEnabled) {
      const parsed = parseInt(val, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limiterDebounceRef.current = window.setTimeout(() => {
          limiterDebounceRef.current = null;
          commitSpeedLimit(true, val);
        }, 200);
      }
    }
  };

  const handleCompletionOptionChange = async (
    key: keyof DownloadCompletionOptions,
    checked: boolean
  ) => {
    if (!targetId) return;
    const nextOpts: DownloadCompletionOptions = {
      ...completionOpts,
      [key]: checked,
    };
    setCompletionOpts(nextOpts);
    try {
      await invoke('set_download_completion_options', { id: targetId, options: nextOpts });
    } catch (err) {
      console.error('Failed to save completion options:', err);
    }
  };

  useEffect(() => {
    return () => {
      if (limiterDebounceRef.current !== null) {
        window.clearTimeout(limiterDebounceRef.current);
      }
    };
  }, []);

  const totalBytesKnown = Boolean(job && job.total_bytes != null && job.total_bytes > 0);
  const barWidthPct = pctKnown !== null ? pctKnown : job?.state === 'completed' ? 100 : 0;
  const barStateCls = job ? computeBarClass(job.state, totalBytesKnown) : '';

  const segments = useMemo<ChunkRecord[]>(() => {
    if (!job) return [];
    const list = details?.chunks;
    if (list && list.length > 0) {
      return [...list].sort((a, b) => a.chunk_index - b.chunk_index);
    }
    return [
      {
        id: null,
        download_id: job.id,
        chunk_index: 0,
        start_byte: 0,
        end_byte: job.total_bytes && job.total_bytes > 0 ? job.total_bytes - 1 : 0,
        written_bytes: job.downloaded_bytes,
        is_complete: job.state === 'completed',
      },
    ];
  }, [details?.chunks, job]);

  const activeConnections = useMemo(() => {
    if (!job) return 0;
    if (details) return details.active_connections;
    return isTransferActive(job.state) ? Math.max(1, job.chunk_count || 1) : 0;
  }, [details, job]);

  const completedSegmentsCount = useMemo(
    () => segments.filter((s) => s.is_complete).length,
    [segments]
  );

  const statusMeta = job ? formatStatusLabel(job) : { text: 'Loading…', cls: 'v' };

  const downloadedText = useMemo(() => {
    if (!job) return '--';
    const dStr = fmtB(job.downloaded_bytes);
    if (pctKnown !== null) {
      return `${dStr} ( ${pctKnown.toFixed(2)} % )`;
    }
    return dStr;
  }, [job, pctKnown]);

  const transferRateText = useMemo(() => {
    if (!job) return '--';
    if (job.state === 'downloading' || job.state === 'probing') {
      return job.speed_bps && job.speed_bps > 0 ? fmtSp(job.speed_bps) : '0 KB/s';
    }
    return '--';
  }, [job]);

  const timeLeftText = useMemo(() => {
    if (!job) return '--';
    if (job.state === 'completed') return '0 sec';
    if (job.state === 'downloading') return fmtT(job.eta_seconds);
    return '--';
  }, [job]);

  // Footer button definitions & hint
  const renderFooter = () => {
    if (!job) {
      return (
        <div className="dl-foot">
          <span className="dl-hint">Loading download details…</span>
          <button type="button" className="dl-btn" onClick={closePopupWindow}>
            Close
          </button>
          <button type="button" className="dl-btn pri" disabled>
            Pause
          </button>
        </div>
      );
    }

    const st = job.state;
    const folderLabel = parentFolderLabel(job.target_path);

    if (st === 'completed') {
      return (
        <div className="dl-foot">
          <span className="dl-hint" title={job.target_path}>
            <button
              type="button"
              className="dl-hint-link"
              onClick={() => runAction(() => invoke('open_folder', { path: job.target_path }))}
              title={`Open folder: ${folderLabel}`}
            >
              Open containing folder
            </button>
          </span>
          <button
            type="button"
            className="dl-btn"
            disabled={actionBusy}
            onClick={closePopupWindow}
          >
            Close
          </button>
          <button
            type="button"
            className="dl-btn pri"
            disabled={actionBusy}
            onClick={() => runAction(() => invoke('open_file', { path: job.target_path }))}
          >
            Open
          </button>
        </div>
      );
    }

    if (st === 'failed' || st === 'cancelled') {
      const hintTxt =
        st === 'failed'
          ? job.error_message || 'Download interrupted'
          : 'Download cancelled';
      return (
        <div className="dl-foot">
          <span className="dl-hint" title={hintTxt}>
            {hintTxt}
          </span>
          <button
            type="button"
            className="dl-btn"
            disabled={actionBusy}
            onClick={closePopupWindow}
          >
            Close
          </button>
          <button
            type="button"
            className="dl-btn pri"
            disabled={actionBusy}
            onClick={() => runAction(() => invoke('retry_download', { id: job.id }))}
          >
            Retry
          </button>
        </div>
      );
    }

    if (st === 'paused') {
      return (
        <div className="dl-foot">
          <span className="dl-hint">Download paused</span>
          <button
            type="button"
            className="dl-btn"
            disabled={actionBusy}
            onClick={() => runAction(() => invoke('cancel_download', { id: job.id }))}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dl-btn pri"
            disabled={actionBusy}
            onClick={() => runAction(() => invoke('resume_download', { id: job.id }))}
          >
            Resume
          </button>
        </div>
      );
    }

    if (st === 'verifying') {
      return (
        <div className="dl-foot">
          <span className="dl-hint">Finalizing file on disk…</span>
          <button
            type="button"
            className="dl-btn"
            disabled={actionBusy}
            onClick={closePopupWindow}
          >
            Close
          </button>
          <button type="button" className="dl-btn pri" disabled>
            Saving…
          </button>
        </div>
      );
    }

    const activeLimitBps = details?.job_speed_limit_bps || 0;
    const activeHint =
      activeLimitBps > 0
        ? `Speed limit: ${Math.max(1, Math.round(activeLimitBps / 1000))} KB/s`
        : st === 'queued'
        ? 'Waiting in queue…'
        : st === 'scheduled'
        ? 'Scheduled download'
        : st === 'probing'
        ? 'Negotiating connections…'
        : 'Transferring data…';

    return (
      <div className="dl-foot">
        <span className="dl-hint" title={activeHint}>
          {activeHint}
        </span>
        <button
          type="button"
          className="dl-btn"
          disabled={actionBusy}
          onClick={() => runAction(() => invoke('cancel_download', { id: job.id }))}
        >
          Cancel
        </button>
        <button
          type="button"
          className="dl-btn pri"
          disabled={actionBusy || st === 'pausing'}
          onClick={() => runAction(() => invoke('pause_download', { id: job.id }))}
        >
          {st === 'pausing' ? 'Pausing…' : 'Pause'}
        </button>
      </div>
    );
  };

  return (
    <div className="dl-popup-root">
      <div
        ref={winRef}
        id="w"
        className={compact ? 'dl-win m' : 'dl-win'}
        data-job-id={job?.id || targetId || ''}
        data-state={job?.state || 'loading'}
      >
        {/* Titlebar (.wbar) */}
        <div
          className="dl-wbar"
          onMouseDown={handleTitleMouseDown}
          onDoubleClick={() => compact && setCompact(false)}
          title={job?.filename || windowTitle}
        >
          <span id="wt" className="dl-wbar-title">
            {windowTitle}
          </span>
          <div className="dl-wc">
            <button
              type="button"
              id="mn"
              className="dl-mn"
              title={compact ? 'Restore Progress Window' : 'Minimize to Compact Bar'}
              aria-label={compact ? 'Restore Progress Window' : 'Minimize to Compact Bar'}
              onClick={() => setCompact((c) => !c)}
            >
              {compact ? (
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="2" y="2" width="6" height="6" rx="0.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1.5 5h7" />
                </svg>
              )}
            </button>
            <button
              type="button"
              id="cl"
              className="dl-cl"
              title="Close window (download continues in background)"
              aria-label="Close Progress Window"
              onClick={closePopupWindow}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2l6 6M8 2L2 8" />
              </svg>
            </button>
          </div>
        </div>

        {/* Compact Progress Strip (.mini) */}
        <div className="dl-mini" aria-hidden={!compact}>
          <i className={barStateCls} style={{ width: `${barWidthPct.toFixed(2)}%` }} />
        </div>

        {/* 3 Navigation Tabs */}
        <div className="dl-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'status'}
            data-tab="status"
            className={`dl-tab ${activeTab === 'status' ? 'on' : ''}`}
            onClick={() => setActiveTab('status')}
          >
            Download status
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'limiter'}
            data-tab="limiter"
            className={`dl-tab ${activeTab === 'limiter' ? 'on' : ''}`}
            onClick={() => setActiveTab('limiter')}
          >
            Speed limiter
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'completion'}
            data-tab="completion"
            className={`dl-tab ${activeTab === 'completion' ? 'on' : ''}`}
            onClick={() => setActiveTab('completion')}
          >
            Options on completion
          </button>
        </div>

        {/* Tab 1: Download status */}
        {activeTab === 'status' && (
          <div className="dl-pane" data-pane="status">
            <div className="dl-grid">
              <span className="k">URL</span>
              <span className="v" title={job?.url || ''}>
                {job?.url || '--'}
              </span>

              <span className="k">Status</span>
              <span className={statusMeta.cls} title={job?.error_message || statusMeta.text}>
                {statusMeta.text}
              </span>

              <span className="k">File size</span>
              <span className="v">{job ? fmtB(job.total_bytes) : '--'}</span>

              <span className="k">Downloaded</span>
              <span className="v">{downloadedText}</span>

              <span className="k">Transfer rate</span>
              <span className="v">{transferRateText}</span>

              <span className="k">Time left</span>
              <span className="v">{timeLeftText}</span>

              <span className="k">Resume capability</span>
              <span className={job?.is_resumable ? 'v g' : 'v'}>
                {job ? (job.is_resumable ? 'Yes' : 'No') : '--'}
              </span>
            </div>

            {job?.state === 'failed' && job.error_message && (
              <div className="dl-err-banner" title={job.error_message}>
                {job.error_message}
              </div>
            )}

            <div className="dl-bw" aria-label="Overall progress">
              <div
                className={`dl-bar ${barStateCls}`}
                style={{ width: `${barWidthPct.toFixed(2)}%` }}
              />
            </div>

            <div className="dl-seg">
              <div className="dl-seg-hdr">
                <span>
                  Connections : <b id="dl-conn-count">{activeConnections}</b>
                </span>
                {segments.length > 1 && (
                  <span>
                    {completedSegmentsCount} / {segments.length} parts complete
                  </span>
                )}
              </div>
              <div className="dl-sg">
                {segments.map((seg) => {
                  const span = seg.end_byte >= seg.start_byte ? seg.end_byte - seg.start_byte + 1 : 0;
                  let segPct = 0;
                  if (seg.is_complete || job?.state === 'completed') {
                    segPct = 100;
                  } else if (span > 0) {
                    segPct = Math.min(100, Math.max(0, (seg.written_bytes / span) * 100));
                  } else if (seg.written_bytes > 0 && isTransferActive(job?.state || 'downloading')) {
                    segPct = 50;
                  }
                  const segCls =
                    seg.is_complete || job?.state === 'completed'
                      ? 'done'
                      : job?.state === 'paused' || job?.state === 'pausing'
                      ? 'paused'
                      : job?.state === 'failed' || job?.state === 'cancelled'
                      ? 'failed'
                      : '';
                  return (
                    <i key={seg.chunk_index} title={`Part ${seg.chunk_index + 1}: ${segPct.toFixed(0)}%`}>
                      <b className={segCls} style={{ width: `${segPct.toFixed(1)}%` }} />
                    </i>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Speed limiter */}
        {activeTab === 'limiter' && (
          <div className="dl-pane" data-pane="limiter">
            <label className="dl-opt-row" htmlFor="dl-lim-enable">
              <input
                id="dl-lim-enable"
                type="checkbox"
                checked={limiterEnabled}
                onChange={(e) => handleToggleLimiter(e.target.checked)}
              />
              <span>Use speed limiter</span>
            </label>

            <div className={`dl-fr ${!limiterEnabled ? 'dis' : ''}`}>
              <span>Maximum speed</span>
              <input
                id="dl-lim-value"
                className="dl-fi"
                type="number"
                min={1}
                max={1048576}
                disabled={!limiterEnabled}
                value={limiterKbpsInput}
                onFocus={() => {
                  limiterEditingRef.current = true;
                }}
                onChange={(e) => handleKbpsChange(e.target.value)}
                onBlur={() => {
                  limiterEditingRef.current = false;
                  if (limiterEnabled) {
                    if (limiterDebounceRef.current !== null) {
                      window.clearTimeout(limiterDebounceRef.current);
                      limiterDebounceRef.current = null;
                    }
                    commitSpeedLimit(true, limiterKbpsInput);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && limiterEnabled) {
                    if (limiterDebounceRef.current !== null) {
                      window.clearTimeout(limiterDebounceRef.current);
                      limiterDebounceRef.current = null;
                    }
                    commitSpeedLimit(true, limiterKbpsInput);
                  }
                }}
              />
              <span>KB/s</span>
            </div>

            <div className="dl-note">
              {limiterEnabled
                ? `Throttles this download immediately to ${Math.max(
                    1,
                    parseInt(limiterKbpsInput, 10) || DEFAULT_SPEED_KBPS
                  )} KB/s without affecting global settings.`
                : 'Enable to cap bandwidth for this download without affecting other active transfers.'}
              {details && details.global_speed_limit_bps > 0 && (
                <div>
                  Global Settings limiter is also active at{' '}
                  {Math.max(1, Math.round(details.global_speed_limit_bps / 1024))} KB/s.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 3: Options on completion */}
        {activeTab === 'completion' && (
          <div className="dl-pane" data-pane="completion">
            <label className="dl-opt-row" htmlFor="dl-opt-close">
              <input
                id="dl-opt-close"
                type="checkbox"
                checked={completionOpts.close_on_complete}
                onChange={(e) =>
                  handleCompletionOptionChange('close_on_complete', e.target.checked)
                }
              />
              <span>Close this window when the download completes</span>
            </label>

            <label className="dl-opt-row" htmlFor="dl-opt-notify">
              <input
                id="dl-opt-notify"
                type="checkbox"
                checked={completionOpts.notify_on_complete}
                onChange={(e) =>
                  handleCompletionOptionChange('notify_on_complete', e.target.checked)
                }
              />
              <span>Show a notification when complete</span>
            </label>

            <label className="dl-opt-row" htmlFor="dl-opt-open">
              <input
                id="dl-opt-open"
                type="checkbox"
                checked={completionOpts.open_on_complete}
                onChange={(e) =>
                  handleCompletionOptionChange('open_on_complete', e.target.checked)
                }
              />
              <span>Open the file when complete</span>
            </label>

            <div className="dl-note">
              Saved automatically for this download and enforced even if you close this window.
            </div>
          </div>
        )}

        {/* Fixed 2-button Footer (.foot) */}
        {renderFooter()}
      </div>
    </div>
  );
};
