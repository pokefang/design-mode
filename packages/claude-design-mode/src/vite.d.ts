import type { Plugin } from 'vite';

export interface DesignModeOptions {
  /** Where selection payloads are written. Default: a per-project dir under `~/.claude-design-mode/`, outside the repo. */
  queueDir?: string;
  /** Extra Host names to accept besides localhost/127.0.0.1/::1/*.localhost. */
  allowedHosts?: string[];
  /** Set false to skip JSX stamping (non-React apps). */
  stamp?: boolean;
  /**
   * Optional map of design-token families to the project's own custom-property
   * patterns, e.g. `{ color: /^--brand-/, spacing: /^--space-/ }`. The overlay
   * discovers tokens from the page's CSS on its own; these take precedence
   * when a project's names are unusual.
   */
  tokens?: Partial<
    Record<
      | 'color'
      | 'fontFamily'
      | 'fontWeight'
      | 'fontSize'
      | 'lineHeight'
      | 'tracking'
      | 'radius'
      | 'shadow'
      | 'spacing',
      RegExp | string
    >
  >;
}

/**
 * Design Mode Vite plugin. Dev-serve only (and never inside Vitest); production
 * builds are untouched. Stamps JSX host elements with
 * `data-claude-source="relpath:line:col"`, serves the inspector overlay from
 * the app's own origin, and receives selections on a token-checked endpoint.
 */
export default function designMode(options?: DesignModeOptions): Plugin;
