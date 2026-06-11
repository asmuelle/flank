// Keeps `tsc --noEmit` green on a fresh clone, before `next build` has
// generated next-env.d.ts / .next/types (just ci runs typecheck first).
declare module '*.css';
