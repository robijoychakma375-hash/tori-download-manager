import { check, Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';

export interface UpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'up_to_date'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'error'
    | 'blocked_active_downloads';
  currentVersion: string;
  newVersion?: string;
  releaseDate?: string;
  releaseNotes?: string;
  downloadedBytes: number;
  totalBytes: number;
  errorMessage?: string;
  activeDownloadsCount?: number;
}

export async function fetchAppVersion(): Promise<string> {
  try {
    return await invoke<string>('get_app_version');
  } catch {
    return '1.0.4';
  }
}

export async function fetchThirdPartyLicenses(): Promise<string> {
  try {
    return await invoke<string>('get_third_party_licenses');
  } catch (e) {
    return `Failed to load licenses: ${String(e)}`;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  try {
    await invoke('open_external_url', { url });
  } catch (e) {
    console.error('Failed to open URL:', e);
    window.open(url, '_blank');
  }
}

export async function getActiveDownloadsCount(): Promise<number> {
  try {
    return await invoke<number>('get_active_downloads_count');
  } catch {
    return 0;
  }
}

let activeUpdateHandle: Update | null = null;

export function getActiveUpdateHandle(): Update | null {
  return activeUpdateHandle;
}

export async function checkForUpdate(): Promise<{
  available: boolean;
  update: Update | null;
  error?: string;
}> {
  try {
    const update = await check();
    activeUpdateHandle = update;
    if (update) {
      return { available: true, update };
    }
    return { available: false, update: null };
  } catch (err: unknown) {
    const errStr = String(err);
    console.warn('Update check failed:', errStr);
    return {
      available: false,
      update: null,
      error:
        errStr.includes('Failed to fetch') ||
        errStr.includes('network') ||
        errStr.includes('connect') ||
        errStr.includes('dns')
          ? 'Unable to reach update server. Check your network connection or verify update endpoint.'
          : `Update check error: ${errStr}`,
    };
  }
}

export async function downloadUpdate(
  update: Update,
  onProgress: (downloaded: number, total: number) => void
): Promise<void> {
  let downloaded = 0;
  let total = 0;

  await update.download((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength || 0;
      onProgress(0, total);
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength;
      onProgress(downloaded, total);
    } else if (event.event === 'Finished') {
      onProgress(downloaded, total);
    }
  });
}

export async function installUpdateSafe(
  update: Update
): Promise<{ success: boolean; activeDownloads?: number; error?: string }> {
  const activeCount = await getActiveDownloadsCount();
  if (activeCount > 0) {
    return {
      success: false,
      activeDownloads: activeCount,
      error: `Cannot install update while ${activeCount} download(s) are actively downloading.`,
    };
  }

  try {
    await update.install();
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

