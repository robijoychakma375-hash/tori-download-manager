import React, { useState } from 'react';
import { TitleBar } from './TitleBar';
import type { DownloadJob } from '../types';

interface DeleteConfirmModalProps {
  job?: DownloadJob | null;
  jobs?: DownloadJob[];
  onConfirm: (jobs: DownloadJob[], deleteFiles: boolean) => Promise<void>;
  onClose: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  job,
  jobs = [],
  onConfirm,
  onClose,
}) => {
  const targetJobs = jobs.length > 0 ? jobs : job ? [job] : [];
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const count = targetJobs.length;
  const isMultiple = count > 1;
  const title = isMultiple ? `Delete ${count} Downloads` : 'Delete Download';

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onConfirm(targetJobs, deleteFiles);
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <div id="dim" onClick={onClose} />
      <div className="win pop" style={{ width: 480, height: 230 }}>
        <TitleBar title={title} onClose={onClose} isModal />

        <div className="f" style={{ top: 52 }}>
          <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: '18px' }}>
            {isMultiple ? (
              <>
                Are you sure you want to remove <b>{count} downloads</b> from your download list?
              </>
            ) : (
              <>
                Are you sure you want to remove <b>"{targetJobs[0]?.filename || 'download'}"</b> from your download list?
              </>
            )}
          </p>

          <label className="cb" style={{ margin: '14px 0' }}>
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => setDeleteFiles(e.target.checked)}
            />
            <span>Also delete downloaded file(s) from disk</span>
          </label>
        </div>

        <div className="foot">
          <button className="btn" onClick={onClose} disabled={isDeleting}>
            Cancel
          </button>
          <button
            className="btn def"
            style={{ background: 'linear-gradient(#f87171, #dc2626)', borderColor: '#b91c1c' }}
            onClick={handleDelete}
            disabled={isDeleting || count === 0}
          >
            {isDeleting ? 'Deleting...' : isMultiple ? `Delete ${count} Downloads` : 'Delete'}
          </button>
        </div>
      </div>
    </>
  );
};

