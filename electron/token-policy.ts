// The three facts the live spike (WP-00) settles. Everything else reads them.
export const TOKEN_SCOPES = 'user:inference';
export const TOKEN_READS_USAGE = false;
export const TOKEN_EXPIRES_IN_S = 31_536_000; // one year, as `claude setup-token`
export const CALLBACK_LISTEN_HOST = '127.0.0.1';
