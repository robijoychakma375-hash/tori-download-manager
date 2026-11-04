import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ProgressModal } from './ProgressModal';
import type { DownloadEvent, DownloadJob } from '../types';

interface ProgressWindowProps {
  id: string;
}

export const ProgressWindow: React.FC<ProgressWindowProps> = ({ id }) => {
  const [job, setJob] = useState<DownloadJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchJob = useCallback(async () => {
    try {
      const res = await invoke<DownloadJob | null>('get_download', { id });
      if (res) {
        setJob(res);
      } else {
        setError(`Download with ID ${id} not found.`);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [id]);

  useEffect(() => {
    fetchJob();

    const unlistenPromise = listen<DownloadEvent>('download-event', (event) => {
      const payload = event.payload;
      if (payload.type === 'Progress') {
        const prog = payload.payload;
        if (prog.id === id) {
          setJob((prev) =>
            prev
              ? {
                  ...prev,
                  downloaded_bytes: prog.downloaded_bytes,
                  total_bytes: prog.total_bytes ?? prev.total_bytes,
                  speed_bps: prog.speed_bps,
                  eta_seconds: prog.eta_seconds,
                  state: prog.state,
                }
              : prev
          );
        }
      } else if (payload.type === 'StateChanged') {
        const { id: changedId, state: newState } = payload.payload;
        if (changedId === id) {
          setJob((prev) => (prev ? { ...prev, state: newState } : prev));
        }
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [id, fetchJob]);

  const handleTogglePause = async (targetJob: DownloadJob) => {
    try {
      if (targetJob.state === 'downloading' || targetJob.state === 'probing') {
        await invoke('pause_download', { id: targetJob.id });
      } else {
        await invoke('resume_download', { id: targetJob.id });
      }
    } catch (err) {
      console.error('Failed to toggle pause:', err);
    }
  };

  const handleCancel = async (targetJob: DownloadJob) => {
    try {
      await invoke('cancel_download', { id: targetJob.id });
      await invoke('window_close');
    } catch (err) {
      console.error('Failed to cancel download:', err);
    }
  };

  const handleClose = async () => {
    try {
      await invoke('window_close');
    } catch (err) {
      console.error('Failed to close progress window:', err);
    }
  };

  const handleOpenFile = async (path: string) => {
    try {
      await invoke('open_file', { path });
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  if (error) {
    return (
      <div style={{ padding: 24, color: '#f87171', fontFamily: 'sans-serif' }}>
        <h3>Error loading download</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (!job) {
    return (
      <div style={{ padding: 24, color: '#888', fontFamily: 'sans-serif' }}>
        Loading download progress...
      </div>
    );
  }

  return (
    <ProgressModal
      job={job}
      onClose={handleClose}
      onTogglePause={handleTogglePause}
      onCancel={handleCancel}
      onOpenFile={handleOpenFile}
      standalone={true}
    />
  );
};
