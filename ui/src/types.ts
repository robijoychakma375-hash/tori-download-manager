export type JobState =
  | 'created'
  | 'probing'
  | 'queued'
  | 'downloading'
  | 'pausing'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JobType = 'http_file' | 'hls_vod' | 'dash_vod' | 'torrent' | 'live_stream';

export interface DownloadJob {
  id: string;
  url: string;
  resolved_url: string | null;
  filename: string;
  target_path: string;
  temp_path: string;
  total_bytes: number | null;
  downloaded_bytes: number;
  state: JobState;
  job_type: JobType;
  etag: string | null;
  last_modified: string | null;
  is_resumable: boolean;
  chunk_count: number;
  priority: 'high' | 'normal' | 'low';
  error_message: string | null;
  created_at: string;
  updated_at: string;
  // Transient UI metrics
  speed_bps?: number;
  eta_seconds?: number | null;
}

export interface ChunkRecord {
  id: number | null;
  download_id: string;
  chunk_index: number;
  start_byte: number;
  end_byte: number;
  written_bytes: number;
  is_complete: boolean;
}

export interface DownloadProgress {
  id: string;
  downloaded_bytes: number;
  total_bytes: number | null;
  speed_bps: number;
  eta_seconds: number | null;
  state: JobState;
  error_message: string | null;
}

export type DownloadEvent =
  | { type: 'Progress'; payload: DownloadProgress }
  | { type: 'StateChanged'; payload: { id: string; state: JobState; error: string | null } }
  | { type: 'ShowWindow' }
  | { type: 'OpenProgressWindow'; payload: { id: string } };

export type CategoryKey =
  | 'all'
  | 'unf'
  | 'fin'
  | 'Video'
  | 'Music'
  | 'Compressed'
  | 'Programs'
  | 'Documents';

export interface AppSettings {
  dir: string;
  sort: boolean;
  con: number;
  maxa: number;
  limMode: 'off' | 'on';
  limV: number;
  limU: 'KiB/s' | 'MiB/s';
  retries: number;
  dyn: boolean;
  mps: number;
  mpsU: 'KiB' | 'MiB';
  ua: string;
  ssl: boolean;
  lm: boolean;
  track: boolean;
  dns: string;
  proxy?: string;
  port?: number;
  key?: string;
  cap?: boolean;
  theme: 'light' | 'dark' | 'system';
  accent?: 'indigo' | 'ocean' | 'emerald' | 'rose';
  motion: boolean;
  details?: boolean;
}
