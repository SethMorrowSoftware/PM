// Command Palette (⌘K / Ctrl+K launcher).
//
// openCommandPalette(getItems): centered Spotlight-style overlay. `getItems` is
// supplied by the caller: getItems(query) -> [{ label, hint?, icon?, sublabel?,
// run }]. `run` is invoked when the item is chosen. We call getItems('') on open
// for default items and re-query (debounced ~60ms) on every keystroke.
//
// Accessibility mirrors ui.js's modal(): role="dialog" + aria-modal, focus trap
// over Tab/Shift+Tab, Esc closes, scrim-click closes, focus restored on close.
// Dependency-free: uses only window.h and window.Icon. Does NOT bind ⌘K itself —
// the lead wires the shortcut and passes getItems in.

(function () {
  const MAX_RESULTS = 12;
  const DEBOUNCE_MS = 60;
  let _open = false; // guard against stacking palettes

  function openCommandPalette(getItems) {
    if (typeof getItems !== 'function') return null;
    if (_open) return null;
    _open = true;

    const prevFocus = document.activeElement;
    const frag = document.createDocumentFragment();

    // Reuse the shared .scrim class so theming/animation stay consistent.
    const scrim = h('div', { class: 'scrim' });

    const titleId = 'cmdp-title-' + Date.now();
    const input = h('input', {
      class: 'input cmdp-input', type: 'text', autofocus: true,
      placeholder: 'Type a command or search…',
      'aria-label': 'Command palette search', 'aria-controls': titleId,
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: false,
      style: {
        width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none',
        background: 'transparent', color: 'var(--fg-0, var(--fg-1))',
        fontSize: '15px', padding: '14px 16px',
      },
    });

    // Search-row: a leading magnifier + the input, divided from the result list.
    const searchRow = h('div', {
      class: 'cmdp-search hstack',
      style: {
        alignItems: 'center', gap: '8px', padding: '0 12px',
        borderBottom: '1px solid var(--line)',
      },
    }, h('span', { style: { color: 'var(--fg-3)', display: 'inline-flex' } }, Icon('search', 18)), input);

    const list = h('div', {
      class: 'cmdp-list', id: titleId, role: 'listbox',
      'aria-label': 'Results',
      style: { maxHeight: '52vh', overflowY: 'auto', padding: '6px' },
    });

    const panel = h('div', {
      class: 'cmdp-panel', role: 'dialog', 'aria-modal': 'true',
      'aria-label': 'Command palette', tabindex: '-1',
      style: {
        position: 'fixed', left: '50%', top: '14vh', transform: 'translateX(-50%)',
        width: 'min(620px, calc(100vw - 32px))', maxWidth: '620px', zIndex: '120',
        background: 'var(--bg-2)', border: '1px solid var(--line)',
        borderRadius: 'var(--radius, 10px)', boxShadow: 'var(--shadow-pop)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      },
    }, searchRow, list);

    frag.appendChild(scrim);
    frag.appendChild(panel);

    // ---- state ----
    let items = [];
    let active = -1;
    let rowEls = [];
    let closed = false;
    let debounceTimer = null;

    function close() {
      if (closed) return;
      closed = true;
      _open = false;
      clearTimeout(debounceTimer);
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      panel.remove();
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (_) {}
      }
    }

    function setActive(i, scroll = true) {
      if (!rowEls.length) { active = -1; return; }
      // wrap around the ends
      active = (i + rowEls.length) % rowEls.length;
      rowEls.forEach((el, idx) => {
        const on = idx === active;
        el.classList.toggle('selected', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) el.id = el.id || (titleId + '-opt-' + idx);
      });
      const el = rowEls[active];
      if (el) {
        input.setAttribute('aria-activedescendant', el.id);
        if (scroll && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest' });
        }
      }
    }

    function runItem(item) {
      if (!item || typeof item.run !== 'function') { close(); return; }
      // Close first so the run() callback can open its own modal/drawer cleanly,
      // then execute guarded so a throwing command never wedges the UI.
      close();
      try {
        item.run();
      } catch (err) {
        if (typeof window.toast === 'function') {
          window.toast((err && err.message) || 'Command failed', 'error');
        } else if (window.console) {
          console.error('[command-palette]', err);
        }
      }
    }

    function buildRow(item, idx) {
      const leading = item.icon
        ? h('span', { class: 'cmdp-icon', style: { color: 'var(--fg-2)', display: 'inline-flex', flex: '0 0 auto' } }, Icon(item.icon, 16))
        : null;

      const label = h('span', {
        class: 'cmdp-label',
        style: { color: 'var(--fg-0, var(--fg-1))', fontSize: '13.5px', lineHeight: '1.25', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, item.label != null ? String(item.label) : '');

      const sublabel = item.sublabel
        ? h('span', { class: 'cmdp-sublabel', style: { color: 'var(--fg-3)', fontSize: '11.5px', lineHeight: '1.25', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(item.sublabel))
        : null;

      const texts = h('div', {
        class: 'cmdp-texts',
        style: { display: 'flex', flexDirection: 'column', minWidth: '0', flex: '1 1 auto' },
      }, label, sublabel);

      const hint = item.hint
        ? h('span', { class: 'cmdp-hint', style: { color: 'var(--fg-3)', fontSize: '11px', flex: '0 0 auto', marginLeft: 'auto', paddingLeft: '8px' } }, String(item.hint))
        : null;

      const row = h('div', {
        class: 'cmdp-row pop-item', role: 'option', id: titleId + '-opt-' + idx,
        'aria-selected': 'false',
        style: {
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '8px 10px', borderRadius: '7px', cursor: 'pointer',
        },
        onMousemove: () => { if (active !== idx) setActive(idx, false); },
        onClick: () => runItem(items[idx]),
      }, leading, texts, hint);

      return row;
    }

    function renderResults() {
      list.replaceChildren();
      rowEls = [];
      if (!items.length) {
        input.removeAttribute('aria-activedescendant');
        list.appendChild(h('div', {
          class: 'cmdp-empty empty',
          style: { padding: '20px 12px', textAlign: 'center', color: 'var(--fg-3)', fontSize: '13px' },
        }, 'No matches'));
        active = -1;
        return;
      }
      items.forEach((item, idx) => {
        const row = buildRow(item, idx);
        rowEls.push(row);
        list.appendChild(row);
      });
      setActive(0, false);
    }

    let queryGen = 0;
    function query(value) {
      const gen = ++queryGen;
      const apply = (arr) => {
        if (gen !== queryGen || closed) return; // ignore stale / late responses
        items = (Array.isArray(arr) ? arr : []).slice(0, MAX_RESULTS);
        renderResults();
      };
      let result;
      try {
        result = getItems(value);
      } catch (err) {
        if (window.console) console.error('[command-palette] getItems threw', err);
        result = [];
      }
      // getItems may return an array (sync) or a Promise (e.g. server search).
      if (result && typeof result.then === 'function') {
        result.then(apply).catch(() => apply([]));
      } else {
        apply(result);
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const val = input.value;
      debounceTimer = setTimeout(() => query(val), DEBOUNCE_MS);
    });

    // ---- keyboard: nav + focus trap + Esc, captured at document level ----
    const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    function focusables() {
      return [...panel.querySelectorAll(FOCUSABLE)]
        .filter(el => el.offsetParent !== null || el === document.activeElement);
    }

    function onKey(e) {
      // During IME composition every key (Enter/Escape/arrows) belongs to the
      // candidate window — don't treat it as palette navigation.
      if (imeGuard(e)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); return; }
      if (e.key === 'Home' && rowEls.length) { e.preventDefault(); setActive(0); return; }
      if (e.key === 'End' && rowEls.length) { e.preventDefault(); setActive(rowEls.length - 1); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (active >= 0 && items[active]) runItem(items[active]);
        return;
      }
      if (e.key === 'Tab') {
        // Keep focus inside the palette (mirrors ui.js modal()).
        const list2 = focusables();
        if (!list2.length) { e.preventDefault(); panel.focus(); return; }
        const first = list2[0], last = list2[list2.length - 1];
        const cur = document.activeElement;
        if (e.shiftKey) {
          if (cur === first || !panel.contains(cur)) { e.preventDefault(); last.focus(); }
        } else {
          if (cur === last || !panel.contains(cur)) { e.preventDefault(); first.focus(); }
        }
      }
    }

    scrim.addEventListener('mousedown', close);
    // Guard clicks inside the panel from bubbling to a global "outside" handler.
    panel.addEventListener('mousedown', e => e.stopPropagation());
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(frag);

    // Initial population + autofocus (HTML autofocus only fires on page load).
    query('');
    setTimeout(() => input.focus(), 0);

    return { close, el: panel };
  }

  window.openCommandPalette = openCommandPalette;
})();
