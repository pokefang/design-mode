import type { IncomingMessage, ServerResponse } from 'node:http';

export declare const OVERLAY_ROUTE: '/__design-mode/overlay.js';
export declare const SELECTION_ROUTE: '/__design-mode/selection';
export declare const HEALTH_ROUTE: '/__design-mode/health';
export declare const MAX_BODY: number;

/** Absolute filesystem path of the bundled overlay script. */
export declare function overlayPath(): string;
/** Absolute filesystem path of the bundled session skill directory. */
export declare function skillDir(): string;
/** A fresh per-boot token for the selection endpoint. */
export declare function newToken(): string;

export interface CreateHandlerOptions {
  /** Per-boot secret the overlay sends back (see `newToken`). */
  token: string;
  /** Absolute directory where payloads are written as JSON files. */
  queueDir: string;
  /** Project root, used only to print relative paths. Default: `process.cwd()`. */
  root?: string;
  /** Extra Host names besides localhost/127.0.0.1/::1/*.localhost. */
  allowedHosts?: string[];
  /** Extra Origins to accept (the standalone server needs the app's origin). */
  allowOrigins?: string[];
  /** Answer preflights and echo an allowed Origin back (cross-origin overlay only). */
  cors?: boolean;
  log?: (msg: string) => void;
}

/**
 * The Design Mode HTTP surface, framework-free. Returns a connect-style
 * handler that returns true when it handled the request.
 */
export declare function createHandler(
  opts: CreateHandlerOptions
): (req: IncomingMessage, res: ServerResponse) => boolean;

/** Serialize the plugin's `tokens` option (RegExp or strings) for the browser. */
export declare function serializeTokenHints(
  tokens?: Record<string, RegExp | string | null | undefined>
): Record<string, string>;

/** The inline config the page needs before the overlay script runs. */
export declare function configScript(config: Record<string, unknown>): string;
