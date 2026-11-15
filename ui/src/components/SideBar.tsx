import React, { useState } from 'react';
import type { CategoryKey } from '../types';
import { CategoryChip } from './Icons';

interface SideBarProps {
  currentCategory: CategoryKey;
  onSelectCategory: (cat: CategoryKey) => void;
  allCount: number;
  unfCount: number;
  finCount: number;
  videoCount: number;
  musicCount: number;
  compressedCount: number;
  programsCount: number;
  documentsCount: number;
}

export const SideBar: React.FC<SideBarProps> = React.memo(
  ({
    currentCategory,
    onSelectCategory,
    allCount,
    unfCount,
    finCount,
    videoCount,
    musicCount,
    compressedCount,
    programsCount,
    documentsCount,
  }) => {
    const [allExpanded, setAllExpanded] = useState(true);

    const subCategories: { key: CategoryKey; label: string; count: number }[] = [
      { key: 'Video', label: 'Video', count: videoCount },
      { key: 'Music', label: 'Music', count: musicCount },
      { key: 'Compressed', label: 'Compressed', count: compressedCount },
      { key: 'Programs', label: 'Programs', count: programsCount },
      { key: 'Documents', label: 'Documents', count: documentsCount },
    ];

    const topStatusCategories: { key: CategoryKey; label: string; count: number }[] = [
      { key: 'unf', label: 'Unfinished', count: unfCount },
      { key: 'fin', label: 'Finished', count: finCount },
    ];

    return (
      <aside id="side" aria-label="Download Categories">
        <div
          className={`si ${currentCategory === 'all' ? 'on' : ''}`}
          data-cat="all"
          onClick={() => onSelectCategory('all')}
          role="treeitem"
          aria-expanded={allExpanded}
          aria-selected={currentCategory === 'all'}
        >
          <span className="sn">
            <button
              type="button"
              className={`tch ${allExpanded ? 'open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setAllExpanded((v) => !v);
              }}
              title={allExpanded ? 'Collapse Categories' : 'Expand Categories'}
              aria-label={allExpanded ? 'Collapse Categories' : 'Expand Categories'}
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4.5 2.5L8 6 4.5 9.5" />
              </svg>
            </button>
            <CategoryChip category="all" size={19} />
            <span className="slbl">All Downloads</span>
          </span>
          <em>{allCount}</em>
        </div>

        {allExpanded && (
          <div className="kids" role="group" aria-label="File Type Categories">
            {subCategories.map(({ key, label, count }) => {
              const isSelected = currentCategory === key;
              return (
                <div
                  key={key}
                  className={`si ${isSelected ? 'on' : ''}`}
                  data-cat={key}
                  onClick={() => onSelectCategory(key)}
                  role="treeitem"
                  aria-selected={isSelected}
                >
                  <span className="sn">
                    <CategoryChip category={key} size={19} />
                    <span className="slbl">{label}</span>
                  </span>
                  <em>{count}</em>
                </div>
              );
            })}
          </div>
        )}

        {topStatusCategories.map(({ key, label, count }) => {
          const isSelected = currentCategory === key;
          return (
            <div
              key={key}
              className={`si ${isSelected ? 'on' : ''}`}
              data-cat={key}
              onClick={() => onSelectCategory(key)}
              role="treeitem"
              aria-selected={isSelected}
            >
              <span className="sn">
                <span className="tch-spacer" aria-hidden="true" />
                <CategoryChip category={key} size={19} />
                <span className="slbl">{label}</span>
              </span>
              <em>{count}</em>
            </div>
          );
        })}
      </aside>
    );
  }
);
SideBar.displayName = 'SideBar';
