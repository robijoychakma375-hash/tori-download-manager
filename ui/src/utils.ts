import type { DownloadJob } from './types';

const TY_MAP: Record<string, string> = {
  dmg: 'Programs',
  exe: 'Programs',
  msi: 'Programs',
  bat: 'Programs',
  cmd: 'Programs',
  sh: 'Programs',
  apk: 'Programs',
  iso: 'Compressed',
  zip: 'Compressed',
  rar: 'Compressed',
  '7z': 'Compressed',
  tar: 'Compressed',
  gz: 'Compressed',
  bz2: 'Compressed',
  xz: 'Compressed',
  mp4: 'Video',
  mkv: 'Video',
  webm: 'Video',
  mov: 'Video',
  avi: 'Video',
  flv: 'Video',
  wmv: 'Video',
  m4v: 'Video',
  ts: 'Video',
  mp3: 'Music',
  m4a: 'Music',
  aac: 'Music',
  flac: 'Music',
  ogg: 'Music',
  opus: 'Music',
  wav: 'Music',
  pdf: 'Documents',
  doc: 'Documents',
  docx: 'Documents',
  xls: 'Documents',
  xlsx: 'Documents',
  ppt: 'Documents',
  pptx: 'Documents',
  txt: 'Documents',
  csv: 'Documents',
  md: 'Documents',
};

export function typeOfJob(job: DownloadJob): string {
  if (job.job_type === 'live_stream' || job.job_type === 'hls_vod' || job.job_type === 'dash_vod') {
    return 'Video';
  }
  const ext = job.filename.split('.').pop()?.toLowerCase() || '';
  return TY_MAP[ext] || 'Other';
}

export function getChipSrc(category: string): string {
  switch (category) {
    case 'all':
      return '/icons/chips/all-downloads.svg';
    case 'unf':
      return '/icons/chips/unfinished.svg';
    case 'fin':
      return '/icons/chips/finished.svg';
    case 'Video':
      return '/icons/chips/video.svg';
    case 'Music':
      return '/icons/chips/music.svg';
    case 'Compressed':
      return '/icons/chips/compressed.svg';
    case 'Programs':
      return '/icons/chips/programs.svg';
    case 'Documents':
      return '/icons/chips/documents.svg';
    default:
      return '/icons/chips/other.svg';
  }
}

export function fmtB(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes) || bytes < 0) return 'Unknown';
  if (bytes >= 1e9) {
    return (bytes / 1e9).toFixed(2) + ' GB';
  }
  if (bytes >= 1e6) {
    return (bytes / 1e6).toFixed(1) + ' MB';
  }
  if (bytes >= 1e3) {
    return (bytes / 1e3).toFixed(0) + ' KB';
  }
  return bytes + ' B';
}

export function fmtSp(bps: number | undefined): string {
  if (!bps || bps <= 0) return '';
  if (bps >= 1e6) {
    return (bps / 1e6).toFixed(2) + ' MB/s';
  }
  return Math.round(bps / 1e3) + ' KB/s';
}

export function fmtT(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '--';
  const s = Math.floor(seconds);
  if (s >= 3600) {
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    return `${hrs} hr ${mins} min`;
  }
  if (s >= 60) {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins} min ${secs} sec`;
  }
  return `${s} sec`;
}

export function formatAdded(isoDate: string): string {
  if (!isoDate) return '';
  if (
    isoDate.startsWith('Today') ||
    isoDate.startsWith('Yesterday') ||
    isoDate.startsWith('Mon') ||
    isoDate.startsWith('Tue') ||
    isoDate.startsWith('Wed') ||
    isoDate.startsWith('Thu') ||
    isoDate.startsWith('Fri') ||
    isoDate.startsWith('Sat') ||
    isoDate.startsWith('Sun')
  ) {
    return isoDate;
  }
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return isoDate;
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();

    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    if (isToday) {
      return `Today ${timeStr}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();

    if (isYesterday) {
      return `Yesterday`;
    }

    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return isoDate;
  }
}

export function stateLabel(state: string): string {
  switch (state) {
    case 'downloading':
      return 'Downloading';
    case 'paused':
      return 'Paused';
    case 'queued':
      return 'Queued';
    case 'completed':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'probing':
      return 'Probing';
    case 'verifying':
      return 'Verifying';
    case 'pausing':
      return 'Pausing';
    default:
      return state;
  }
}

