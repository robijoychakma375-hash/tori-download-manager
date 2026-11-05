import React, { useState, useEffect, useMemo } from 'react';
import { TitleBar } from './TitleBar';
import type { PlaylistMetadata } from '../types';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

interface PlaylistModalProps {
  initialUrl?: string;
  defaultDir: string;
  onClose: () => void;
  onEnqueued?: (count: number) => void;
}

const DEMO_PLAYLIST: PlaylistMetadata = {
  id: 'PL6B3937A5D230E335',
  title: 'Official Blender Open Movies',
  webpage_url: 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335',
  thumbnail_url: 'https://i.ytimg.com/vi/WhWc3b3KhnY/hqdefault.jpg',
  extractor: 'youtube:tab',
  channel: 'Blender Studio',
  item_count: 5,
  items: [
    {
      id: 'l5OZu-IrXpw',
      title: 'SINGULARITY - Painterly Space Adventure',
      url: 'https://www.youtube.com/watch?v=l5OZu-IrXpw',
      duration_seconds: 391,
      thumbnail_url: 'https://i.ytimg.com/vi/l5OZu-IrXpw/hqdefault.jpg',
      channel: 'Blender Studio',
      index: 1,
    },
    {
      id: 'u9lj-c29dxI',
      title: 'WING IT! - Blender Open Movie',
      url: 'https://www.youtube.com/watch?v=u9lj-c29dxI',
      duration_seconds: 238,
      thumbnail_url: 'https://i.ytimg.com/vi/u9lj-c29dxI/hqdefault.jpg',
      channel: 'Blender Studio',
      index: 2,
    },
    {
      id: 'aqz-KE-bpKQ',
      title: 'Big Buck Bunny 4K 60fps',
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      duration_seconds: 596,
      thumbnail_url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
      channel: 'Blender Foundation',
      index: 3,
    },
    {
      id: 'eRsGyueVLvQ',
      title: 'Sintel - Open-Source Animated Film',
      url: 'https://www.youtube.com/watch?v=eRsGyueVLvQ',
      duration_seconds: 888,
      thumbnail_url: 'https://i.ytimg.com/vi/eRsGyueVLvQ/hqdefault.jpg',
      channel: 'Blender Foundation',
      index: 4,
    },
    {
      id: 'R6MlUcmOul8',
      title: 'Tears of Steel - Sci-Fi VFX Short Film',
      url: 'https://www.youtube.com/watch?v=R6MlUcmOul8',
      duration_seconds: 734,
      thumbnail_url: 'https://i.ytimg.com/vi/R6MlUcmOul8/hqdefault.jpg',
      channel: 'Blender Foundation',
      index: 5,
    },
  ],
};

function formatDuration(sec: number | null): string {
  if (sec == null || isNaN(sec) || sec <= 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export const PlaylistModal: React.FC<PlaylistModalProps> = ({
  initialUrl = '',
  defaultDir,
  onClose,
  onEnqueued,
}) => {
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [playlist, setPlaylist] = useState<PlaylistMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchFilter, setSearchFilter] = useState('');
  const [formatId, setFormatId] = useState('best');
  const [saveDir, setSaveDir] = useState(defaultDir);
  const [submitting, setSubmitting] = useState(false);

  // Check URL query parameters for demo mode
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('demo') === '1' && (sp.get('modal') === 'playlist' || !initialUrl)) {
        setPlaylist(DEMO_PLAYLIST);
        setSelectedIds(new Set(DEMO_PLAYLIST.items.map((i) => i.id)));
        return;
      }
    } catch {}

    if (initialUrl.trim()) {
      handleResolve(initialUrl.trim());
    }
  }, [initialUrl]);

  const handleResolve = async (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<PlaylistMetadata>('resolve_playlist', {
        url: targetUrl.trim(),
        limit: 100,
      });
      setPlaylist(res);
      setSelectedIds(new Set(res.items.map((i) => i.id)));
    } catch (err: unknown) {
      console.error('Failed to resolve playlist:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggleSelectAll = () => {
    if (!playlist) return;
    if (selectedIds.size === playlist.items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(playlist.items.map((i) => i.id)));
    }
  };

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const filteredItems = useMemo(() => {
    if (!playlist) return [];
    const q = searchFilter.trim().toLowerCase();
    if (!q) return playlist.items;
    return playlist.items.filter((item) =>
      item.title.toLowerCase().includes(q)
    );
  }, [playlist, searchFilter]);

  const handleEnqueue = async () => {
    if (!playlist || selectedIds.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const selectedItems = playlist.items
        .filter((item) => selectedIds.has(item.id))
        .map((item) => ({
          url: item.url,
          title: item.title,
          thumbnail_url: item.thumbnail_url,
        }));

      const createdIds = await invoke<string[]>('enqueue_playlist_items', {
        items: selectedItems,
        destination: saveDir || null,
        formatId: formatId || 'best',
      });

      if (onEnqueued) {
        onEnqueued(createdIds.length);
      }
      onClose();
    } catch (err: unknown) {
      console.error('Failed to enqueue playlist items:', err);
      setError(String(err));
      setSubmitting(false);
    }
  };

  return (
    <>
      <div id="dim" onClick={onClose} />
      <div
        className="win pop"
        id="playlist-modal"
        style={{
          width: 660,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface-2, #18181b)',
          border: '1px solid var(--border-subtle, #27272a)',
          borderRadius: '12px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          zIndex: 60,
        }}
      >
        <TitleBar title="Download Playlist" onClose={onClose} isModal />

        <div style={{ padding: '16px 20px', flex: 1, overflowY: 'auto' }}>
          {error && (
            <div
              className="bad"
              style={{
                marginBottom: 12,
                padding: '8px 12px',
                borderRadius: 6,
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {/* URL Input Bar if no playlist resolved yet */}
          {!playlist && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--txt, #f4f4f5)', marginBottom: 6 }}>
                Enter Playlist Address:
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="in"
                  style={{ flex: 1 }}
                  placeholder="https://www.youtube.com/playlist?list=..."
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleResolve(urlInput)}
                  autoFocus
                />
                <button
                  className="btn def"
                  onClick={() => handleResolve(urlInput)}
                  disabled={loading || !urlInput.trim()}
                >
                  {loading ? 'Resolving...' : 'Fetch Playlist'}
                </button>
              </div>
            </div>
          )}

          {loading && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px 0',
                gap: 12,
                color: 'var(--txt-muted, #a1a1aa)',
                fontSize: 13,
              }}
            >
              <div className="spinner" style={{ width: 28, height: 28 }} />
              <div>Fetching playlist information and video entries...</div>
            </div>
          )}

          {/* Playlist Metadata Header */}
          {playlist && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '10px 14px',
                  background: 'var(--surface-1, #27272a)',
                  borderRadius: 8,
                  marginBottom: 14,
                }}
              >
                {playlist.thumbnail_url ? (
                  <img
                    src={playlist.thumbnail_url}
                    alt={playlist.title}
                    style={{
                      width: 52,
                      height: 38,
                      borderRadius: 4,
                      objectFit: 'cover',
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 52,
                      height: 38,
                      borderRadius: 4,
                      background: 'rgba(255,255,255,0.08)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--accent, #6366f1)',
                      flexShrink: 0,
                    }}
                  >
                    ▶
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: 'var(--txt, #f4f4f5)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={playlist.title}
                  >
                    {playlist.title}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--txt-muted, #a1a1aa)',
                      marginTop: 2,
                    }}
                  >
                    {playlist.channel ? `${playlist.channel} • ` : ''}
                    {playlist.items.length} {playlist.items.length === 1 ? 'video' : 'videos'}
                  </div>
                </div>
              </div>

              {/* Action Toolbar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 10,
                  flexWrap: 'wrap',
                }}
              >
                <input
                  className="in"
                  style={{ flex: 1, minWidth: 140, height: 30, fontSize: 12 }}
                  placeholder="Filter videos..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                />

                <button
                  className="btn"
                  style={{ height: 30, fontSize: 12, padding: '0 10px' }}
                  onClick={toggleSelectAll}
                >
                  {selectedIds.size === playlist.items.length ? 'Deselect All' : 'Select All'}
                </button>

                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--txt-muted, #a1a1aa)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Selected: <b style={{ color: 'var(--accent, #6366f1)' }}>{selectedIds.size}</b> / {playlist.items.length}
                </div>

                <select
                  className="in"
                  style={{ height: 30, fontSize: 12, padding: '0 8px' }}
                  value={formatId}
                  onChange={(e) => setFormatId(e.target.value)}
                >
                  <option value="best">Best Quality (MP4)</option>
                  <option value="1080p">1080p Full HD</option>
                  <option value="720p">720p HD</option>
                  <option value="480p">480p Standard</option>
                  <option value="audio_only">Audio Only (MP3)</option>
                </select>
              </div>

              {/* Scrollable Video List */}
              <div
                style={{
                  maxHeight: 240,
                  overflowY: 'auto',
                  border: '1px solid var(--border-subtle, #27272a)',
                  borderRadius: 6,
                  background: 'var(--surface-0, #121214)',
                  marginBottom: 14,
                }}
              >
                {filteredItems.length === 0 ? (
                  <div
                    style={{
                      padding: 20,
                      textAlign: 'center',
                      color: 'var(--txt-muted, #a1a1aa)',
                      fontSize: 12,
                    }}
                  >
                    No videos match your filter.
                  </div>
                ) : (
                  filteredItems.map((item) => {
                    const isSelected = selectedIds.has(item.id);
                    return (
                      <div
                        key={item.id}
                        onClick={() => toggleItem(item.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '6px 12px',
                          borderBottom: '1px solid var(--border-subtle, #27272a)',
                          background: isSelected ? 'rgba(99, 102, 241, 0.12)' : 'transparent',
                          cursor: 'pointer',
                          userSelect: 'none',
                          transition: 'background 0.15s ease',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}} // handled by parent div
                          style={{ cursor: 'pointer', accentColor: 'var(--accent, #6366f1)' }}
                        />

                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--txt-muted, #a1a1aa)',
                            width: 24,
                            textAlign: 'right',
                          }}
                        >
                          #{item.index}
                        </span>

                        {item.thumbnail_url ? (
                          <img
                            src={item.thumbnail_url}
                            alt=""
                            style={{
                              width: 36,
                              height: 22,
                              borderRadius: 3,
                              objectFit: 'cover',
                              flexShrink: 0,
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: 36,
                              height: 22,
                              borderRadius: 3,
                              background: 'rgba(255,255,255,0.05)',
                              flexShrink: 0,
                            }}
                          />
                        )}

                        <span
                          style={{
                            flex: 1,
                            fontSize: 12,
                            color: isSelected ? 'var(--txt, #f4f4f5)' : 'var(--txt-subtle, #d4d4d8)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={item.title}
                        >
                          {item.title}
                        </span>

                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--txt-muted, #a1a1aa)',
                            fontFamily: 'monospace',
                            flexShrink: 0,
                          }}
                        >
                          {formatDuration(item.duration_seconds)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Destination folder */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 16,
                  fontSize: 12,
                }}
              >
                <span style={{ color: 'var(--txt-muted, #a1a1aa)', width: 60 }}>Save to:</span>
                <input
                  className="in"
                  style={{ flex: 1, height: 28, fontSize: 12 }}
                  value={saveDir}
                  onChange={(e) => setSaveDir(e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  style={{ minWidth: 0, height: 28, padding: '0 10px', fontSize: 12 }}
                  onClick={async () => {
                    try {
                      const selected = await open({
                        directory: true,
                        multiple: false,
                        defaultPath: saveDir && saveDir.trim() !== '' ? saveDir : undefined,
                      });
                      if (selected && typeof selected === 'string') {
                        setSaveDir(selected);
                      }
                    } catch (err) {
                      console.error('Failed to select directory via native dialog:', err);
                    }
                  }}
                >
                  Choose…
                </button>
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '12px 20px',
            background: 'var(--surface-1, #202024)',
            borderTop: '1px solid var(--border-subtle, #27272a)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
          }}
        >
          <button className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          {playlist && (
            <button
              className="btn def"
              onClick={handleEnqueue}
              disabled={submitting || selectedIds.size === 0}
            >
              {submitting
                ? 'Queueing...'
                : `Download Selected (${selectedIds.size})`}
            </button>
          )}
        </div>
      </div>
    </>
  );
};
