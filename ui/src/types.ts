export type JobState =
  | 'created'
  | 'probing'
  | 'queued'
  | 'scheduled'
  | 'downloading'
  | 'pausing'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JobType = 'http_file' | 'hls_vod' | 'dash_vod' | 'torrent' | 'live_stream' | 'managed_media';

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
  scheduled_at?: string | null;
  thumbnail_url?: string | null;
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

export interface DownloadStatusDetails {
  id: string;
  active_connections: number;
  max_connections: number;
  chunks: ChunkRecord[];
  global_speed_limit_bps: number;
  job_speed_limit_bps: number;
}

export interface DownloadCompletionOptions {
  close_on_complete: boolean;
  notify_on_complete: boolean;
  open_on_complete: boolean;
}

export type DownloadEvent =
  | { type: 'Progress'; payload: DownloadProgress }
  | { type: 'StateChanged'; payload: { id: string; state: JobState; error: string | null } }
  | { type: 'Deleted'; payload: { id: string } }
  | { type: 'ShowWindow' }
  | { type: 'HideWindow' }
  | { type: 'OpenProgressWindow'; payload: { id: string } }
  | { type: 'OpenPlaylistModal'; payload: { url: string } };

export interface PendingPlaylistRequest {
  request_id: string;
  url: string;
}

export type CategoryKey =
  | 'all'
  | 'unf'
  | 'fin'
  | 'Video'
  | 'Music'
  | 'Compressed'
  | 'Programs'
  | 'Documents';

export interface CategoryCounts {
  all: number;
  unf: number;
  fin: number;
  Video: number;
  Music: number;
  Compressed: number;
  Programs: number;
  Documents: number;
}

export type SortField = 'filename' | 'size' | 'status' | 'eta' | 'speed' | 'date';
export type SortDirection = 'asc' | 'desc';

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
  showDownloadPopup?: 'always' | 'on_start' | 'never';
  alwaysOnTop?: boolean;
  closeToTray?: boolean;
  autoCheckUpdates?: boolean;
  lastUpdateCheck?: number;
  remindLaterUntil?: number;
}

export interface PlaylistItem {
  id: string;
  title: string;
  url: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  channel: string | null;
  index: number;
  is_available?: boolean | null;
}

export interface PlaylistMetadata {
  id: string;
  title: string;
  webpage_url: string;
  thumbnail_url: string | null;
  extractor: string;
  channel: string | null;
  item_count: number;
  items: PlaylistItem[];
}

export interface ResolvedMediaFormat {
  format_id: string;
  format_note?: string | null;
  width?: number | null;
  height?: number | null;
  resolution_label: string;
  fps?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  container: string;
  protocol: string;
  bitrate_kbps?: number | null;
  has_video: boolean;
  has_audio: boolean;
  filesize?: number | null;
  filesize_approx?: number | null;
  filesize_type: 'exact' | 'estimated' | 'unknown';
  requires_merge: boolean;
  merge_audio_format_id?: string | null;
}

export interface MediaMetadata {
  source_url: string;
  webpage_url: string;
  site_name: string;
  title: string;
  media_id: string;
  duration_seconds?: number | null;
  thumbnail_url?: string | null;
  extractor: string;
  formats: ResolvedMediaFormat[];
  is_direct_media: boolean;
}

export type ExternalToolId = 'yt-dlp' | 'ffmpeg' | 'ffprobe';

export type ExternalToolUpdateStatus =
  | 'up_to_date'
  | 'checking'
  | 'update_available'
  | 'downloading'
  | 'verifying'
  | 'testing'
  | 'pending_activation'
  | 'installing'
  | 'updated'
  | 'update_failed'
  | 'rolled_back'
  | 'source_untrusted';

export interface ExternalToolsSettings {
  auto_update: boolean;
  check_interval_hours: number;
  auto_install: boolean;
  notify_on_update: boolean;
  defer_while_in_use: boolean;
}

export interface ExternalToolRecord {
  tool_id: ExternalToolId;
  display_name: string;
  installed_version: string | null;
  available_version: string | null;
  active_binary_path: string | null;
  source: string;
  platform: string;
  architecture: string;
  artifact_sha256: string | null;
  installed_at: string | null;
  last_checked_at: string | null;
  last_updated_at: string | null;
  last_successful_version: string | null;
  update_status: ExternalToolUpdateStatus;
  last_error: string | null;
  rollback_available: boolean;
  rollback_version: string | null;
  rollback_binary_path: string | null;
  pending_version: string | null;
  pending_binary_path: string | null;
  failed_versions: string[];
}

export interface ExternalToolHistoryEntry {
  id: number;
  tool_id: string;
  action: string;
  from_version: string | null;
  to_version: string | null;
  status: string;
  source: string | null;
  artifact_sha256: string | null;
  trust_level: string | null;
  message: string | null;
  created_at: string;
}

export interface ExternalToolsSchedulerState {
  last_successful_check_at: string | null;
  last_attempt_at: string | null;
  consecutive_failures: number;
  next_retry_after: string | null;
  last_error: string | null;
}

export interface ExternalToolsSnapshot {
  tools: ExternalToolRecord[];
  settings: ExternalToolsSettings;
  scheduler: ExternalToolsSchedulerState;
  checking: boolean;
  active_yt_dlp_leases: number;
  active_ffmpeg_leases: number;
  active_ffprobe_leases: number;
}

export interface ExternalToolProgressEvent {
  tool_id: ExternalToolId;
  status: ExternalToolUpdateStatus;
  stage: string;
  downloaded_bytes: number;
  total_bytes: number | null;
  speed_bps: number;
  message: string | null;
}

export interface ExternalToolNotificationEvent {
  kind: string;
  tool_id: ExternalToolId;
  title: string;
  body: string;
  version: string | null;
  timestamp: string;
}
