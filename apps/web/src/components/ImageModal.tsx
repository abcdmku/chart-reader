import React from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

type ImageModalProps = {
  filename: string | null;
  filenames: string[];
  onClose: () => void;
  onNavigate: (filename: string) => void;
};

function isPdfFilename(filename: string): boolean {
  return /\.pdf$/i.test(filename);
}

export function ImageModal({ filename, filenames, onClose, onNavigate }: ImageModalProps) {
  const currentIndex = filename ? filenames.indexOf(filename) : -1;

  useHotkeys('escape', onClose, { enabled: !!filename });

  useHotkeys(
    'left',
    () => {
      if (currentIndex > 0) onNavigate(filenames[currentIndex - 1]);
    },
    { enabled: !!filename && currentIndex > 0 },
    [currentIndex, filenames, onNavigate],
  );

  useHotkeys(
    'right',
    () => {
      if (currentIndex < filenames.length - 1) onNavigate(filenames[currentIndex + 1]);
    },
    { enabled: !!filename && currentIndex < filenames.length - 1 },
    [currentIndex, filenames, onNavigate],
  );

  if (!filename) return null;

  const isPdf = isPdfFilename(filename);
  const fileUrl = `/api/files/${encodeURIComponent(filename)}`;
  const pdfViewerUrl = `${fileUrl}#toolbar=1&navpanes=0&view=FitH`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${isPdf ? 'PDF' : 'Image'}: ${filename}`}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800/80 text-xl text-zinc-300 hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
        aria-label="Close"
      >
        &times;
      </button>

      {currentIndex > 0 ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(filenames[currentIndex - 1]);
          }}
          className="absolute left-4 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-800/80 text-lg text-zinc-300 hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
          aria-label="Previous file"
        >
          {'<'}
        </button>
      ) : null}

      {currentIndex < filenames.length - 1 ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(filenames[currentIndex + 1]);
          }}
          className="absolute right-4 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-800/80 text-lg text-zinc-300 hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
          aria-label="Next file"
        >
          {'>'}
        </button>
      ) : null}

      <div
        className={`overflow-hidden rounded-lg shadow-2xl ${
          isPdf ? 'h-[90vh] w-[90vw] max-w-6xl bg-zinc-950' : ''
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {isPdf ? (
          <iframe
            src={pdfViewerUrl}
            title={filename}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <img
            src={fileUrl}
            alt={filename}
            className="max-h-[90vh] max-w-[90vw]"
          />
        )}
      </div>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-zinc-900/80 px-4 py-1.5 text-xs text-zinc-300">
        {isPdf ? (
          <span className="mr-2 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-200">
            PDF
          </span>
        ) : null}
        {filename}
        {filenames.length > 1 ? (
          <span className="ml-2 text-zinc-500">
            {currentIndex + 1} / {filenames.length}
          </span>
        ) : null}
      </div>
    </div>
  );
}
