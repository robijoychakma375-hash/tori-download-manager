import React, { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TitleBar } from './TitleBar';
import type { MediaMetadata } from '../types';
import { isMediaPageUrl, isPlaylistUrl, fmtB, fmtT } from '../utils';

interface AddDownloadModalProps {
  defaultDir: string;
  defaultConnections: number;
  onClose: () => void;
  onSubmit: (urls: string[], dir: string, connections: number, startImmediately: boolean) => Promise<void>;
  onSubmitMedia?: (args: {
    url: string;
    formatId: string;
    filename: string;
    destination: string;
    startImmediately: boolean;
    thumbnailUrl?: string | null;
  }) => Promise<void>;
  onOpenPlaylist?: (url: string) => void;
}

export const AddDownloadModal: React.FC<AddDownloadModalProps> = ({
  defaultDir,
  defaultConnections,
  onClose,
  onSubmit,
  onSubmitMedia,
  onOpenPlaylist,
}) => {
  const [urlText, setUrlText] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('url') || '';
    } catch {
      return '';
    }
  });
  const [saveDir, setSaveDir] = useState(defaultDir);
  const [connections, setConnections] = useState(defaultConnections);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Managed media state
  const [resolvedMedia, setResolvedMedia] = useState<MediaMetadata | null>(null);
  const [isResolvingMedia, setIsResolvingMedia] = useState(false);
  const [selectedFormatId, setSelectedFormatId] = useState<string>('best');
  const [customFilename, setCustomFilename] = useState<string>('');

  const trimmedUrl = urlText.trim();
  const isSingleLine = !trimmedUrl.includes('\n');
  const isMedia = isSingleLine && isMediaPageUrl(trimmedUrl);
  const hasPlaylist = isPlaylistUrl(trimmedUrl);
  const hasBoth = isMedia && hasPlaylist;

  // Asynchronously resolve media formats when a supported video page URL is entered
  useEffect(() => {
    if (!isMedia || !trimmedUrl) {
      setResolvedMedia(null);
      setIsResolvingMedia(false);
      return;
    }

    let active = true;
    setIsResolvingMedia(true);

    const timer = setTimeout(async () => {
      try {
        const meta = await invoke<MediaMetadata>('resolve_media', { url: trimmedUrl });
        if (active) {
          setResolvedMedia(meta);
          setIsResolvingMedia(false);
          if (meta.title && !customFilename) {
            setCustomFilename(`${meta.title}.mp4`);
          }
        }
      } catch (err: unknown) {
        if (active) {
          setIsResolvingMedia(false);
          console.warn('[TORI] Media resolve notice:', err);
        }
      }
    }, 350);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmedUrl, isMedia]);

  // Filter and deduplicate format options
  const formatOptions = useMemo(() => {
    if (!resolvedMedia || !resolvedMedia.formats) return [];

    const list: { id: string; label: string }[] = [{ id: 'best', label: 'Best Quality (Recommended)' }];
    const seen = new Set<string>(['best']);

    // Video formats sorted by height descending
    const videoFormats = [...resolvedMedia.formats]
      .filter((f) => f.has_video)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    for (const fmt of videoFormats) {
      const label = `${fmt.resolution_label || 'Video'} (${fmt.container.toUpperCase()})${
        fmt.filesize ? ` · ${fmtB(fmt.filesize)}` : fmt.filesize_approx ? ` · ~${fmtB(fmt.filesize_approx)}` : ''
      }`;
      if (!seen.has(fmt.format_id)) {
        seen.add(fmt.format_id);
        list.push({ id: fmt.format_id, label });
      }
    }

    // Audio only formats
    const audioFormats = resolvedMedia.formats.filter((f) => !f.has_video && f.has_audio);
    for (const fmt of audioFormats) {
      const label = `Audio Only (${fmt.acodec || fmt.container.toUpperCase()})${
        fmt.filesize ? ` · ${fmtB(fmt.filesize)}` : ''
      }`;
      if (!seen.has(fmt.format_id)) {
        seen.add(fmt.format_id);
        list.push({ id: fmt.format_id, label });
      }
    }

    return list;
  }, [resolvedMedia]);

  // Expand patterns like file[01-05].zip
  const expandUrlPattern = (input: string): string[] => {
    const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const results: string[] = [];

    for (const line of lines) {
      const match = line.match(/\[(\d+)-(\d+)\]/);
      if (!match) {
        results.push(line);
      } else {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        const padLen = match[1].length;
        if (!isNaN(start) && !isNaN(end) && start <= end && end - start <= 200) {
          for (let i = start; i <= end; i++) {
            const numStr = String(i).padStart(padLen, '0');
            results.push(line.replace(match[0], numStr));
          }
        } else {
          results.push(line);
        }
      }
    }
    return results;
  };

  const handleSubmit = async (startImmediately: boolean) => {
    setError(null);
    const urls = expandUrlPattern(urlText);
    if (urls.length === 0) {
      setError('Please enter at least one valid download address.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (isMedia && urls.length === 1 && onSubmitMedia) {
        const filename = customFilename.trim() || resolvedMedia?.title || 'video.mp4';
        await onSubmitMedia({
          url: urls[0],
          formatId: selectedFormatId,
          filename,
          destination: saveDir,
          startImmediately,
          thumbnailUrl: resolvedMedia?.thumbnail_url || null,
        });
      } else {
        await onSubmit(urls, saveDir, connections, startImmediately);
      }
      onClose();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div id="dim" onClick={onClose} />
      <div
        className="win pop"
        id="addw"
        style={{
          width: 600,
          minHeight: 350,
          height: isMedia && resolvedMedia ? 460 : 360,
          boxShadow: '0 12px 36px rgba(0,0,0,0.35)',
        }}
      >
        <TitleBar title="Add new download" onClose={onClose} isModal />

        <div className="f" style={{ top: 50, bottom: 54, overflowY: 'auto' }}>
          {error && (
            <div className="bad" style={{ marginBottom: 10, fontSize: 12 }}>
              {error}
            </div>
          )}

          <div className="fr" style={{ alignItems: 'start' }}>
            <span className="k" style={{ paddingTop: 4 }}>
              Address
            </span>
            <div style={{ flex: 1 }}>
              <textarea
                className="in"
                id="aurl"
                rows={isMedia && resolvedMedia ? 2 : 3}
                style={{ width: '100%' }}
                placeholder="One link per line, or a pattern like photo[01-20].jpg"
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                autoFocus
              />

              {hasBoth && onOpenPlaylist && (
                <div
                  style={{
                    marginTop: 6,
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'var(--pline)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 11.5,
                  }}
                >
                  <span>Link contains both a single video and a playlist:</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn def"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                    >
                      Single Video
                    </button>
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={() => {
                        onOpenPlaylist(trimmedUrl);
                        onClose();
                      }}
                    >
                      Entire Playlist
                    </button>
                  </div>
                </div>
              )}

              {!hasBoth && hasPlaylist && onOpenPlaylist && (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn"
                    style={{
                      fontSize: 11,
                      padding: '3px 8px',
                      color: 'var(--accent, #6366f1)',
                      borderColor: 'var(--accent, #6366f1)',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      onOpenPlaylist(trimmedUrl);
                      onClose();
                    }}
                  >
                    ⚡ Detected Playlist — Open in Playlist Downloader
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Media preview card when resolved */}
          {isMedia && (
            <div
              style={{
                display: 'flex',
                gap: 12,
                padding: '8px 12px',
                background: 'var(--pline)',
                borderRadius: 8,
                marginBottom: 10,
                alignItems: 'center',
              }}
            >
              {resolvedMedia?.thumbnail_url ? (
                <img
                  src={resolvedMedia.thumbnail_url}
                  alt=""
                  style={{
                    width: 52,
                    height: 38,
                    borderRadius: 6,
                    objectFit: 'cover',
                    flex: 'none',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 52,
                    height: 38,
                    borderRadius: 6,
                    background: 'var(--bline)',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 18,
                    flex: 'none',
                  }}
                >
                  🎬
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <b
                  style={{
                    display: 'block',
                    fontSize: 12.5,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {isResolvingMedia
                    ? 'Resolving media metadata...'
                    : resolvedMedia?.title || 'Video Stream'}
                </b>
                <span style={{ fontSize: 11, color: 'var(--mut)' }}>
                  {resolvedMedia?.site_name || 'Media'}
                  {resolvedMedia?.duration_seconds ? ` · ${fmtT(resolvedMedia.duration_seconds)}` : ''}
                  {isResolvingMedia ? ' · Probing formats...' : ''}
                </span>
              </div>
            </div>
          )}

          {/* Media format / quality selector */}
          {isMedia && formatOptions.length > 0 && (
            <div className="fr">
              <span className="k">Quality</span>
              <div className="row">
                <select
                  className="in"
                  id="aquality"
                  style={{ flex: 1, height: 28, fontSize: 12 }}
                  value={selectedFormatId}
                  onChange={(e) => setSelectedFormatId(e.target.value)}
                >
                  {formatOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Filename input */}
          {isMedia && (
            <div className="fr">
              <span className="k">File name</span>
              <div className="row">
                <input
                  className="in"
                  id="afilename"
                  style={{ flex: 1 }}
                  value={customFilename}
                  placeholder={resolvedMedia?.title ? `${resolvedMedia.title}.mp4` : 'video.mp4'}
                  onChange={(e) => setCustomFilename(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="fr">
            <span className="k">Save to</span>
            <div className="row">
              <input
                className="in"
                id="adir"
                style={{ flex: 1 }}
                value={saveDir}
                onChange={(e) => setSaveDir(e.target.value)}
              />
            </div>
          </div>

          <div className="fr">
            <span className="k">Connections</span>
            <div className="row">
              {isMedia ? (
                <span style={{ color: 'var(--mut)', fontSize: 12, padding: '4px 0' }}>
                  Managed media engine (stream muxing)
                </span>
              ) : (
                <>
                  <input
                    type="range"
                    id="acon"
                    min={1}
                    max={32}
                    value={connections}
                    onChange={(e) => setConnections(parseInt(e.target.value, 10))}
                  />
                  <b id="aconv" style={{ minWidth: 24, textAlign: 'right' }}>
                    {connections}
                  </b>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="foot">
          <button className="btn" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            className="btn"
            id="alater"
            onClick={() => handleSubmit(false)}
            disabled={isSubmitting}
          >
            Download Later
          </button>
          <button
            className="btn def"
            id="ago"
            onClick={() => handleSubmit(true)}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Starting...' : 'Start Download'}
          </button>
        </div>
      </div>
    </>
  );
};
