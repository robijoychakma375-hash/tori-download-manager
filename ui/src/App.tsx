import { useEffect, useState, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './App.css';
import type { AppSettings, CategoryKey, DownloadEvent, DownloadJob } from './types';
import { TitleBar } from './components/TitleBar';
import { ToolBar } from './components/ToolBar';
import { SideBar } from './components/SideBar';
import { DownloadTable } from './components/DownloadTable';
import { StatusBar } from './components/StatusBar';
import { AddDownloadModal } from './components/AddDownloadModal';
import { ProgressModal } from './components/ProgressModal';
import { DownloadToast } from './components/DownloadToast';
import { SettingsModal } from './components/SettingsModal';
import { ContextMenu } from './components/ContextMenu';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import { typeOfJob } from './utils';

const DEFAULT_SETTINGS: AppSettings = {
  dir: 'C:\\Users\\User\\Downloads',
  sort: true,
  con: 16,
  maxa: 4,
  limMode: 'off',
  limV: 256,
  limU: 'KiB/s',
  retries: 3,
  dyn: true,
  mps: 512,
  mpsU: 'KiB',
  ua: '',
  ssl: false,
  lm: false,
  track: true,
  dns: 'System DNS',
  proxy: 'none',
  port: 7070,
  key: 'tori_live_api_key_v2',
  cap: true,
  theme: 'system',
  accent: 'indigo',
  motion: false,
  details: false,
  showDownloadPopup: 'always',
};

function loadStoredSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('tori_settings_v2');
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('Failed to parse stored settings:', err);
  }
  return DEFAULT_SETTINGS;
}

const DEMO_DOWNLOADS: DownloadJob[] = [
  {
    id: 'demo-1',
    filename: 'Firefox 61.0.2.dmg',
    url: 'https://download-installer.cdn.mozilla.net/pub/firefox/releases/61.0.2/mac/en-US/Firefox%2061.0.2.dmg',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\Firefox 61.0.2.dmg',
    temp_path: 'C:\\Users\\User\\Downloads\\Firefox 61.0.2.dmg.tdm-part',
    total_bytes: 55283000,
    downloaded_bytes: 48860000,
    state: 'downloading',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 11,
    priority: 'normal',
    error_message: null,
    created_at: 'Today 10:42',
    updated_at: 'Today 10:42',
    speed_bps: 1850000,
    eta_seconds: 3,
  },
  {
    id: 'demo-2',
    filename: 'ubuntu-24.04-desktop-amd64.iso',
    url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\ubuntu-24.04-desktop-amd64.iso',
    temp_path: 'C:\\Users\\User\\Downloads\\ubuntu-24.04-desktop-amd64.iso.tdm-part',
    total_bytes: 5900000000,
    downloaded_bytes: 1829000000,
    state: 'downloading',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 16,
    priority: 'normal',
    error_message: null,
    created_at: 'Today 10:40',
    updated_at: 'Today 10:40',
    speed_bps: 4200000,
    eta_seconds: 969,
  },
  {
    id: 'demo-3',
    filename: 'Big Buck Bunny 1080p.mp4',
    url: 'https://cdn.example.com/files/Big Buck Bunny 1080p.mp4',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\Big Buck Bunny 1080p.mp4',
    temp_path: 'C:\\Users\\User\\Downloads\\Big Buck Bunny 1080p.mp4.tdm-part',
    total_bytes: 420000000,
    downloaded_bytes: 268800000,
    state: 'downloading',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 11,
    priority: 'normal',
    error_message: null,
    created_at: 'Today 10:31',
    updated_at: 'Today 10:31',
    speed_bps: 890000,
    eta_seconds: 170,
  },
  {
    id: 'demo-4',
    filename: 'setup-vscode-x64.exe',
    url: 'https://cdn.example.com/files/setup-vscode-x64.exe',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\setup-vscode-x64.exe',
    temp_path: 'C:\\Users\\User\\Downloads\\setup-vscode-x64.exe.tdm-part',
    total_bytes: 96000000,
    downloaded_bytes: 0,
    state: 'queued',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 16,
    priority: 'normal',
    error_message: null,
    created_at: 'Today 10:20',
    updated_at: 'Today 10:20',
  },
  {
    id: 'demo-5',
    filename: 'photos-2026.zip',
    url: 'https://cdn.example.com/files/photos-2026.zip',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\photos-2026.zip',
    temp_path: 'C:\\Users\\User\\Downloads\\photos-2026.zip.tdm-part',
    total_bytes: 820000000,
    downloaded_bytes: 336200000,
    state: 'paused',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 16,
    priority: 'normal',
    error_message: null,
    created_at: 'Yesterday',
    updated_at: 'Yesterday',
  },
  {
    id: 'demo-6',
    filename: 'project-assets.zip',
    url: 'https://cdn.example.com/files/project-assets.zip',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\project-assets.zip',
    temp_path: 'C:\\Users\\User\\Downloads\\project-assets.zip.tdm-part',
    total_bytes: 820000000,
    downloaded_bytes: 820000000,
    state: 'completed',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 16,
    priority: 'normal',
    error_message: null,
    created_at: 'Yesterday',
    updated_at: 'Yesterday',
  },
  {
    id: 'demo-7',
    filename: 'lecture-recording.mp3',
    url: 'https://cdn.example.com/files/lecture-recording.mp3',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\lecture-recording.mp3',
    temp_path: 'C:\\Users\\User\\Downloads\\lecture-recording.mp3.tdm-part',
    total_bytes: 48000000,
    downloaded_bytes: 48000000,
    state: 'completed',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 8,
    priority: 'normal',
    error_message: null,
    created_at: 'Mon 09:12',
    updated_at: 'Mon 09:12',
  },
  {
    id: 'demo-8',
    filename: 'annual-report.pdf',
    url: 'https://cdn.example.com/files/annual-report.pdf',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\annual-report.pdf',
    temp_path: 'C:\\Users\\User\\Downloads\\annual-report.pdf.tdm-part',
    total_bytes: 12400000,
    downloaded_bytes: 12400000,
    state: 'completed',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 4,
    priority: 'normal',
    error_message: null,
    created_at: 'Mon 08:50',
    updated_at: 'Mon 08:50',
  },
];

export function App() {
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const windowMode = urlParams.get('window');
  const windowJobId = urlParams.get('id');

  if (windowMode === 'toast' || windowMode === 'progress') {
    return <DownloadToast initialId={windowJobId || undefined} />;
  }

  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentCategory, setCurrentCategory] = useState<CategoryKey>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [settings, setSettings] = useState<AppSettings>(() => {
    const s = loadStoredSettings();
    const urlAccent = urlParams.get('accent');
    if (urlAccent && ['indigo', 'ocean', 'emerald', 'rose'].includes(urlAccent)) {
      s.accent = urlAccent as AppSettings['accent'];
    }
    const urlTheme = urlParams.get('theme');
    if (urlTheme && ['light', 'dark', 'system'].includes(urlTheme)) {
      s.theme = urlTheme as AppSettings['theme'];
    }
    return s;
  });
  const [isExtensionConnected, setIsExtensionConnected] = useState(false);

  // Modals & popups
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [progressJobId, setProgressJobId] = useState<string | null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('modal') === 'settings';
    } catch {
      return false;
    }
  });
  const [deleteConfirmJob, setDeleteConfirmJob] = useState<DownloadJob | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    job: DownloadJob;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2400);
  }, []);

  // Sync theme and accent with document element
  useEffect(() => {
    const applyTheme = () => {
      const isDark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
      document.documentElement.dataset.accent = settings.accent || 'indigo';
    };

    applyTheme();
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      if (settings.theme === 'system') applyTheme();
    };
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [settings.theme, settings.accent]);

  // Persist settings to localStorage and push to Rust backend engine
  const handleUpdateSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    try {
      localStorage.setItem('tori_settings_v2', JSON.stringify(newSettings));
    } catch (err) {
      console.error('Failed to store settings:', err);
    }
    invoke('update_engine_settings', { settings: newSettings }).catch((err) => {
      console.error('Failed to push settings to Rust engine:', err);
    });
  };

  // Synchronize settings with Rust backend on startup
  useEffect(() => {
    const syncSettings = async () => {
      try {
        const backendSettings = await invoke<AppSettings | null>('get_engine_settings');
        if (backendSettings) {
          setSettings((prev) => {
            const merged = { ...prev, ...backendSettings };
            try {
              localStorage.setItem('tori_settings_v2', JSON.stringify(merged));
            } catch {
              // ignore
            }
            return merged;
          });
        } else {
          await invoke('update_engine_settings', { settings });
        }
      } catch (err) {
        console.error('Failed to sync engine settings:', err);
      }
    };
    syncSettings();
  }, []);

  // Load downloads from SQLite backend (strictly real data; demo items only if explicitly ?demo=1)
  const loadDownloads = useCallback(async () => {
    if (urlParams.get('demo') === '1') {
      setDownloads(DEMO_DOWNLOADS);
      setSelectedId((prev) => (prev ? prev : DEMO_DOWNLOADS[0].id));
      return;
    }
    try {
      const list = await invoke<DownloadJob[]>('list_downloads');
      setDownloads(list || []);
      setSelectedId((prev) => (prev ? prev : list && list.length > 0 ? list[0].id : null));
    } catch (err) {
      console.error('Failed to load downloads from SQLite:', err);
      setDownloads([]);
    }
  }, [urlParams]);

  // Initial setup: downloads, default download folder, extension check
  useEffect(() => {
    loadDownloads();

    invoke<string>('get_default_download_dir')
      .then((dir) => {
        if (dir) {
          setSettings((prev) => ({ ...prev, dir }));
        }
      })
      .catch((err) => console.error('Failed to get default dir:', err));

    const checkExt = () => {
      invoke<boolean>('check_extension_status')
        .then((status) => setIsExtensionConnected(!!status))
        .catch(() => setIsExtensionConnected(false));
    };
    checkExt();
    const extInterval = setInterval(checkExt, 8000);

    // Listen to real-time events from Rust engine EventBus
    const unlistenPromise = listen<DownloadEvent>('download-event', (event) => {
      const payload = event.payload;

      if (payload.type === 'Progress') {
        const p = payload.payload;
        setDownloads((prev) => {
          const exists = prev.some((j) => j.id === p.id);
          if (!exists) {
            loadDownloads();
            return prev;
          }
          return prev.map((job) => {
            if (job.id === p.id) {
              return {
                ...job,
                downloaded_bytes: p.downloaded_bytes,
                total_bytes: p.total_bytes ?? job.total_bytes,
                speed_bps: p.speed_bps,
                eta_seconds: p.eta_seconds,
                state: p.state,
                error_message: p.error_message ?? job.error_message,
              };
            }
            return job;
          });
        });
      } else if (payload.type === 'StateChanged') {
        const sc = payload.payload;
        setDownloads((prev) => {
          const exists = prev.some((j) => j.id === sc.id);
          if (!exists) {
            loadDownloads();
            return prev;
          }
          return prev.map((job) => {
            if (job.id === sc.id) {
              return {
                ...job,
                state: sc.state,
                error_message: sc.error,
                speed_bps:
                  sc.state === 'completed' || sc.state === 'paused'
                    ? 0
                    : job.speed_bps,
              };
            }
            return job;
          });
        });

        if (sc.state === 'completed' || sc.state === 'failed' || sc.state === 'downloading') {
          loadDownloads();
        }
      }
    });

    return () => {
      clearInterval(extInterval);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [loadDownloads]);

  // Selected download reference
  const selectedJob = useMemo(() => {
    return downloads.find((d) => d.id === selectedId) || null;
  }, [downloads, selectedId]);

  // Filtered downloads for current category & search
  const filteredDownloads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return downloads.filter((d) => {
      // Category filter
      let matchesCategory = false;
      if (currentCategory === 'all') {
        matchesCategory = true;
      } else if (currentCategory === 'unf') {
        matchesCategory = d.state !== 'completed';
      } else if (currentCategory === 'fin') {
        matchesCategory = d.state === 'completed';
      } else {
        matchesCategory = typeOfJob(d) === currentCategory;
      }

      // Search filter
      const matchesSearch =
        !q ||
        d.filename.toLowerCase().includes(q) ||
        d.url.toLowerCase().includes(q);

      return matchesCategory && matchesSearch;
    });
  }, [downloads, currentCategory, searchQuery]);

  // Actions
  const handleAddUrls = async (
    urls: string[],
    dir: string,
    _connections: number,
    startImmediately: boolean
  ) => {
    let createdCount = 0;
    for (const url of urls) {
      try {
        const job = await invoke<DownloadJob>('create_download', {
          url,
          destination: dir || null,
          priority: 'normal',
        });
        createdCount++;

        if (!startImmediately) {
          await invoke('pause_download', { id: job.id });
        }
      } catch (err) {
        showToast(`Error adding ${url}: ${String(err)}`);
      }
    }

    await loadDownloads();
    showToast(`Added ${createdCount} download(s)`);
  };

  const handleTogglePause = async (job: DownloadJob) => {
    try {
      if (job.state === 'downloading' || job.state === 'probing') {
        await invoke('pause_download', { id: job.id });
        showToast(`Paused ${job.filename}`);
      } else {
        await invoke('resume_download', { id: job.id });
        showToast(`Resumed ${job.filename}`);
      }
    } catch (err) {
      showToast(`Action failed: ${String(err)}`);
    }
  };

  const handleCancel = async (job: DownloadJob) => {
    try {
      await invoke('cancel_download', { id: job.id });
      showToast(`Cancelled ${job.filename}`);
    } catch (err) {
      showToast(`Cancel failed: ${String(err)}`);
    }
  };

  const handleOpenProgress = async (job: DownloadJob) => {
    try {
      await invoke('open_progress_window', { id: job.id });
    } catch {
      setProgressJobId(job.id);
    }
  };

  const handleStopAll = async () => {
    const active = downloads.filter(
      (d) => d.state === 'downloading' || d.state === 'probing'
    );
    for (const job of active) {
      try {
        await invoke('pause_download', { id: job.id });
      } catch (err) {
        console.error(err);
      }
    }
    showToast(`Stopped all active downloads`);
  };

  const handleStartQueue = async () => {
    const paused = downloads.filter(
      (d) => d.state === 'paused' || d.state === 'queued'
    );
    for (const job of paused) {
      try {
        await invoke('resume_download', { id: job.id });
      } catch (err) {
        console.error(err);
      }
    }
    showToast(`Started download queue`);
  };

  const handleDelete = async (job: DownloadJob, deleteFiles: boolean) => {
    try {
      await invoke('delete_download', { id: job.id, deleteFiles });
      setDownloads((prev) => prev.filter((d) => d.id !== job.id));
      if (selectedId === job.id) {
        setSelectedId(null);
      }
      showToast(`Deleted ${job.filename}`);
    } catch (err) {
      showToast(`Delete failed: ${String(err)}`);
    }
  };

  const handleRetry = async (job: DownloadJob) => {
    try {
      await invoke('retry_download', { id: job.id });
      showToast(`Restarted ${job.filename}`);
    } catch (err) {
      showToast(`Retry failed: ${String(err)}`);
    }
  };

  const handleOpenFile = async (path: string) => {
    try {
      await invoke('open_file', { path });
    } catch (err) {
      showToast(`Could not open file: ${String(err)}`);
    }
  };

  const handleOpenFolder = async (path: string) => {
    try {
      await invoke('open_folder', { path });
    } catch (err) {
      showToast(`Could not open folder: ${String(err)}`);
    }
  };

  const handleVerifyChecksum = async (path: string) => {
    showToast('Calculating SHA-256 checksum...');
    try {
      const hash = await invoke<string>('verify_checksum', { path });
      showToast(`SHA-256: ${hash.substring(0, 16)}...`);
    } catch (err) {
      showToast(`Checksum error: ${String(err)}`);
    }
  };

  const handleCopyUrl = (url: string) => {
    try {
      navigator.clipboard.writeText(url);
      showToast('Address copied to clipboard');
    } catch {
      showToast('Could not copy to clipboard');
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsAddModalOpen(false);
        setProgressJobId(null);
        setIsSettingsModalOpen(false);
        setDeleteConfirmJob(null);
        setContextMenu(null);
        return;
      }

      if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName)) {
        return;
      }

      const list = filteredDownloads;
      const currentIndex = list.findIndex((x) => x.id === selectedId);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentIndex < list.length - 1) {
          setSelectedId(list[currentIndex + 1].id);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentIndex > 0) {
          setSelectedId(list[currentIndex - 1].id);
        }
      } else if (e.key === ' ' && selectedJob) {
        e.preventDefault();
        handleTogglePause(selectedJob);
      } else if (e.key === 'Delete' && selectedJob) {
        e.preventDefault();
        setDeleteConfirmJob(selectedJob);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredDownloads, selectedId, selectedJob]);

  const progressJob = useMemo(() => {
    return downloads.find((d) => d.id === progressJobId) || null;
  }, [downloads, progressJobId]);

  return (
    <div className="win" id="main">
      <TitleBar title="Tori Download Manager" />

      <ToolBar
        onAdd={() => setIsAddModalOpen(true)}
        onResume={() => selectedJob && handleTogglePause(selectedJob)}
        onPause={() => selectedJob && handleTogglePause(selectedJob)}
        onStopAll={handleStopAll}
        onDelete={() => selectedJob && setDeleteConfirmJob(selectedJob)}
        onStartQueue={handleStartQueue}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        hasSelection={!!selectedJob}
        selectedState={selectedJob?.state}
      />

      <div id="body">
        <SideBar
          currentCategory={currentCategory}
          onSelectCategory={setCurrentCategory}
          downloads={downloads}
        />

        <DownloadTable
          downloads={filteredDownloads}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpenProgress={handleOpenProgress}
          onContextMenu={(e, job) => {
            e.preventDefault();
            setSelectedId(job.id);
            setContextMenu({ x: e.clientX, y: e.clientY, job });
          }}
        />
      </div>

      <StatusBar
        downloads={downloads}
        isExtensionConnected={isExtensionConnected}
        statusMessage={toastMessage}
      />

      {/* ================= MODALS & POPUPS ================= */}
      {isAddModalOpen && (
        <AddDownloadModal
          defaultDir={settings.dir}
          defaultConnections={settings.con}
          onClose={() => setIsAddModalOpen(false)}
          onSubmit={handleAddUrls}
        />
      )}

      {progressJob && (
        <ProgressModal
          job={progressJob}
          onClose={() => setProgressJobId(null)}
          onTogglePause={handleTogglePause}
          onCancel={handleCancel}
          onOpenFile={handleOpenFile}
        />
      )}

      {isSettingsModalOpen && (
        <SettingsModal
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          onClose={() => setIsSettingsModalOpen(false)}
        />
      )}

      {deleteConfirmJob && (
        <DeleteConfirmModal
          job={deleteConfirmJob}
          onConfirm={handleDelete}
          onClose={() => setDeleteConfirmJob(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          job={contextMenu.job}
          onClose={() => setContextMenu(null)}
          onOpenProgress={handleOpenProgress}
          onTogglePause={handleTogglePause}
          onOpenFolder={handleOpenFolder}
          onOpenFile={handleOpenFile}
          onCopyUrl={handleCopyUrl}
          onRetry={handleRetry}
          onVerifyChecksum={handleVerifyChecksum}
          onDelete={(job) => setDeleteConfirmJob(job)}
        />
      )}

      {toastMessage && <div className="toast">{toastMessage}</div>}
    </div>
  );
}
export default App;
