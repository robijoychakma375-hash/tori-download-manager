import React, { useState } from 'react';
import { TitleBar } from './TitleBar';

interface AddDownloadModalProps {
  defaultDir: string;
  defaultConnections: number;
  onClose: () => void;
  onSubmit: (urls: string[], dir: string, connections: number, startImmediately: boolean) => Promise<void>;
  onOpenPlaylist?: (url: string) => void;
}

export const AddDownloadModal: React.FC<AddDownloadModalProps> = ({
  defaultDir,
  defaultConnections,
  onClose,
  onSubmit,
  onOpenPlaylist,
}) => {
  const [urlText, setUrlText] = useState('');
  const [saveDir, setSaveDir] = useState(defaultDir);
  const [connections, setConnections] = useState(defaultConnections);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await onSubmit(urls, saveDir, connections, startImmediately);
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
      <div className="win pop" id="addw" style={{ width: 600, height: 350 }}>
        <TitleBar title="Add new download" onClose={onClose} isModal />

        <div className="f" style={{ top: 50 }}>
          {error && (
            <div className="bad" style={{ marginBottom: 10, fontSize: 12 }}>
              {error}
            </div>
          )}

          <div className="fr" style={{ alignItems: 'start' }}>
            <span className="k" style={{ paddingTop: 4 }}>
              Address
            </span>
            <div>
              <textarea
                className="in"
                id="aurl"
                rows={3}
                style={{ width: '100%' }}
                placeholder="One link per line, or a pattern like photo[01-20].jpg"
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                autoFocus
              />
              {onOpenPlaylist && (urlText.includes('list=') || urlText.includes('playlist')) && (
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
                    onClick={() => onOpenPlaylist(urlText.trim())}
                  >
                    ⚡ Detected Playlist — Open in Playlist Downloader
                  </button>
                </div>
              )}
            </div>
          </div>

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

