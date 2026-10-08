// 表单资料助手 — Agent bridge (MAIN world)
//
// This file runs in the page's MAIN JavaScript world so automation agents
// can call formHelper.* directly. The bridge marshals a request through
// a CustomEvent round-trip with the content script in the ISOLATED world.
//
// Public API v2 intentionally exposes only list() and get(). Text controls use
// keyword expansion; non-text controls can fetch one value with get() and let
// the active automation environment perform the interaction.

(() => {
  if (window.formHelper && window.formHelper.version && window.formHelper.version.startsWith('2.0')) return;

  const EVENT_REQUEST = 'form-helper-request-v1';
  const EVENT_RESPONSE = 'form-helper-response-v1';

  // Per-action timeout presets. choose / apply are deep-cascader friendly.
  // Deep nested custom widgets (Ant Design 4-level AddressPicker, etc.) may
  // still exceed the default — agents can override per call via timeoutMS.
  const ACTION_TIMEOUTS = {
    list: 5000,
    get: 5000
  };
  const DEFAULT_TIMEOUT_MS = 8000;
  const MIN_TIMEOUT_MS = 1000;
  const MAX_TIMEOUT_MS = 120000;

  function clampTimeout(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, n));
  }

  function request(action, payload, options = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `${EVENT_REQUEST}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const presetMs = ACTION_TIMEOUTS[action] || DEFAULT_TIMEOUT_MS;
      // Look for timeoutMS in either explicit options arg or payload.options.
      const requested = (options && options.timeoutMS != null) ? options.timeoutMS : ((payload && payload.options && payload.options.timeoutMS != null) ? payload.options.timeoutMS : null);
      const timeoutMs = clampTimeout(requested != null ? requested : presetMs);
      const timeoutId = setTimeout(() => {
        document.removeEventListener(EVENT_RESPONSE, onResponse, false);
        const err = new Error(`formHelper.${action} timed out after ${timeoutMs}ms`);
        err.code = 'bridge_timeout';
        err.timeoutMs = timeoutMs;
        reject(err);
      }, timeoutMs);

      const onResponse = (event) => {
        if (!event || !event.detail || event.detail.requestId !== requestId) return;
        document.removeEventListener(EVENT_RESPONSE, onResponse, false);
        clearTimeout(timeoutId);
        resolve(event.detail.result);
      };

      document.addEventListener(EVENT_RESPONSE, onResponse, false);
      document.dispatchEvent(new CustomEvent(EVENT_REQUEST, {
        detail: { requestId, action, payload: payload || {}, source: 'main-world-bridge' }
      }));
    });
  }

  function normalizeOptions(args, explicitOptions) {
    if (explicitOptions && typeof explicitOptions === 'object') return explicitOptions;
    if (args && typeof args === 'object' && !Array.isArray(args)) return args;
    return {};
  }

  function normalizeFieldOptions(fieldOrOptions, options) {
    const base = fieldOrOptions && typeof fieldOrOptions === 'object' && !Array.isArray(fieldOrOptions)
      ? { ...fieldOrOptions }
      : { field: String(fieldOrOptions || '') };
    if (options && typeof options === 'object' && !Array.isArray(options)) Object.assign(base, options);
    return base;
  }

  function buildApi() {
    const api = Object.freeze({
      version: '2.0.0',
      capabilities: Object.freeze(['list', 'get']),

      // list('query') replaces the deprecated find(query).
      list: (requestOrQuery = {}, options) => {
        if (typeof requestOrQuery === 'string') {
          const query = requestOrQuery.trim();
          if (query) return request('list', { query, options: { legacy_query: query, ...normalizeOptions(options) } });
          return request('list', { options: normalizeOptions(options) });
        }
        return request('list', { options: normalizeOptions(requestOrQuery) });
      },
      get: (fieldOrOptions, options) => {
        const opts = normalizeFieldOptions(fieldOrOptions, options);
        return request('get', { options: opts });
      }
    });
    return api;
  }

  try {
    Object.defineProperty(window, 'formHelper', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: buildApi()
    });
  } catch (e) {
    // Some hosts redefine window.formHelper; in that case we surface
    // a warning and let the existing instance stay.
    try { console.warn('formHelper bridge could not redefine existing instance:', e); } catch (_) {}
  }
})();
