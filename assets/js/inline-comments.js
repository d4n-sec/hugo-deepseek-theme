;(function () {
  'use strict';

  /* Threadline inline comments.
     This module is deliberately independent from the comment-thread renderer.
     It adds a selection action, owns the pending quote state, and maps stored
     quote metadata back to ranges in the article. Selected text and API text
     are always written with textContent, never interpreted as HTML. */

  var DSH = (window.DSH = window.DSH || {});
  var MAX_QUOTE_TEXT = 800;
  var MAX_QUOTE_CONTEXT = 120;
  var MAX_QUOTE_HEADING = 200;
  var MAX_QUOTE_OFFSET = 10000000;
  var SELECTION_DELAY = 140;
  var MAX_CANDIDATES = 2000;
  var HIGHLIGHT_NAME = 'threadline-quote';
  var ACTIVE_HIGHLIGHT_NAME = 'threadline-quote-active';
  var CHIP_ATTRIBUTE = 'data-comment-quote-chip';
  var CARD_STATE_ATTRIBUTE = 'data-comment-quote-state';

  var FALLBACK_STRINGS = {
    selectionAction: 'Comment on selection',
    selectionTooLong: 'Select a shorter passage.',
    quoteLabel: 'Quoted selection',
    quoteRemove: 'Remove quoted selection',
    quoteUnlocated: 'This passage could not be located in the current article.',
    quoteLocated: 'Located in the article',
    quoteView: 'View in article'
  };

  var BLOCK_TAGS = {
    ADDRESS: true,
    ARTICLE: true,
    ASIDE: true,
    BLOCKQUOTE: true,
    CAPTION: true,
    DD: true,
    DETAILS: true,
    DIALOG: true,
    DIV: true,
    DL: true,
    DT: true,
    FIELDSET: true,
    FIGCAPTION: true,
    FIGURE: true,
    FOOTER: true,
    FORM: true,
    H1: true,
    H2: true,
    H3: true,
    H4: true,
    H5: true,
    H6: true,
    HEADER: true,
    HGROUP: true,
    HR: true,
    LI: true,
    MAIN: true,
    NAV: true,
    OL: true,
    P: true,
    PRE: true,
    SECTION: true,
    SUMMARY: true,
    TABLE: true,
    TBODY: true,
    TD: true,
    TFOOT: true,
    TH: true,
    THEAD: true,
    TR: true,
    UL: true
  };

  var state = {
    quote: null,
    strings: null,
    initialized: false,
    action: null,
    actionQuote: null,
    actionRange: null,
    actionTooLong: false,
    selectionTimer: null,
    syncPending: false,
    reloadFinishPending: false,
    reloadFinishAttempted: false,
    chip: null,
    activeTimer: null,
    focusTimer: null,
    focusedCards: [],
    observer: null,
    readerObserver: null
  };

  var cardQuoteStore = typeof WeakMap === 'function' ? new WeakMap() : null;
  var cardRangeStore = typeof WeakMap === 'function' ? new WeakMap() : null;
  var knownQuotesById = Object.create(null);

  function $(selector, root) {
    try {
      return (root || document).querySelector(selector);
    } catch (error) {
      return null;
    }
  }

  function $$(selector, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(selector));
    } catch (error) {
      return [];
    }
  }

  function on(target, type, listener, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    try {
      target.addEventListener(type, listener, options);
    } catch (error) {
      target.addEventListener(type, listener, false);
    }
  }

  function make(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function readJSONScript(id) {
    var node = document.getElementById(id);
    var value = {};
    if (!node) return value;
    try {
      var parsed = JSON.parse(node.textContent || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
    } catch (error) {
      value = {};
    }
    return value;
  }

  function readStrings() {
    var raw = readJSONScript('comments-strings');
    return {
      selectionAction: typeof raw.comments_selection_action === 'string' && raw.comments_selection_action
        ? raw.comments_selection_action
        : FALLBACK_STRINGS.selectionAction,
      selectionTooLong: typeof raw.comments_selection_too_long === 'string' && raw.comments_selection_too_long
        ? raw.comments_selection_too_long
        : FALLBACK_STRINGS.selectionTooLong,
      quoteLabel: typeof raw.comments_quote_label === 'string' && raw.comments_quote_label
        ? raw.comments_quote_label
        : FALLBACK_STRINGS.quoteLabel,
      quoteRemove: typeof raw.comments_quote_remove === 'string' && raw.comments_quote_remove
        ? raw.comments_quote_remove
        : FALLBACK_STRINGS.quoteRemove,
      quoteUnlocated: typeof raw.comments_quote_unlocated === 'string' && raw.comments_quote_unlocated
        ? raw.comments_quote_unlocated
        : FALLBACK_STRINGS.quoteUnlocated,
      quoteLocated: typeof raw.comments_quote_located === 'string' && raw.comments_quote_located
        ? raw.comments_quote_located
        : FALLBACK_STRINGS.quoteLocated,
      quoteView: typeof raw.comments_quote_view === 'string' && raw.comments_quote_view
        ? raw.comments_quote_view
        : FALLBACK_STRINGS.quoteView
    };
  }

  function strings() {
    if (!state.strings) state.strings = readStrings();
    return state.strings;
  }

  function getArticle() {
    return $('[data-article-page]');
  }

  function getArticleBody() {
    return $('[data-article-page] [data-article-body]') || $('[data-article-body]')
      || (getCommentForm() ? $('[data-inline-comments-body]') : null);
  }

  function getCommentForm() {
    return $('[data-comment-form]');
  }

  function getCommentTextarea() {
    var form = getCommentForm();
    if (!form) return null;
    return $('[data-comment-body]', form) || $('textarea', form);
  }

  function commentsSelectionAvailable() {
    var root = $('[data-comments-root]');
    if (!root) return true;
    if (root.getAttribute('data-comments-configured') === 'false') return false;
    var configState = root.getAttribute('data-config-state');
    if (configState && configState !== 'configured') return false;
    return !!getCommentForm();
  }

  function toCodePoints(value) {
    var text = String(value == null ? '' : value);
    if (typeof Array.from === 'function') return Array.from(text);
    return text.split('');
  }

  function codePointLength(value) {
    return toCodePoints(value).length;
  }

  function stripControls(value, allowNewline) {
    var characters = toCodePoints(value);
    var output = '';
    for (var index = 0; index < characters.length; index += 1) {
      var character = characters[index];
      var code = character.codePointAt ? character.codePointAt(0) : character.charCodeAt(0);
      if (allowNewline && (character === '\n' || character === '\r')) {
        output += '\n';
        continue;
      }
      if (code < 32 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {
        continue;
      }
      output += character;
    }
    return output;
  }

  function sanitizeContext(value) {
    var characters = toCodePoints(value);
    var cleaned = '';
    for (var index = 0; index < characters.length; index += 1) {
      var character = characters[index];
      var code = character.codePointAt ? character.codePointAt(0) : character.charCodeAt(0);
      if (/\s/.test(character)) {
        cleaned += ' ';
        continue;
      }
      if (code < 32 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {
        continue;
      }
      cleaned += character;
    }
    return cleaned.replace(/\s+/g, ' ').trim();
  }

  function cleanQuoteText(value) {
    return stripControls(value, true).replace(/^\s+|\s+$/g, '');
  }

  function cloneQuote(quote) {
    if (!quote) return null;
    return {
      text: quote.text,
      prefix: quote.prefix,
      suffix: quote.suffix,
      offset: quote.offset,
      heading: quote.heading
    };
  }

  function validOffset(value) {
    return typeof value === 'number' && isFinite(value)
      && Math.floor(value) === value
      && value >= 0
      && value <= MAX_QUOTE_OFFSET;
  }

  function normalizeQuote(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.text !== 'string') return null;
    var text = cleanQuoteText(value.text);
    if (!text || codePointLength(text) > MAX_QUOTE_TEXT) return null;

    if (value.prefix != null && typeof value.prefix !== 'string') return null;
    if (value.suffix != null && typeof value.suffix !== 'string') return null;
    if (value.heading != null && typeof value.heading !== 'string') return null;

    var prefix = sanitizeContext(value.prefix || '');
    var suffix = sanitizeContext(value.suffix || '');
    var heading = sanitizeContext(value.heading || '');
    if (codePointLength(prefix) > MAX_QUOTE_CONTEXT) {
      prefix = toCodePoints(prefix).slice(-MAX_QUOTE_CONTEXT).join('');
    }
    if (codePointLength(suffix) > MAX_QUOTE_CONTEXT) {
      suffix = toCodePoints(suffix).slice(0, MAX_QUOTE_CONTEXT).join('');
    }
    if (codePointLength(heading) > MAX_QUOTE_HEADING) {
      heading = toCodePoints(heading).slice(0, MAX_QUOTE_HEADING).join('');
    }

    var offset = validOffset(value.offset) ? value.offset : 0;
    return {
      text: text,
      prefix: prefix,
      suffix: suffix,
      offset: offset,
      heading: heading
    };
  }

  function quotesEqual(first, second) {
    if (!first || !second) return first === second;
    return first.text === second.text
      && first.prefix === second.prefix
      && first.suffix === second.suffix
      && first.offset === second.offset
      && first.heading === second.heading;
  }

  function emitQuoteChange() {
    var detail = { quote: cloneQuote(state.quote) };
    var event;
    try {
      event = new CustomEvent('threadline:quote-change', {
        bubbles: true,
        cancelable: false,
        detail: detail
      });
    } catch (error) {
      if (document.createEvent) {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent('threadline:quote-change', true, false, detail);
      }
    }
    if (!event) return;
    try {
      document.dispatchEvent(event);
    } catch (error) {
      // A listener exception must not break quote state or the article.
    }
  }

  function getQuote() {
    return cloneQuote(state.quote);
  }

  function hasQuote() {
    return !!state.quote;
  }

  function setQuote(value) {
    try {
      if (value == null) {
        clearQuote();
        return true;
      }
      var quote = normalizeQuote(value);
      if (!quote) return false;
      if (quotesEqual(state.quote, quote)) {
        try {
          ensureChip();
        } catch (chipError) {
          // The quote state remains valid even if the live form is temporarily
          // detached or being re-rendered.
        }
        return true;
      }
      state.quote = quote;
      try {
        ensureChip();
      } catch (chipError) {
        // The composer can be re-rendered by the comments module at any time.
      }
      emitQuoteChange();
      return true;
    } catch (error) {
      return false;
    }
  }

  function clearQuote() {
    var hadQuote = !!state.quote;
    state.quote = null;
    try {
      ensureChip();
    } catch (chipError) {
      // Keep the comment module's quote state clear even without a composer.
    }
    if (hadQuote) emitQuoteChange();
  }

  function chipTextNode(chip) {
    return $('[data-comment-quote-text], [data-composer-quote-text], .comment-composer__quote-text, .comment-quote-chip__text', chip);
  }

  function chipLabelNode(chip) {
    return $('[data-comment-quote-label], .comment-composer__quote-label span:last-child, .comment-quote-chip__label', chip);
  }

  function chipRemoveNode(chip) {
    return $('[data-comment-quote-remove], [data-composer-quote-remove], .comment-quote-chip__remove', chip);
  }

  function focusComposerTextarea() {
    var textarea = getCommentTextarea();
    if (!textarea || textarea.disabled) return;
    try {
      textarea.focus({ preventScroll: true });
    } catch (error) {
      textarea.focus();
    }
  }

  function bindChipRemove(chip) {
    var remove = chipRemoveNode(chip);
    if (!remove || remove.getAttribute('data-threadline-quote-remove-bound') === 'true') return;
    remove.setAttribute('data-threadline-quote-remove-bound', 'true');
    on(remove, 'click', function (event) {
      if (event) event.preventDefault();
      clearQuote();
      focusComposerTextarea();
    });
  }

  function ensureChip() {
    var form = getCommentForm();
    if (!form) return;
    // The comments module owns a compact composer chip in the normal template.
    // Reuse it when present; only fall back to creating our own chip for themes
    // or fixtures where comments.html does not provide one.
    var externalChip = form.querySelector('[data-composer-quote]');
    var ownChip = form.querySelector('[' + CHIP_ATTRIBUTE + ']');
    if (externalChip && ownChip) {
      if (ownChip.parentNode) ownChip.parentNode.removeChild(ownChip);
      ownChip = null;
    }
    var chip = externalChip || ownChip;
    if (!state.quote) {
      if (chip && chip.hasAttribute(CHIP_ATTRIBUTE)) {
        if (chip.parentNode) chip.parentNode.removeChild(chip);
        chip = null;
      } else if (chip) {
        chip.hidden = true;
        var emptyText = chipTextNode(chip);
        if (emptyText) emptyText.textContent = '';
      }
      state.chip = null;
      return;
    }

    if (!chip) chip = createChip();
    state.chip = chip;
    updateChip(chip);
    bindChipRemove(chip);

    // Do not reposition a quote chip supplied by the comments template. A
    // fallback chip is inserted immediately before the textarea as required.
    if (!chip.hasAttribute(CHIP_ATTRIBUTE)) return;
    var textarea = getCommentTextarea();
    var target = textarea && textarea.parentNode ? textarea : form.firstChild;
    if (target && chip.parentNode !== target.parentNode) {
      target.parentNode.insertBefore(chip, target);
    } else if (target && chip.nextSibling !== target) {
      target.parentNode.insertBefore(chip, target);
    }
  }

  function createChip() {
    var chip = make('div', 'comment-quote-chip');
    chip.setAttribute(CHIP_ATTRIBUTE, '');
    chip.setAttribute('data-quote-chip', '');

    var mark = make('span', 'comment-quote-chip__mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '\u201c';

    var body = make('div', 'comment-quote-chip__body');
    var label = make('span', 'comment-quote-chip__label');
    label.setAttribute('data-comment-quote-label', '');
    var text = make('blockquote', 'comment-quote-chip__text');
    text.setAttribute('data-comment-quote-text', '');
    body.appendChild(label);
    body.appendChild(text);

    var remove = make('button', 'comment-quote-chip__remove');
    remove.type = 'button';
    remove.setAttribute('data-comment-quote-remove', '');
    remove.setAttribute('aria-label', strings().quoteRemove);
    remove.textContent = '\u00d7';

    var status = make('span', 'comment-quote-chip__status');
    status.setAttribute('data-comment-quote-chip-status', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    chip.appendChild(mark);
    chip.appendChild(body);
    chip.appendChild(remove);
    chip.appendChild(status);
    return chip;
  }

  function updateChip(chip) {
    if (!chip || !state.quote) return;
    var label = chipLabelNode(chip);
    var text = chipTextNode(chip);
    var remove = chipRemoveNode(chip);
    chip.hidden = false;
    if (label) label.textContent = strings().quoteLabel;
    if (text) {
      if (text.textContent !== state.quote.text) {
        text.textContent = state.quote.text;
      }
      text.title = state.quote.text;
    }
    if (remove) {
      remove.setAttribute('aria-label', strings().quoteRemove);
      remove.title = strings().quoteRemove;
    }
  }

  function selectionIsInsideBody(range, body) {
    if (!range || !body) return false;
    if (range.collapsed) return false;
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) {
      // A selection that starts at the body boundary resolves to the body
      // element itself, which contains() also accepts.
      if (range.startContainer !== body || range.endContainer !== body) return false;
    }
    if (typeof range.intersectsNode === 'function') {
      try {
        if (!range.intersectsNode(body)) return false;
      } catch (error) {
        return false;
      }
    }
    return true;
  }

  function firstTextPoint(node, index) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      var segment = index.nodeMap.get(node);
      if (!segment) return null;
      return { node: node, offset: 0, flat: segment.start };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    var children = node.childNodes;
    for (var childIndex = 0; childIndex < children.length; childIndex += 1) {
      var point = firstTextPoint(children[childIndex], index);
      if (point) return point;
    }
    return null;
  }

  function lastTextPoint(node, index) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      var segment = index.nodeMap.get(node);
      if (!segment) return null;
      return { node: node, offset: segment.length, flat: segment.start + segment.length };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    var children = node.childNodes;
    for (var childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      var point = lastTextPoint(children[childIndex], index);
      if (point) return point;
    }
    return null;
  }

  function resolveBoundaryPoint(container, offset, start, index) {
    if (!container) return null;
    if (container.nodeType === Node.TEXT_NODE) {
      var segment = index.nodeMap.get(container);
      if (!segment) return null;
      var local = Math.max(0, Math.min(segment.length, Number(offset) || 0));
      return { node: container, offset: local, flat: segment.start + local };
    }
    if (container.nodeType !== Node.ELEMENT_NODE) return null;
    var children = container.childNodes;
    var childOffset = Math.max(0, Math.min(children.length, Number(offset) || 0));
    if (start) {
      for (var startIndex = childOffset; startIndex < children.length; startIndex += 1) {
        var next = firstTextPoint(children[startIndex], index);
        if (next) return next;
      }
      return null;
    }
    for (var endIndex = Math.min(childOffset - 1, children.length - 1); endIndex >= 0; endIndex -= 1) {
      var previous = lastTextPoint(children[endIndex], index);
      if (previous) return previous;
    }
    return null;
  }

  function buildArticleIndex() {
    var body = getArticleBody();
    if (!body) return null;
    var index = {
      body: body,
      flat: '',
      segments: [],
      nodeMap: typeof Map === 'function' ? new Map() : null,
      headings: []
    };

    function appendBoundary() {
      if (!index.flat) return;
      if (index.flat.charAt(index.flat.length - 1) !== '\n') index.flat += '\n';
    }

    function appendText(node) {
      var value = node.nodeValue || '';
      if (!value) return;
      var segment = {
        node: node,
        start: index.flat.length,
        length: value.length
      };
      index.segments.push(segment);
      if (index.nodeMap) index.nodeMap.set(node, segment);
      index.flat += value;
    }

    function walk(node) {
      var children = node.childNodes;
      for (var childIndex = 0; childIndex < children.length; childIndex += 1) {
        var child = children[childIndex];
        if (child.nodeType === Node.TEXT_NODE) {
          appendText(child);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        var tag = child.tagName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
        if (child.hasAttribute('hidden')) continue;
        if (tag === 'BR') {
          appendBoundary();
          continue;
        }
        var block = BLOCK_TAGS[tag] === true;
        if (block) appendBoundary();
        walk(child);
        if (block) appendBoundary();
      }
    }

    walk(body);

    // Older browsers without Map are supported for selection; locating returns
    // an empty result if the index cannot map back to text nodes.
    if (!index.nodeMap) {
      index.nodeMap = {
        get: function (node) {
          for (var segmentIndex = 0; segmentIndex < index.segments.length; segmentIndex += 1) {
            if (index.segments[segmentIndex].node === node) return index.segments[segmentIndex];
          }
          return null;
        }
      };
    }

    var headings = $$('h1, h2, h3, h4, h5, h6', body);
    headings.forEach(function (heading) {
      var point = firstTextPoint(heading, index);
      if (!point) return;
      index.headings.push({
        id: typeof heading.id === 'string' ? heading.id : '',
        start: point.flat
      });
    });
    return index;
  }

  function headingAt(index, flatOffset) {
    var id = '';
    for (var headingIndex = 0; headingIndex < index.headings.length; headingIndex += 1) {
      var heading = index.headings[headingIndex];
      if (heading.start <= flatOffset) id = heading.id;
      else break;
    }
    return id;
  }

  function contextBefore(index, offset) {
    if (!offset) return '';
    var prefix = toCodePoints(index.flat.slice(0, offset)).slice(-MAX_QUOTE_CONTEXT).join('');
    return sanitizeContext(prefix);
  }

  function contextAfter(index, offset) {
    if (offset >= index.flat.length) return '';
    var suffix = toCodePoints(index.flat.slice(offset)).slice(0, MAX_QUOTE_CONTEXT).join('');
    return sanitizeContext(suffix);
  }

  function describeSelection() {
    if (isReaderBusy()) return null;
    var body = getArticleBody();
    if (!body) return null;
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    if (!selectionIsInsideBody(range, body)) return null;
    if (!body.getClientRects || !body.getClientRects().length) return null;

    var index = buildArticleIndex();
    if (!index || !index.flat) return null;
    var startPoint = resolveBoundaryPoint(range.startContainer, range.startOffset, true, index);
    var endPoint = resolveBoundaryPoint(range.endContainer, range.endOffset, false, index);
    if (!startPoint || !endPoint || startPoint.flat >= endPoint.flat) return null;

    var raw = index.flat.slice(startPoint.flat, endPoint.flat);
    if (!raw || !/\S/.test(raw)) return null;
    var leading = raw.match(/^\s+/);
    var trailing = raw.match(/\s+$/);
    var trimStart = startPoint.flat + (leading ? leading[0].length : 0);
    var trimEnd = endPoint.flat - (trailing ? trailing[0].length : 0);
    if (trimEnd <= trimStart) return null;

    var selected = index.flat.slice(trimStart, trimEnd);
    var text = cleanQuoteText(selected);
    if (!text) return null;
    var clippedRange = range.cloneRange();
    if (codePointLength(text) > MAX_QUOTE_TEXT) {
      return { tooLong: true, length: codePointLength(text), range: clippedRange };
    }

    return {
      tooLong: false,
      range: clippedRange,
      quote: {
        text: text,
        prefix: contextBefore(index, trimStart),
        suffix: contextAfter(index, trimEnd),
        offset: trimStart,
        heading: headingAt(index, trimStart)
      }
    };
  }

  function isReaderBusy() {
    var article = getArticle();
    var body = getArticleBody();
    if (article) {
      var readerState = String(article.getAttribute('data-reader-state') || '').toLowerCase();
      if (readerState && readerState !== 'complete' && readerState !== 'static') return true;
      if (article.classList && article.classList.contains('is-reader-animating')) return true;
    }
    if (body) {
      if (body.getAttribute('aria-busy') === 'true') return true;
    }
    var stream = article ? $('[data-reader-stream]', article) : null;
    if (stream && !stream.hidden) return true;
    return false;
  }

  function isReloadNavigation() {
    try {
      var entries = window.performance && window.performance.getEntriesByType
        ? window.performance.getEntriesByType('navigation') : [];
      if (entries.length && entries[0].type) return entries[0].type === 'reload';
      return !!(window.performance && window.performance.navigation
        && window.performance.navigation.type === 1);
    } catch (error) {
      return false;
    }
  }

  function finishReloadReaderWhenReady() {
    if (!state.reloadFinishPending) return;
    var article = getArticle();
    var readerState = article ? String(article.getAttribute('data-reader-state') || '').toLowerCase() : '';
    // Keep the initial Thinking state; only finish once streaming has begun.
    if (!readerState || readerState === 'idle' || readerState === 'thinking') return;
    state.reloadFinishPending = false;
    state.reloadFinishAttempted = true;
    if (readerState !== 'streaming' || !DSH.reader || typeof DSH.reader.finish !== 'function') return;
    try {
      DSH.reader.finish({ announce: false, focus: false });
    } catch (error) {
      // If the reader cannot finish, its normal completion will trigger sync.
    }
  }

  function ensureAction() {
    if (state.action || !document.body) return state.action;
    var action = make('button', 'threadline-selection-action');
    action.type = 'button';
    action.hidden = true;
    action.setAttribute('data-threadline-selection-action', '');
    action.setAttribute('data-comment-selection-action', '');
    action.setAttribute('aria-label', strings().selectionAction);
    action.setAttribute('title', strings().selectionAction);

    on(action, 'pointerdown', function (event) {
      // Keep the browser selection alive while the pointer is on the action.
      if (!event || event.pointerType === 'mouse' || !event.pointerType) {
        event.preventDefault();
      }
    });
    on(action, 'mousedown', function (event) {
      event.preventDefault();
    });
    on(action, 'click', handleActionClick);
    document.body.appendChild(action);
    state.action = action;
    return action;
  }

  function handleActionClick(event) {
    if (event) event.preventDefault();
    if (state.actionTooLong) {
      if (typeof DSH.toast === 'function') {
        DSH.toast(strings().selectionTooLong, { tone: 'error' });
      }
      return;
    }
    var quote = state.actionQuote;
    if (!quote) {
      hideAction();
      return;
    }
    var applied = setQuote(quote);
    hideAction();
    if (!applied) return;
    var textarea = getCommentTextarea();
    if (textarea && !textarea.disabled) {
      try {
        textarea.focus({ preventScroll: true });
      } catch (error) {
        textarea.focus();
      }
    }
  }

  function intersection(first, second) {
    if (!first || !second) return false;
    return first.left < second.right
      && first.right > second.left
      && first.top < second.bottom
      && first.bottom > second.top;
  }

  function composerRect() {
    var dock = $('.comment-dock[data-dock-ready]') || $('[data-comment-dock][data-dock-ready]') || $('.comment-dock');
    if (!dock) return null;
    var rect = dock.getBoundingClientRect();
    if (!rect || !rect.height) return null;
    return rect;
  }

  function placeAction(range) {
    var action = ensureAction();
    if (!action || !range) {
      hideAction();
      return false;
    }
    var rects;
    try {
      rects = Array.prototype.slice.call(range.getClientRects ? range.getClientRects() : []);
    } catch (error) {
      rects = [];
    }
    if (!rects.length) {
      var fallback = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
      if (fallback) rects = [fallback];
    }
    var visible = rects.filter(function (rect) {
      return rect && rect.width >= 0 && rect.height >= 0
        && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    var anchor = visible.length ? visible[visible.length - 1] : rects[rects.length - 1];
    if (!anchor) {
      hideAction();
      return false;
    }

    action.hidden = false;
    action.style.visibility = 'hidden';
    var width = action.offsetWidth || 0;
    var height = action.offsetHeight || 0;
    var topbar = $('.topbar');
    var topLimit = topbar ? topbar.getBoundingClientRect().bottom + 10 : 10;
    var bottomLimit = window.innerHeight - 12;
    var dock = composerRect();
    if (dock) bottomLimit = Math.min(bottomLimit, dock.top - 10);

    var below = anchor.bottom + 8;
    var above = anchor.top - height - 8;
    var top = below + height <= bottomLimit ? below : above;
    top = Math.max(topLimit, Math.min(top, bottomLimit - height));
    if (!isFinite(top) || top < topLimit || top + height > bottomLimit) {
      action.hidden = true;
      action.style.visibility = '';
      return false;
    }
    var left = anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    action.style.left = Math.round(left) + 'px';
    action.style.top = Math.round(top) + 'px';
    action.style.visibility = '';

    var actionRect = action.getBoundingClientRect();
    if (dock && intersection(actionRect, dock)) {
      action.hidden = true;
      return false;
    }
    return true;
  }

  function hideAction() {
    if (state.action) {
      state.action.hidden = true;
      state.action.style.visibility = '';
    }
    state.actionQuote = null;
    state.actionRange = null;
    state.actionTooLong = false;
  }

  function updateSelectionAction() {
    if (!state.initialized) return;
    var body = getArticleBody();
    if (!body || isReaderBusy() || !commentsSelectionAvailable()) {
      hideAction();
      return;
    }
    var details;
    try {
      details = describeSelection();
    } catch (error) {
      hideAction();
      return;
    }
    if (!details) {
      hideAction();
      return;
    }
    var action = ensureAction();
    if (!action) return;

    if (details.tooLong) {
      state.actionTooLong = true;
      state.actionQuote = null;
      state.actionRange = details.range;
      action.textContent = strings().selectionTooLong;
      action.setAttribute('aria-label', strings().selectionTooLong);
      action.setAttribute('title', strings().selectionTooLong);
      action.setAttribute('aria-disabled', 'true');
      action.setAttribute('data-action-state', 'too-long');
    } else {
      state.actionTooLong = false;
      state.actionQuote = details.quote;
      state.actionRange = details.range;
      action.textContent = strings().selectionAction;
      action.setAttribute('aria-label', strings().selectionAction);
      action.setAttribute('title', strings().selectionAction);
      action.removeAttribute('aria-disabled');
      action.setAttribute('data-action-state', 'ready');
    }
    if (!placeAction(details.range)) hideAction();
  }

  function scheduleSelectionCheck(delay) {
    if (!state.initialized) return;
    window.clearTimeout(state.selectionTimer);
    state.selectionTimer = window.setTimeout(function () {
      state.selectionTimer = null;
      updateSelectionAction();
    }, typeof delay === 'number' ? delay : SELECTION_DELAY);
  }

  function normalizeWithMap(value) {
    var source = String(value == null ? '' : value);
    var characters = toCodePoints(source);
    var output = '';
    var starts = [];
    var ends = [];
    var utf16Offset = 0;
    var lastWasSpace = false;

    for (var index = 0; index < characters.length; index += 1) {
      var character = characters[index];
      var characterStart = utf16Offset;
      utf16Offset += character.length;
      if (/\s/.test(character)) {
        if (output && !lastWasSpace) {
          output += ' ';
          starts.push(characterStart);
          ends.push(utf16Offset);
          lastWasSpace = true;
        }
        continue;
      }
      var normalized = character;
      if (typeof character.normalize === 'function') {
        try {
          normalized = character.normalize('NFKC');
        } catch (error) {
          normalized = character;
        }
      }
      if (!normalized) continue;
      output += normalized;
      for (var unit = 0; unit < normalized.length; unit += 1) {
        starts.push(characterStart);
        ends.push(utf16Offset);
      }
      lastWasSpace = false;
    }
    while (output && output.charAt(output.length - 1) === ' ') {
      output = output.slice(0, -1);
      starts.pop();
      ends.pop();
    }
    return { text: output, starts: starts, ends: ends };
  }

  function normalizedContext(value) {
    return normalizeWithMap(String(value || '')).text.trim();
  }

  function allOccurrences(haystack, needle) {
    var occurrences = [];
    if (!haystack || !needle || needle.length > haystack.length) return occurrences;
    var from = 0;
    while (from <= haystack.length - needle.length) {
      var found = haystack.indexOf(needle, from);
      if (found === -1) break;
      occurrences.push(found);
      if (occurrences.length >= MAX_CANDIDATES) break;
      from = found + 1;
    }
    return occurrences;
  }

  function contextSuffixBefore(text, offset, length) {
    if (!length) return '';
    var output = '';
    var remaining = length;
    var index = offset - 1;
    while (index >= 0 && remaining > 0) {
      var character = text.charAt(index);
      if (!/\s/.test(character)) {
        output = character + output;
        remaining -= 1;
      }
      index -= 1;
    }
    return remaining === 0 ? output : '';
  }

  function contextPrefixAfter(text, offset, length) {
    if (!length) return '';
    var output = '';
    var remaining = length;
    var index = offset;
    while (index < text.length && remaining > 0) {
      var character = text.charAt(index);
      if (!/\s/.test(character)) {
        output += character;
        remaining -= 1;
      }
      index += 1;
    }
    return remaining === 0 ? output : '';
  }

  function rangeForOffsets(index, start, end) {
    if (!index || start == null || end == null || end <= start) return null;
    var first = null;
    var last = null;
    for (var segmentIndex = 0; segmentIndex < index.segments.length; segmentIndex += 1) {
      var segment = index.segments[segmentIndex];
      var segmentEnd = segment.start + segment.length;
      if (segmentEnd <= start) continue;
      if (segment.start >= end) break;
      var localStart = Math.max(0, start - segment.start);
      var localEnd = Math.min(segment.length, end - segment.start);
      if (localEnd <= localStart) continue;
      if (!first) first = { segment: segment, offset: localStart };
      last = { segment: segment, offset: localEnd };
    }
    if (!first || !last) return null;
    try {
      var range = document.createRange();
      range.setStart(first.segment.node, first.offset);
      if (first.segment === last.segment) {
        range.setEnd(first.segment.node, last.offset);
      } else {
        range.setEnd(last.segment.node, last.offset);
      }
      return range;
    } catch (error) {
      return null;
    }
  }

  function locateInIndex(index, quote) {
    if (!index || !quote) return { status: 'unlocated', reason: 'no-quote' };
    var normalizedIndex = normalizeWithMap(index.flat);
    var normalizedQuote = normalizeWithMap(quote.text);
    if (!normalizedQuote.text) return { status: 'unlocated', reason: 'no-text' };
    var prefix = normalizedContext(quote.prefix);
    var suffix = normalizedContext(quote.suffix);
    var hasContext = !!(prefix || suffix);
    // A matching offset and heading cannot identify an occurrence after edits:
    // another copy of the same text may have shifted into that exact position.
    if (!hasContext) return { status: 'unlocated', reason: 'insufficient-context' };
    var prefixKey = prefix.replace(/\s+/g, '');
    var suffixKey = suffix.replace(/\s+/g, '');
    var occurrences = allOccurrences(normalizedIndex.text, normalizedQuote.text);
    if (!occurrences.length) return { status: 'unlocated', reason: 'text-missing' };

    var candidates = [];
    for (var occurrenceIndex = 0; occurrenceIndex < occurrences.length; occurrenceIndex += 1) {
      var occurrence = occurrences[occurrenceIndex];
      var lastUnit = occurrence + normalizedQuote.text.length - 1;
      var rawStart = normalizedIndex.starts[occurrence];
      var rawEnd = normalizedIndex.ends[lastUnit];
      if (rawStart == null || rawEnd == null || rawEnd <= rawStart) continue;

      // Contexts are stored publicly and pass through backend control-character
      // cleanup, so compare their NFKC form with separators ignored. The exact
      // quote text itself remains a mandatory whitespace-collapsed match above.
      var prefixMatch = prefixKey
        ? contextSuffixBefore(normalizedIndex.text, occurrence, prefixKey.length) === prefixKey
        : null;
      var suffixMatch = suffixKey
        ? contextPrefixAfter(normalizedIndex.text, occurrence + normalizedQuote.text.length, suffixKey.length) === suffixKey
        : null;
      var contextMatch = (!prefix || prefixMatch) && (!suffix || suffixMatch);

      var candidateHeading = headingAt(index, rawStart);
      // Stored context is authoritative whether the text occurs once or many
      // times. If it fails, heading and offset are not safe fallbacks.
      if (!contextMatch) continue;

      var offsetValue = validOffset(quote.offset) ? quote.offset : 0;
      candidates.push({
        start: rawStart,
        end: rawEnd,
        heading: candidateHeading,
        distance: Math.abs(rawStart - offsetValue),
        tier: 3
      });
    }

    // Deduplicate candidates that map to the same original text offsets. NFKC
    // can expand one source character into several normalized code units.
    var seen = Object.create(null);
    candidates = candidates.filter(function (candidate) {
      var key = candidate.start + ':' + candidate.end;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
    if (!candidates.length) {
      return { status: 'unlocated', reason: 'no-context-match' };
    }

    // More than one occurrence can satisfy the same stored context, for
    // example duplicated paragraphs. Do not pick one by offset or heading.
    if (candidates.length > 1) {
      return { status: 'unlocated', reason: 'ambiguous' };
    }

    var chosen = candidates[0];
    var range = rangeForOffsets(index, chosen.start, chosen.end);
    if (!range) return { status: 'unlocated', reason: 'range-unavailable' };
    return {
      status: 'located',
      range: range,
      start: chosen.start,
      end: chosen.end,
      heading: chosen.heading,
      confidence: chosen.tier,
      distance: chosen.distance
    };
  }

  function findCardById(id) {
    if (id == null) return null;
    var target = String(id);
    var cards = $$('[data-comment-card]');
    for (var cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
      if (String(cards[cardIndex].getAttribute('data-comment-id') || '') === target) return cards[cardIndex];
    }
    return null;
  }

  function isCard(node) {
    return !!(node && node.nodeType === Node.ELEMENT_NODE && node.matches
      && node.matches('[data-comment-card]'));
  }

  function parseQuote(value) {
    if (value == null) return null;
    if (typeof value === 'string') {
      try {
        return normalizeQuote(JSON.parse(value));
      } catch (error) {
        return null;
      }
    }
    return normalizeQuote(value);
  }

  function quoteInfoForCard(card) {
    if (!card) return { card: null, quote: null, present: false, id: '' };
    var id = String(card.getAttribute('data-comment-id') || '');
    if (cardQuoteStore && cardQuoteStore.has(card)) {
      return { card: card, quote: cardQuoteStore.get(card), present: true, id: id };
    }
    var raw = card.getAttribute('data-comment-quote');
    if (raw != null && raw !== '') {
      return { card: card, quote: parseQuote(raw), present: true, id: id };
    }
    // Some comment renderers store the JSON payload on a nested quote block
    // marked with an otherwise empty data-comment-quote attribute.
    var nested = $('[data-comment-quote]', card);
    if (nested) {
      var nestedRaw = nested.getAttribute('data-comment-quote');
      if (nestedRaw) {
        return { card: card, quote: parseQuote(nestedRaw), present: true, id: id };
      }
    }
    if (id && Object.prototype.hasOwnProperty.call(knownQuotesById, id)) {
      return { card: card, quote: knownQuotesById[id], present: true, id: id };
    }
    return { card: card, quote: null, present: false, id: id };
  }

  function storeCardQuote(card, value) {
    if (!card) return;
    var quote = parseQuote(value);
    if (quote) {
      if (cardQuoteStore) cardQuoteStore.set(card, quote);
      else card._threadlineQuote = quote;
    } else {
      if (cardQuoteStore) cardQuoteStore.delete(card);
      else card._threadlineQuote = null;
    }
    var id = String(card.getAttribute('data-comment-id') || '');
    if (id) {
      if (quote) knownQuotesById[id] = quote;
      else delete knownQuotesById[id];
    }
  }

  function storeKnownQuote(id, value) {
    if (id == null || id === '') return;
    var key = String(id);
    var quote = parseQuote(value);
    if (quote) knownQuotesById[key] = quote;
    else delete knownQuotesById[key];
  }

  function resolveTarget(commentOrCard) {
    if (!commentOrCard) return { card: null, quote: null, present: false, id: '' };
    if (commentOrCard.nodeType === Node.ELEMENT_NODE) {
      if (isCard(commentOrCard)) return quoteInfoForCard(commentOrCard);
      var nested = $('[data-comment-card]', commentOrCard);
      if (nested) return quoteInfoForCard(nested);
      if (commentOrCard.matches && commentOrCard.matches('[data-comment-id]')) {
        return quoteInfoForCard(commentOrCard);
      }
      return { card: null, quote: null, present: false, id: '' };
    }
    if (typeof commentOrCard === 'string' || typeof commentOrCard === 'number') {
      var idValue = String(commentOrCard);
      var card = findCardById(idValue);
      if (card) return quoteInfoForCard(card);
      if (Object.prototype.hasOwnProperty.call(knownQuotesById, idValue)) {
        return { card: null, quote: knownQuotesById[idValue], present: true, id: idValue };
      }
      return { card: null, quote: null, present: false, id: idValue };
    }
    if (typeof commentOrCard === 'object') {
      var objectId = commentOrCard.id != null ? String(commentOrCard.id) : '';
      var hasQuoteProperty = Object.prototype.hasOwnProperty.call(commentOrCard, 'quote');
      var hasText = typeof commentOrCard.text === 'string';
      if (!hasQuoteProperty && !hasText) {
        return { card: null, quote: null, present: false, id: objectId };
      }
      var rawQuote = hasQuoteProperty ? commentOrCard.quote : commentOrCard;
      var quote = parseQuote(rawQuote);
      var targetCard = findCardById(objectId);
      if (targetCard) storeCardQuote(targetCard, rawQuote);
      else if (objectId) storeKnownQuote(objectId, rawQuote);
      return {
        card: targetCard,
        quote: quote,
        present: hasQuoteProperty ? rawQuote != null : hasText,
        id: objectId
      };
    }
    return { card: null, quote: null, present: false, id: '' };
  }

  function statusNode(card) {
    var node = $('[data-comment-quote-status]', card);
    if (node) return node;
    node = make('p', 'comment-card__quote-status threadline-quote-status');
    node.setAttribute('data-comment-quote-status', '');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    var body = $('.comment-card__body', card);
    if (body && body.parentNode) body.parentNode.insertBefore(node, body);
    else card.appendChild(node);
    return node;
  }

  function clearCardState(card) {
    if (!card) return;
    card.removeAttribute(CARD_STATE_ATTRIBUTE);
    card.classList.remove('is-quote-located', 'is-quote-unlocated');
    var status = $('[data-comment-quote-status]', card);
    if (status) {
      status.textContent = '';
      status.hidden = true;
    }
    if (cardRangeStore) cardRangeStore.delete(card);
    else card._threadlineRange = null;
  }

  function applyCardResult(card, result, quote) {
    if (!card) return;
    if (!quote && result.status !== 'unlocated') {
      clearCardState(card);
      return;
    }
    var status = statusNode(card);
    if (result.status === 'located') {
      card.setAttribute(CARD_STATE_ATTRIBUTE, 'located');
      card.classList.add('is-quote-located');
      card.classList.remove('is-quote-unlocated');
      if (status) {
        status.textContent = strings().quoteLocated;
        status.hidden = false;
      }
      if (cardRangeStore) cardRangeStore.set(card, result.range);
      else card._threadlineRange = result.range;
    } else {
      card.setAttribute(CARD_STATE_ATTRIBUTE, 'unlocated');
      card.classList.add('is-quote-unlocated');
      card.classList.remove('is-quote-located');
      if (status) {
        status.textContent = strings().quoteUnlocated;
        status.hidden = false;
      }
      if (cardRangeStore) cardRangeStore.delete(card);
      else card._threadlineRange = null;
    }
  }

  function cardRange(card) {
    if (cardRangeStore) return cardRangeStore.get(card) || null;
    return card._threadlineRange || null;
  }

  function highlightCards(cards) {
    window.clearTimeout(state.focusTimer);
    state.focusedCards.forEach(function (card) { card.classList.remove('is-quote-focused'); });
    state.focusedCards = cards.filter(function (card) { return !!card; });
    state.focusedCards.forEach(function (card) { card.classList.add('is-quote-focused'); });
    if (!state.focusedCards.length) return;
    state.focusTimer = window.setTimeout(function () {
      state.focusedCards.forEach(function (card) { card.classList.remove('is-quote-focused'); });
      state.focusedCards = [];
      state.focusTimer = null;
    }, 2500);
  }

  function cardsAtPoint(x, y) {
    return $$('[data-comment-card]').filter(function (card) {
      if (card.getAttribute(CARD_STATE_ATTRIBUTE) !== 'located') return false;
      var range = cardRange(card);
      if (!range || typeof range.getClientRects !== 'function') return false;
      try {
        return Array.prototype.some.call(range.getClientRects(), function (rect) {
          // Include the painted underline just outside the glyph's box.
          return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right
            && y >= rect.top && y <= rect.bottom + 3;
        });
      } catch (error) {
        return false;
      }
    });
  }

  function openCommentsForCards(cards) {
    if (!cards.length) return;
    var panel = $('[data-comments-panel]');
    var toggle = $('[data-comments-panel-toggle]');
    if (!panel || !toggle || toggle.disabled) return;
    if (panel.hidden) toggle.click();
    if (panel.hidden) return;
    highlightCards(cards);
    var reveal = function () {
      if (panel.hidden || !document.contains(cards[0])) return;
      var scroll = $('[data-comments-panel-scroll]', panel);
      if (scroll) {
        var frame = scroll.getBoundingClientRect();
        var card = cards[0].getBoundingClientRect();
        if (card.top < frame.top || card.bottom > frame.bottom) {
          scroll.scrollTop += card.top - frame.top - 8;
        }
      }
      var button = $('[data-comment-quote-view]', cards[0]);
      if (button && typeof button.focus === 'function') button.focus({ preventScroll: true });
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(reveal);
    else window.setTimeout(reveal, 0);
  }

  function openCommentAtPoint(event) {
    if (!event || event.defaultPrevented || event.button !== 0 || event.detail !== 1 || isReaderBusy()) return;
    var registry = window.CSS && window.CSS.highlights;
    // Never make ordinary, unmarked text act like an annotation link.
    if (!registry || typeof registry.get !== 'function' || !registry.get(HIGHLIGHT_NAME)) return;
    var target = event.target;
    var body = getArticleBody();
    if (!body || !target || !body.contains(target)) return;
    if (target.closest && target.closest('a, button, input, select, textarea, summary, [role="button"], [contenteditable="true"]')) return;
    var selection = window.getSelection ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    var cards = cardsAtPoint(event.clientX, event.clientY);
    if (cards.length) openCommentsForCards(cards);
  }

  function setHighlight(name, ranges) {
    var registry = window.CSS && window.CSS.highlights;
    var HighlightConstructor = window.Highlight;
    if (!registry || typeof HighlightConstructor !== 'function') return;
    try {
      if (!ranges.length) {
        if (typeof registry.delete === 'function') registry.delete(name);
        return;
      }
      var highlight = new HighlightConstructor();
      ranges.forEach(function (range) {
        if (range) highlight.add(range);
      });
      registry.set(name, highlight);
    } catch (error) {
      // The Custom Highlight API is an enhancement; card state still works.
    }
  }

  function refreshHighlights() {
    var ranges = [];
    $$('[data-comment-card]').forEach(function (card) {
      var range = cardRange(card);
      if (range) ranges.push(range);
    });
    setHighlight(HIGHLIGHT_NAME, ranges);
  }

  function clearActiveHighlight() {
    window.clearTimeout(state.activeTimer);
    state.activeTimer = null;
    setHighlight(ACTIVE_HIGHLIGHT_NAME, []);
  }

  function setActiveHighlight(range) {
    clearActiveHighlight();
    if (!range) return;
    setHighlight(ACTIVE_HIGHLIGHT_NAME, [range]);
    var delay = typeof DSH.prefersReducedMotion === 'function' && DSH.prefersReducedMotion() ? 1800 : 2600;
    state.activeTimer = window.setTimeout(function () {
      state.activeTimer = null;
      setHighlight(ACTIVE_HIGHLIGHT_NAME, []);
    }, delay);
  }

  function summaryTargets(input) {
    var targets = [];
    var seen = [];
    function addTarget(card, explicitQuote, hasExplicit) {
      if (!card) return;
      if (seen.indexOf(card) !== -1) return;
      seen.push(card);
      if (hasExplicit) storeCardQuote(card, explicitQuote);
      targets.push({ card: card, explicit: !!hasExplicit });
    }
    function addNode(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      if (isCard(node)) {
        addTarget(node, null, false);
        return;
      }
      var nested = $$('[data-comment-card]', node);
      nested.forEach(function (card) {
        addTarget(card, null, false);
      });
    }
    function addComment(comment) {
      if (!comment || typeof comment !== 'object') return;
      var id = comment.id != null ? String(comment.id) : '';
      var hasQuote = Object.prototype.hasOwnProperty.call(comment, 'quote');
      if (hasQuote) storeKnownQuote(id, comment.quote);
      var card = findCardById(id);
      if (!card) return;
      addTarget(card, comment.quote, hasQuote);
    }

    if (!input) {
      $$('[data-comment-card]').forEach(function (card) {
        addTarget(card, null, false);
      });
    } else if (input.nodeType === Node.ELEMENT_NODE) {
      addNode(input);
    } else if (typeof input.length === 'number' && typeof input !== 'string') {
      for (var index = 0; index < input.length; index += 1) {
        var entry = input[index];
        if (entry && entry.nodeType === Node.ELEMENT_NODE) addNode(entry);
        else addComment(entry);
      }
    } else if (typeof input === 'object') {
      if (input.nodeType === Node.ELEMENT_NODE) addNode(input);
      else addComment(input);
    }
    return targets;
  }

  function targetQuote(card) {
    return quoteInfoForCard(card);
  }

  function sync(commentsOrCards) {
    try {
      var targets = summaryTargets(commentsOrCards);
      if (isReaderBusy()) {
        state.syncPending = true;
        if (!state.reloadFinishAttempted && isReloadNavigation() && targets.some(function (target) {
          var info = targetQuote(target.card);
          return info.present && !!info.quote;
        })) {
          state.reloadFinishPending = true;
          finishReloadReaderWhenReady();
        }
        if (isReaderBusy()) return { pending: true, located: 0, unlocated: 0 };
        state.syncPending = false;
      }
      var body = getArticleBody();
      if (!body) return { pending: false, located: 0, unlocated: 0 };
      var index = buildArticleIndex();
      if (!index) return { pending: false, located: 0, unlocated: 0 };
      var located = 0;
      var unlocated = 0;
      targets.forEach(function (target) {
        var info = targetQuote(target.card);
        if (!info.present) {
          clearCardState(target.card);
          return;
        }
        var result = info.quote
          ? locateInIndex(index, info.quote)
          : { status: 'unlocated', reason: 'invalid-quote' };
        if (result.status === 'located') located += 1;
        else unlocated += 1;
        applyCardResult(target.card, result, info.quote);
      });
      refreshHighlights();
      return { pending: false, located: located, unlocated: unlocated };
    } catch (error) {
      return { pending: false, located: 0, unlocated: 0, error: true };
    }
  }

  function locate(commentOrCard) {
    try {
      var target = resolveTarget(commentOrCard);
      if (!target.present || !target.quote) {
        return { status: 'unlocated', reason: 'no-quote' };
      }
      if (isReaderBusy()) {
        return { status: 'unlocated', reason: 'reader-busy' };
      }
      var index = buildArticleIndex();
      if (!index) return { status: 'unlocated', reason: 'no-article' };
      var result = locateInIndex(index, target.quote);
      result.quote = cloneQuote(target.quote);
      return result;
    } catch (error) {
      return { status: 'unlocated', reason: 'locator-error' };
    }
  }

  function ensureArticleVisible() {
    var body = getArticleBody();
    if (!body) return false;
    if (body.getClientRects && body.getClientRects().length) return true;
    var chatTab = $('[data-view-tab="chat"]');
    if (chatTab && chatTab.getAttribute('aria-selected') !== 'true') {
      try {
        chatTab.click();
      } catch (error) {
        return false;
      }
      return true;
    }
    return false;
  }

  function scrollRangeIntoView(range) {
    if (!range) return false;
    var rect = null;
    try {
      var rects = range.getClientRects ? Array.prototype.slice.call(range.getClientRects()) : [];
      var visible = rects.filter(function (candidate) {
        return candidate && candidate.width && candidate.height;
      });
      rect = visible.length ? visible[0] : (range.getBoundingClientRect ? range.getBoundingClientRect() : null);
    } catch (error) {
      rect = null;
    }
    if (!rect || (!rect.height && !rect.width)) {
      var node = range.startContainer;
      var element = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (element && element.getBoundingClientRect) rect = element.getBoundingClientRect();
    }
    if (!rect) return false;
    var topbar = $('.topbar');
    var topLimit = topbar ? topbar.getBoundingClientRect().bottom : 0;
    topLimit += 18;
    var bottomLimit = window.innerHeight - 20;
    var dock = composerRect();
    if (dock) bottomLimit = Math.min(bottomLimit, dock.top - 18);
    if (rect.top >= topLimit && rect.bottom <= bottomLimit) return true;
    var target = window.pageYOffset + rect.top - topLimit;
    if (rect.height > bottomLimit - topLimit) target = window.pageYOffset + rect.top - topLimit;
    if (target < 0) target = 0;
    var reduced = typeof DSH.prefersReducedMotion === 'function' && DSH.prefersReducedMotion();
    try {
      window.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
    } catch (error) {
      window.scrollTo(0, target);
    }
    return true;
  }

  function emitCommentFocus(target) {
    var id = target && target.id != null ? String(target.id) : '';
    if (!id && target && target.card) {
      id = String(target.card.getAttribute('data-comment-id') || '');
    }
    var detail = { id: id, status: 'located' };
    var event;
    try {
      event = new CustomEvent('threadline:comment-focus', {
        bubbles: true,
        cancelable: false,
        detail: detail
      });
    } catch (error) {
      if (document.createEvent) {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent('threadline:comment-focus', true, false, detail);
      }
    }
    if (!event) return;
    try {
      document.dispatchEvent(event);
    } catch (error) {
      // A listener exception must not prevent the article reveal.
    }
  }

  function focusComment(commentOrCard) {
    var target;
    var result;
    try {
      target = resolveTarget(commentOrCard);
      if (!target) target = { card: null, quote: null, present: false, id: '' };
      if (!target.present || !target.quote) {
        result = { status: 'unlocated', reason: 'no-quote' };
      } else if (isReaderBusy()) {
        result = { status: 'unlocated', reason: 'reader-busy' };
      } else {
        var index = buildArticleIndex();
        result = index
          ? locateInIndex(index, target.quote)
          : { status: 'unlocated', reason: 'no-article' };
        result.quote = cloneQuote(target.quote);
      }
    } catch (error) {
      result = { status: 'unlocated', reason: 'locator-error' };
    }

    if (target.card && target.quote && result.reason !== 'reader-busy') {
      applyCardResult(target.card, result, target.quote);
    }
    if (result.status !== 'located') {
      if (typeof DSH.toast === 'function' && result.reason !== 'reader-busy') {
        DSH.toast(strings().quoteUnlocated, { tone: 'error' });
      }
      return result;
    }

    // The comments panel can use this to close its mobile overlay and scroll
    // lock before the article switches, scrolls, or highlights. This module
    // deliberately does not close or otherwise manage the panel itself.
    emitCommentFocus(target);

    refreshHighlights();
    setActiveHighlight(result.range);
    if (target.card) highlightCards([target.card]);

    var reveal = function () {
      scrollRangeIntoView(result.range);
    };
    if (ensureArticleVisible()) {
      if (window.requestAnimationFrame) window.requestAnimationFrame(reveal);
      else window.setTimeout(reveal, 0);
    }
    return result;
  }

  function runPendingSync() {
    if (!state.syncPending || isReaderBusy()) return;
    state.syncPending = false;
    sync();
  }

  function handleReaderChange() {
    finishReloadReaderWhenReady();
    if (isReaderBusy()) {
      hideAction();
      state.syncPending = true;
      return;
    }
    runPendingSync();
    scheduleSelectionCheck(80);
  }

  function mutationTouchesCards(mutation) {
    var nodes = Array.prototype.slice.call(mutation.addedNodes || [])
      .concat(Array.prototype.slice.call(mutation.removedNodes || []));
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      if (isCard(node)) return true;
      if (node.querySelector && node.querySelector('[data-comment-card]')) return true;
    }
    return false;
  }

  function mutationTouchesForm(mutation) {
    var nodes = Array.prototype.slice.call(mutation.addedNodes || [])
      .concat(Array.prototype.slice.call(mutation.removedNodes || []));
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches && (node.matches('[data-comment-form]')
        || node.matches('[data-comment-body]')
        || node.matches('textarea')
        || node.matches('[data-composer-quote]')
        || node.matches('[' + CHIP_ATTRIBUTE + ']'))) {
        return true;
      }
      if (node.querySelector && node.querySelector('[data-comment-form], [data-composer-quote], [' + CHIP_ATTRIBUTE + ']')) return true;
    }
    return false;
  }

  function handleMutations(mutations) {
    var cardsChanged = false;
    var formChanged = false;
    for (var index = 0; index < mutations.length; index += 1) {
      var mutation = mutations[index];
      if (mutation.type === 'attributes') {
        if (mutation.attributeName === 'data-comment-quote' || mutation.attributeName === 'data-comment-id') {
          cardsChanged = true;
        }
        continue;
      }
      if (mutationTouchesCards(mutation)) cardsChanged = true;
      if (mutationTouchesForm(mutation)) formChanged = true;
    }
    if (formChanged) {
      ensureChip();
      scheduleSelectionCheck(80);
    }
    if (cardsChanged) {
      window.clearTimeout(handleMutations.cardsTimer);
      handleMutations.cardsTimer = window.setTimeout(function () {
        sync();
      }, 90);
    }
  }

  function installObservers() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    try {
      state.observer = new MutationObserver(handleMutations);
      state.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-comment-quote', 'data-comment-id']
      });
    } catch (error) {
      state.observer = null;
    }

    var article = getArticle();
    if (!article) return;
    try {
      state.readerObserver = new MutationObserver(handleReaderChange);
      state.readerObserver.observe(article, {
        attributes: true,
        attributeFilter: ['data-reader-state', 'class']
      });
      var body = getArticleBody();
      if (body) {
        state.readerObserver.observe(body, {
          attributes: true,
          attributeFilter: ['aria-busy']
        });
      }
      var stream = $('[data-reader-stream]', article);
      if (stream) {
        state.readerObserver.observe(stream, {
          attributes: true,
          attributeFilter: ['hidden']
        });
      }
    } catch (error) {
      state.readerObserver = null;
    }
  }

  function bindEvents() {
    on(document, 'selectionchange', function () {
      if (!state.initialized) return;
      scheduleSelectionCheck(SELECTION_DELAY);
    });
    on(document, 'mouseup', function (event) {
      if (event && event.button !== 0) return;
      if (state.action && event && state.action.contains(event.target)) return;
      scheduleSelectionCheck(30);
    });
    on(document, 'keyup', function (event) {
      if (!event || event.key === 'Escape') return;
      scheduleSelectionCheck(80);
    });
    on(document, 'keydown', function (event) {
      if (!event || event.key !== 'Escape') return;
      if (state.action && !state.action.hidden) hideAction();
    });
    on(document, 'pointerdown', function (event) {
      if (!state.action || state.action.hidden) return;
      if (event.target === state.action || state.action.contains(event.target)) return;
      hideAction();
    }, true);
    on(window, 'scroll', hideAction, { passive: true });
    on(window, 'resize', hideAction);
    on(document, 'click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var view = target.closest('[data-comment-quote-view]');
      if (view) {
        if (event.preventDefault) event.preventDefault();
        var card = view.closest('[data-comment-card]');
        if (card) focusComment(card);
        return;
      }
      openCommentAtPoint(event);
    });
  }

  function init() {
    if (state.initialized || !document.body) return;
    state.strings = readStrings();
    state.initialized = true;
    ensureAction();
    ensureChip();
    bindEvents();
    installObservers();
    if ($$('[data-comment-card]').length) sync();
    scheduleSelectionCheck(SELECTION_DELAY);
  }

  var api = {
    getQuote: getQuote,
    setQuote: setQuote,
    clearQuote: clearQuote,
    hasQuote: hasQuote,
    sync: sync,
    locate: locate,
    focus: focusComment
  };
  DSH.inlineComments = api;

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  } catch (error) {
    // Inline comments are an enhancement. A failure here must not break the
    // article, the comment thread, or the reader animation.
  }
})();
