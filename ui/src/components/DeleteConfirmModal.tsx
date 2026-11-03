import React, { useState } from 'react';
import { TitleBar } from './TitleBar';
import type { DownloadJob } from '../types';

interface DeleteConfirmModalProps {
  job: DownloadJob;
  onConfirm: (job: DownloadJob, deleteFiles: boolean) => Promise<void>;
  onClose: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  job,
  onConfirm,
  onClose,
}) => {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onConfirm(job, deleteFiles);
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
        <TitleBar title="Delete Download" onClose={onClose} isModal />

        <div className="f" style={{ top: 52 }}>
          <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: '18px' }}>
            Are you sure you want to remove <b>"{job.filename}"</b> from your download list?
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
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </>
  );
};

