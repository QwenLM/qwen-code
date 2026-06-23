export function ModeIcon({ mode }: { mode: string }) {
  if (mode === 'plan') {
    return (
      <svg viewBox="0 0 1024 1024" aria-hidden="true">
        <path
          d="M192 64h576a128 128 0 0 1 128 128v640a128 128 0 0 1-128 128H192a128 128 0 0 1-128-128V192a128 128 0 0 1 128-128z m0 64a64 64 0 0 0-64 64v640a64 64 0 0 0 64 64h576a64 64 0 0 0 64-64V192a64 64 0 0 0-64-64H192z"
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
        />
        <path
          d="M438.848 265.216a31.808 31.808 0 0 0-44.992 0L287.232 371.84l-42.688-42.688a30.72 30.72 0 1 0-43.456 43.456l59.584 59.584c1.344 2.304 2.432 4.672 4.416 6.656 6.656 6.592 15.36 9.408 23.936 9.088a30.848 30.848 0 0 0 21.824-9.024c0.704-0.704 1.024-1.6 1.6-2.432l126.4-126.336a31.744 31.744 0 0 0 0-44.928zM544 320a32 32 0 0 0 0 64h192a32 32 0 0 0 0-64h-192zM393.856 489.216L287.232 595.84l-42.688-42.688a30.72 30.72 0 1 0-43.456 43.456l59.584 59.584c1.344 2.304 2.432 4.672 4.416 6.656 6.656 6.592 15.36 9.408 23.936 9.088a30.848 30.848 0 0 0 21.824-9.024c0.704-0.704 1.024-1.6 1.6-2.432l126.4-126.336a31.872 31.872 0 0 0-44.992-44.928zM544 544a32 32 0 0 0 0 64h192a32 32 0 0 0 0-64h-192z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (mode === 'default') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M7.8 11.8V5.6a1.4 1.4 0 0 1 2.8 0v5.2M10.6 10V4.7a1.4 1.4 0 0 1 2.8 0v6.1M13.4 10.8V6.1a1.4 1.4 0 0 1 2.8 0v6.2M16.2 12.2V8.7a1.4 1.4 0 0 1 2.8 0v4.9c0 4-2.7 6.8-6.4 6.8h-.9c-2.4 0-4.2-1-5.5-3.1L4.4 14a1.45 1.45 0 0 1 2.5-1.45l1.2 2.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (mode === 'auto-edit') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect
          x="4"
          y="5"
          width="16"
          height="14"
          rx="4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M8 10h.01M8 14h.01M11 12h5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (mode === 'auto') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3.5 18.8 7v5.2c0 4-2.7 7.4-6.8 8.8-4.1-1.4-6.8-4.8-6.8-8.8V7L12 3.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="m9 12.1 2 2 4-4.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (mode === 'yolo') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3.5 19 6v5.2c0 4.1-2.8 7.8-7 9.3-4.2-1.5-7-5.2-7-9.3V6l7-2.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M12 8v4.2M12 15.6h.01"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 18c.7-2.7 2.2-4 4.5-4H12M7 6h10M7 10h7M17.5 14.5l2 2-2 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
