// Apply strategy: given a DOM element + an inspected strategy + a value, run
// the right interaction. For native inputs this means setting .value through
// the native setter and dispatching events. For widgets (Ant Design, Element
// Plus) the strategy emits interaction events that the widget's own logic
// picks up — there is no reliable cross-widget "set value to foo" hook without
// triggering the framework's reconciliation, which is what we want.

'use strict';

// setNativeFieldValue uses the prototype's native setter so React/Vue see a
// real change, then dispatches framework-facing events.
function setNativeFieldValue(element, value) {
  if (!element) return false;
  const tagName = String(element.tagName || '').toLowerCase();
  const view = element.ownerDocument && element.ownerDocument.defaultView;
  const inputProto = view ? view.HTMLInputElement && view.HTMLInputElement.prototype : (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null);
  const textareaProto = view ? view.HTMLTextAreaElement && view.HTMLTextAreaElement.prototype : (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : null);
  const selectProto = view ? view.HTMLSelectElement && view.HTMLSelectElement.prototype : (typeof HTMLSelectElement !== 'undefined' ? HTMLSelectElement.prototype : null);
  const prototype = tagName === 'textarea' ? textareaProto : (tagName === 'select' ? selectProto : inputProto);
  if (!prototype) return false;

  try {
    const ownDescriptor = Object.getOwnPropertyDescriptor(element, 'value');
    if (ownDescriptor && ownDescriptor.configurable) delete element.value;
    const previous = element.value;
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(element, String(value ?? ''));
    else element.value = String(value ?? '');
    if (element._valueTracker && typeof element._valueTracker.setValue === 'function') {
      element._valueTracker.setValue(previous);
    }
    const EventCtor = (view && view.Event) ? view.Event : (typeof Event !== 'undefined' ? Event : null);
    if (EventCtor) {
      element.dispatchEvent(new EventCtor('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new EventCtor('change', { bubbles: true, composed: true }));
    }
    return true;
  } catch (e) {
    return false;
  }
}

// clickElement dispatches a real click on an element. Widgets (Ant Design,
// Element Plus) translate this into their own open/select logic.
function clickElement(element) {
  if (!element) return false;
  const view = element.ownerDocument && element.ownerDocument.defaultView;
  const MouseEventCtor = (view && view.MouseEvent) ? view.MouseEvent : (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
  try {
    if (MouseEventCtor) {
      element.dispatchEvent(new MouseEventCtor('mousedown', { bubbles: true, cancelable: true, view }));
      element.dispatchEvent(new MouseEventCtor('mouseup', { bubbles: true, cancelable: true, view }));
      element.dispatchEvent(new MouseEventCtor('click', { bubbles: true, cancelable: true, view }));
    } else {
      element.click?.();
    }
    return true;
  } catch (e) {
    try {
      element.click?.();
      return true;
    } catch (e2) {
      return false;
    }
  }
}

// applyText writes a string into a native input/textarea. Normalizes month
// (YYYY-MM) and date (YYYY-MM-DD) to the input's expected format.
function applyText(element, value, strategy) {
  let next = String(value ?? '');
  if (strategy === 'month') {
    const m = next.match(/^(\d{4})\D*(\d{1,2})/);
    if (m) next = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
    else next = next.slice(0, 7);
  } else if (strategy === 'date') {
    const m = next.match(/^(\d{4})\D*(\d{1,2})\D*(\d{1,2})/);
    if (m) next = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  const ok = setNativeFieldValue(element, next);
  return { ok, appliedValue: ok ? String(element.value ?? '') : null, strategy };
}

// applyFile records a planned file path. The agent's environment must handle
// the actual upload; the extension deliberately does not read or upload files
// silently to avoid leaking the user's local filesystem.
function applyFile(element, value) {
  return { ok: false, strategy: 'file', error: 'file_upload_planned', plannedValue: String(value ?? '') };
}

// applyNativeSelect matches the option text/value against the requested value
// using normalized matching.
function applyNativeSelect(element, value) {
  const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\s·•・,，。.;；:：()（）[\]【】]/g, '');
  const wanted = norm(value);
  const options = [...element.options || []];
  const exact = options.find((o) => norm(o.textContent) === wanted || norm(o.value) === wanted);
  const contains = options.find((o) => {
    const t = norm(o.textContent); return t && (t.includes(wanted) || wanted.includes(t));
  });
  const matched = exact || contains;
  if (!matched) return { ok: false, strategy: 'select', error: 'no_exact_match', candidates: options.map((o) => o.textContent.trim()).slice(0, 50) };
  const ok = setNativeFieldValue(element, matched.value);
  return { ok, strategy: 'select', appliedValue: ok ? matched.textContent.trim() : null };
}

// applyCustomSelect clicks the element to open the dropdown. Subsequent
// option picking is done by waitForAgentChoice (which inspects choice nodes).
function applyCustomSelect(element) {
  clickElement(element);
  return { ok: true, strategy: 'select', appliedValue: null, action: 'opened_dropdown' };
}

// applyCascader clicks the cascader container to open the first level.
function applyCascader(element) {
  clickElement(element);
  return { ok: true, strategy: 'cascader', appliedValue: null, action: 'opened_cascader' };
}

// routeApply picks the right strategy based on the inspect result. The agent
// calls routeApply after resolve() to fill the actual DOM.
function routeApply(element, value, inspectResult) {
  if (!inspectResult || !inspectResult.ok) return { ok: false, error: inspectResult?.error || 'inspect_failed' };
  const strategy = inspectResult.strategy;
  switch (strategy) {
    case 'text':
    case 'tel':
    case 'email':
    case 'number':
    case 'date':
    case 'month':
      return applyText(element, value, strategy);
    case 'select':
      if (inspectResult.widget === 'native') return applyNativeSelect(element, value);
      return applyCustomSelect(element);
    case 'cascader':
      return applyCascader(element);
    case 'file':
      return applyFile(element, value);
    default:
      return { ok: false, error: 'unsupported_strategy', strategy, evidence: inspectResult.evidence };
  }
}

// splitPath splits a cascader string ("江苏省/南京市/鼓楼区") into ordered path
// segments. Falls back to single-element array when no separator is found.
function splitPath(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const parts = text.split(/\s*(?:\/|\\|>|＞|→|—|–|,|，|;|；)\s*/).filter(Boolean);
  return parts.length > 1 ? parts : [text];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { setNativeFieldValue, clickElement, applyNativeSelect, applyCustomSelect, applyCascader, applyText, applyFile, routeApply, splitPath };
}