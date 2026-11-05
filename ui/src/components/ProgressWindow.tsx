import React from 'react';
import { DownloadToast } from './DownloadToast';

interface ProgressWindowProps {
  id: string;
}

export const ProgressWindow: React.FC<ProgressWindowProps> = ({ id }) => {
  return <DownloadToast initialId={id} />;
};
