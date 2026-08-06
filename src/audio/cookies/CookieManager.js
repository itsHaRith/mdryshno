/**
 * CookieManager
 *
 * Single source of truth for YouTube session credentials.
 * Priority: Supabase youtube_auth table → local youtubeCookies.js
 *
 * Responsibilities:
 *  - Load cookies + poToken + visitorData from Supabase on first use
 *  - Refresh automatically when TTL expires
 *  - Detect and flag placeholder / expired values
 *  - Provide a cookie string and a cookie array (for ytdl.createAgent)
 *  - Expose poToken and visitorData for InnerTube player API injection
 *
 * No other module should import from Supabase or youtubeCookies.js directly.
 */

import { fetchYoutubeAuth } from '../../config/supabaseClient.js';
import { USER_YOUTUBE_COOKIES } from '../../config/youtubeCookies.js';
import { logger } from '../../utils/logger.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // re-check Supabase every 5 minutes

const PLACEHOLDER_MARKERS = [
  'YOUR_COOKIE', 'YOUR_PO_TOKEN', 'YOUR_VISITOR',
  'PLACEHOLDER', 'XXXX', 'ضع_هنا'
];

function isPlaceholder(val) {
  if (!val || typeof val !== 'string') return true;
  if (val.trim().length < 10) return true;
  const upper = val.toUpperCase();
  return PLACEHOLDER_MARKERS.some(m => upper.includes(m));
}

/** Build cookie header string from cookie array */
function cookieArrayToString(arr) {
  return arr.map(c => `${c.name}=${c.value}`).join('; ');
}

/** Static local cookie string (fallback) */
const LOCAL_COOKIE_STRING = cookieArrayToString(USER_YOUTUBE_COOKIES);

class CookieManager {
  constructor() {
    this._cookieString  = LOCAL_COOKIE_STRING;
    this._cookieArray   = USER_YOUTUBE_COOKIES;
    this._poToken       = null;
    this._visitorData   = null;
    this._lastFetch     = 0;
    this._loading       = false;
    this._loadPromise   = null;
  }

  /** Refresh from Supabase if cache is stale */
  async _refresh() {
    const now = Date.now();
    if (now - this._lastFetch < CACHE_TTL_MS) return;

    // Coalesce concurrent refreshes into a single promise
    if (this._loading) {
      await this._loadPromise;
      return;
    }

    this._loading = true;
    this._loadPromise = (async () => {
      try {
        const dbAuth = await fetchYoutubeAuth();

        if (dbAuth?.cookie_header && !isPlaceholder(dbAuth.cookie_header)) {
          this._cookieString = dbAuth.cookie_header;
          // Rebuild cookie array from header string so ytdl.createAgent works
          this._cookieArray = dbAuth.cookie_header
            .split(';')
            .map(pair => {
              const eq = pair.indexOf('=');
              if (eq < 0) return null;
              return {
                name:   pair.slice(0, eq).trim(),
                value:  pair.slice(eq + 1).trim(),
                domain: '.youtube.com',
                path:   '/'
              };
            })
            .filter(c => c && c.name && c.value);

          logger.debug('[CookieManager] Loaded cookie header from Supabase.');
        } else {
          // Supabase has nothing useful — keep local cookies
          this._cookieString = LOCAL_COOKIE_STRING;
          this._cookieArray  = USER_YOUTUBE_COOKIES;
          logger.debug('[CookieManager] Supabase cookie absent/placeholder — using local cookies.');
        }

        this._poToken = (dbAuth?.po_token && !isPlaceholder(dbAuth.po_token))
          ? dbAuth.po_token : null;

        this._visitorData = (dbAuth?.visitor_data && !isPlaceholder(dbAuth.visitor_data))
          ? dbAuth.visitor_data : null;

        this._lastFetch = Date.now();
      } catch (err) {
        logger.warn('[CookieManager] Failed to load from Supabase, using local fallback:', err.message);
        // Do not update _lastFetch so next call tries again immediately
      }
    })();

    try {
      await this._loadPromise;
    } finally {
      this._loading = false;
      this._loadPromise = null;
    }
  }

  /** Cookie header string  (e.g. "SID=xxx; HSID=yyy; ...") */
  async getCookieString() {
    await this._refresh();
    return this._cookieString;
  }

  /** Cookie array  [{name, value, domain, path}, ...] suitable for ytdl.createAgent() */
  async getCookieArray() {
    await this._refresh();
    return this._cookieArray;
  }

  /** poToken — null if unavailable */
  async getPoToken() {
    await this._refresh();
    return this._poToken;
  }

  /** visitorData — null if unavailable */
  async getVisitorData() {
    await this._refresh();
    return this._visitorData;
  }

  /** Force next access to re-query Supabase */
  invalidate() {
    this._lastFetch = 0;
  }

  /** Current health: true if we have a non-empty cookie string */
  get healthy() {
    return this._cookieString.length > 20;
  }
}

export const cookieManager = new CookieManager();
