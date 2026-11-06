;(function () {
  'use strict';

  var DSH = (window.DSH = window.DSH || {});
  var ready = DSH.ready || function (callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  };
  var MAX_COMMENT_LENGTH = 5000;
  var PANEL_PIN_KEY = 'threadline.commentsPanel.pinned';
  var EFFECT_VALUES = ['off', 'subtle', 'strong'];
  var VISIBILITY_VALUES = ['public', 'commenter', 'blogger'];
  var REACTION_VALUES = ['like', 'dislike'];
  var SUBMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

  function $(selector, root) {
    var scope = root || document;
    if (!selector) return null;
    return scope.querySelector(selector);
  }

  function $$(selector, root) {
    var scope = root || document;
    if (!selector) return [];
    return Array.prototype.slice.call(scope.querySelectorAll(selector));
  }

  function on(target, type, listener, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, listener, options);
  }

  function make(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function clear(element) {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function mergeObjects() {
    var result = {};
    for (var i = 0; i < arguments.length; i += 1) {
      var source = arguments[i];
      if (!source || typeof source !== 'object') continue;
      Object.keys(source).forEach(function (key) {
        result[key] = source[key];
      });
    }
    return result;
  }

  function readJSONScript(id) {
    var node = document.getElementById(id);
    var value = {};
    if (!node) return value;
    try {
      var parsed = JSON.parse(node.textContent || '{}');
      if (parsed && typeof parsed === 'object') value = parsed;
    } catch (error) {
      value = {};
    }
    return value;
  }

  function escapeHtml(value) {
    if (typeof DSH.escapeHtml === 'function') return DSH.escapeHtml(value);
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHttpUrl(value) {
    if (value == null) return '';
    var raw = String(value).trim();
    if (!raw) return '';
    try {
      var parsed = new URL(raw, window.location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (parsed.username || parsed.password) return '';
      return parsed.href;
    } catch (error) {
      return '';
    }
  }

  function formatCount(value) {
    var number = Number(value);
    if (!isFinite(number)) return '';
    if (typeof DSH.formatCount === 'function') return DSH.formatCount(number);
    try {
      return new Intl.NumberFormat(DSH.config && DSH.config.languageCode).format(number);
    } catch (error) {
      return String(number);
    }
  }

  function formatTemplate(template, variables) {
    var value = String(template == null ? '' : template);
    return value.replace(/\{([A-Za-z0-9_]+)\}/g, function (match, key) {
      if (!variables || Object.prototype.hasOwnProperty.call(variables, key) === false) return match;
      return String(variables[key]);
    });
  }

  function formatBytes(bytes) {
    var value = Number(bytes);
    if (!isFinite(value) || value < 0) return '—';
    if (value >= 1048576) {
      var mb = Math.round((value / 1048576) * 10) / 10;
      return String(mb) + ' MB';
    }
    if (value >= 1024) return String(Math.round(value / 1024)) + ' KB';
    return String(Math.round(value)) + ' B';
  }

  function displayDate(value) {
    if (!value) return '';
    var date = new Date(value);
    if (!isFinite(date.getTime())) return '';
    var locale = (DSH.config && DSH.config.languageCode) || document.documentElement.lang || undefined;
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(date);
    } catch (error) {
      try {
        return date.toLocaleString(locale || undefined);
      } catch (fallbackError) {
        return date.toISOString().slice(0, 16).replace('T', ' ');
      }
    }
  }

  function dateTimeAttribute(value) {
    if (!value) return '';
    var date = new Date(value);
    if (!isFinite(date.getTime())) return '';
    return date.toISOString();
  }

  function normalizeEffect(value) {
    var effect = String(value == null ? '' : value).toLowerCase();
    return EFFECT_VALUES.indexOf(effect) === -1 ? 'off' : effect;
  }

  function normalizeVisibility(value) {
    var visibility = String(value == null ? '' : value).toLowerCase();
    return VISIBILITY_VALUES.indexOf(visibility) === -1 ? 'public' : visibility;
  }

  function normalizeReaction(value) {
    var reaction = String(value == null ? '' : value).toLowerCase();
    return REACTION_VALUES.indexOf(reaction) === -1 ? '' : reaction;
  }

  function normalizeSubmissionId(value) {
    if (typeof value !== 'string') return '';
    var candidate = value.trim();
    return SUBMISSION_ID_PATTERN.test(candidate) ? candidate : '';
  }

  function newSubmissionId() {
    var cryptoApi = window.crypto || null;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      try {
        var uuid = cryptoApi.randomUUID();
        if (SUBMISSION_ID_PATTERN.test(uuid)) return uuid;
      } catch (error) {
        // Fall through to explicit random bytes.
      }
    }
    var length = 24;
    var bytes = new Uint8Array(length);
    var filled = false;
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      try {
        cryptoApi.getRandomValues(bytes);
        filled = true;
      } catch (error) {
        filled = false;
      }
    }
    var hex = '';
    for (var index = 0; index < length; index += 1) {
      var value = filled ? bytes[index] : Math.floor(Math.random() * 256);
      hex += (value < 16 ? '0' : '') + value.toString(16);
    }
    return hex;
  }

  function normalizeQuote(value) {
    if (!value || typeof value !== 'object') return null;
    var text = typeof value.text === 'string' ? value.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) return null;
    var offset = Number(value.offset);
    var prefix = typeof value.prefix === 'string' ? value.prefix : '';
    var suffix = typeof value.suffix === 'string' ? value.suffix : '';
    var heading = typeof value.heading === 'string' ? value.heading : '';
    return {
      text: text.slice(0, 800),
      prefix: prefix.slice(-120),
      suffix: suffix.slice(0, 120),
      offset: isFinite(offset) && offset >= 0 ? Math.min(10000000, Math.floor(offset)) : 0,
      heading: heading.slice(0, 200)
    };
  }

  function nonNegativeInteger(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    if (!isFinite(number) || number < 0) return null;
    return Math.floor(number);
  }

  function normalizeBackend(raw) {
    var value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (parsed.username || parsed.password) return '';
      parsed.hash = '';
      parsed.search = '';
      var path = parsed.pathname.replace(/\/+$/, '');
      return parsed.origin + path;
    } catch (error) {
      return '';
    }
  }

  function normalizeErrorPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var error = payload.error;
    if (!error || typeof error !== 'object') return null;
    return {
      code: typeof error.code === 'string' ? error.code : '',
      message: typeof error.message === 'string' ? error.message : ''
    };
  }

  function requestJSON(url, options) {
    var requestOptions = options || {};
    if (!requestOptions.credentials) requestOptions.credentials = 'include';
    if (!requestOptions.headers) requestOptions.headers = {};
    if (!requestOptions.headers.Accept) requestOptions.headers.Accept = 'application/json';
    return window.fetch(url, requestOptions).then(function (response) {
      return response.text().then(function (raw) {
        var data = null;
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch (error) {
            data = null;
          }
        }
        if (!response.ok) {
          var failure = new Error('Request failed');
          failure.status = response.status;
          failure.data = data;
          failure.error = normalizeErrorPayload(data);
          failure.retryAfter = response.headers.get('Retry-After') || '';
          throw failure;
        }
        if (raw && data === null) {
          var invalid = new Error('Invalid JSON response');
          invalid.invalidResponse = true;
          throw invalid;
        }
        return data;
      });
    }).catch(function (error) {
      if (error && (error.status || error.invalidResponse)) throw error;
      var networkError = new Error('Network request failed');
      networkError.network = true;
      networkError.cause = error;
      throw networkError;
    });
  }

  function jsonPostOptions(payload, csrfToken) {
    var headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    return {
      method: 'POST',
      credentials: 'include',
      headers: headers,
      body: JSON.stringify(payload)
    };
  }

  function retrySeconds(error) {
    if (!error) return 0;
    var raw = error.retryAfter;
    if (raw) {
      var number = parseInt(String(raw), 10);
      if (isFinite(number) && number > 0) return Math.min(86400, number);
      var date = new Date(String(raw));
      if (isFinite(date.getTime())) {
        var delta = Math.ceil((date.getTime() - Date.now()) / 1000);
        if (delta > 0) return Math.min(86400, delta);
      }
    }
    return 0;
  }

  function errorMessage(error, strings) {
    var code = error && error.error && error.error.code ? error.error.code : '';
    var status = error && error.status ? error.status : 0;
    var seconds = retrySeconds(error);
    var retryText = seconds
      ? formatTemplate(strings.errorRateLimitedRetry || 'Try again in about {seconds} seconds.', { seconds: seconds })
      : '';
    if (error && error.network) return strings.networkError || '';
    if (code === 'authentication_required') return strings.errorAuth || '';
    if (code === 'session_expired' || status === 401) return strings.errorSession || '';
    if (code === 'csrf_invalid') return strings.errorCsrf || '';
    if (code === 'origin_not_allowed') return strings.errorOrigin || '';
    if (code === 'permission') return strings.errorPermission || '';
    if (code === 'not_found' || status === 404) return strings.errorNotFound || '';
    if (code === 'duplicate_submission' || status === 409) return strings.errorDuplicate || '';
    if (code === 'validation' || code === 'invalid_request' || code === 'invalid_json' || code === 'invalid_comment_id' || status === 422) {
      return strings.errorValidation || '';
    }
    if (code === 'rate_limited' || status === 429) {
      return formatTemplate(strings.errorRateLimited || '{retry}', { retry: retryText }).replace(/\s+$/, '');
    }
    if (code === 'github_unavailable') return strings.errorGithubUnavailable || '';
    if (code === 'github_error') return strings.errorGithub || '';
    if (code === 'attachments_disabled') return strings.errorAttachmentsDisabled || '';
    if (code === 'too_large' || status === 413) return strings.errorTooLarge || '';
    if (code === 'invalid_type' || code === 'invalid_multipart' || status === 415) return strings.errorInvalidType || '';
    if (code === 'upload_failed') return strings.errorUploadFailed || '';
    if (status >= 500 || code === 'internal_error') return strings.errorServer || '';
    if (error && error.invalidResponse) return strings.errorServer || '';
    return strings.errorUnknown || '';
  }

  /* A deliberately small, dependency-free Markdown renderer. Every source
     string is HTML-escaped before any generated markup is assembled. Raw HTML
     in a comment therefore stays text. URLs must begin with an explicit safe
     scheme. */
  function renderMarkdown(source) {
    var input = String(source == null ? '' : source)
      .replace(/\r\n?/g, '\n')
      .replace(/\u0001/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

    function renderInline(rawText) {
      var stored = [];
      var text = escapeHtml(rawText);

      function stash(html) {
        var marker = '\u0001' + stored.length + '\u0001';
        stored.push(html);
        return marker;
      }

      text = text.replace(/`([^`\n]+)`/g, function (match, code) {
        return stash('<code>' + code + '</code>');
      });

      text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (match, alt, href) {
        if (!/^(https?:\/\/)/i.test(href)) return match;
        if (/[\u0000-\u0020<>]/.test(href)) return match;
        return stash('<img src="' + href + '" alt="' + alt + '" loading="lazy" referrerpolicy="no-referrer">');
      });

      text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (match, label, href) {
        if (!/^(https?:\/\/|mailto:)/i.test(href)) return match;
        if (/[\u0000-\u0020<>]/.test(href)) return match;
        return stash('<a href="' + href + '" target="_blank" rel="noopener noreferrer ugc">' + (label || href) + '</a>');
      });

      text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
      text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
      text = text.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');

      return text.replace(/\u0001(\d+)\u0001/g, function (match, index) {
        var token = stored[Number(index)];
        return token == null ? '' : token;
      });
    }

    function inlineWithBreaks(rawText) {
      return String(rawText || '').split('\n').map(renderInline).join('<br>');
    }

    var lines = input.split('\n');
    var blocks = [];
    var paragraph = [];
    var list = null;
    var quote = null;

    function flushParagraph() {
      if (!paragraph.length) return;
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }

    function flushList() {
      if (!list) return;
      blocks.push(list);
      list = null;
    }

    function flushQuote() {
      if (!quote) return;
      blocks.push({ type: 'quote', text: quote.join('\n') });
      quote = null;
    }

    function flushAll() {
      flushParagraph();
      flushList();
      flushQuote();
    }

    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index];
      var fence = /^ {0,3}```(.*)$/.exec(line);
      if (fence) {
        flushAll();
        var language = String(fence[1] || '').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9_+-]/g, '').slice(0, 32);
        var code = [];
        index += 1;
        while (index < lines.length) {
          if (/^ {0,3}```[ \t]*$/.test(lines[index])) break;
          code.push(lines[index]);
          index += 1;
        }
        blocks.push({ type: 'code', language: language, text: code.join('\n') });
        continue;
      }

      if (!line.trim()) {
        flushAll();
        continue;
      }

      var quoteMatch = /^ {0,3}>[ \t]?(.*)$/.exec(line);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        if (!quote) quote = [];
        quote.push(quoteMatch[1]);
        continue;
      }

      if (quote) flushQuote();

      var unordered = /^ {0,3}[-*+][ \t]+(.*)$/.exec(line);
      var ordered = /^ {0,3}\d+[.)][ \t]+(.*)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph();
        var listType = unordered ? 'ul' : 'ol';
        if (!list || list.type !== listType) {
          flushList();
          list = { type: listType, items: [] };
        }
        list.items.push(unordered ? unordered[1] : ordered[1]);
        continue;
      }

      if (list) flushList();
      paragraph.push(line);
    }
    flushAll();

    return blocks.map(function (block) {
      if (block.type === 'code') {
        var languageClass = block.language ? ' class="language-' + block.language + '"' : '';
        return '<pre><code' + languageClass + '>' + escapeHtml(block.text) + '</code></pre>';
      }
      if (block.type === 'quote') {
        return '<blockquote>' + inlineWithBreaks(block.text) + '</blockquote>';
      }
      if (block.type === 'ul' || block.type === 'ol') {
        var items = block.items.map(function (item) {
          return '<li>' + inlineWithBreaks(item) + '</li>';
        }).join('');
        return '<' + block.type + '>' + items + '</' + block.type + '>';
      }
      return '<p>' + inlineWithBreaks(block.text) + '</p>';
    }).join('\n');
  }

  ready(function () {
    var accountElement = $('[data-account-root]');
    var commentsElement = $('[data-comments-root]');
    if (!accountElement && !commentsElement) return;

    var accountStrings = readJSONScript('account-strings');
    var commentsStrings = readJSONScript('comments-strings');
    var strings = mergeObjects(accountStrings, commentsStrings);

    var actionsElement = $('[data-message-actions]');
    var articleElement = $('[data-article-page]');
    var configState = (commentsElement && commentsElement.getAttribute('data-config-state'))
      || (accountElement && accountElement.getAttribute('data-config-state'))
      || 'unconfigured';
    var backendRaw = (commentsElement && commentsElement.getAttribute('data-backend-url'))
      || (accountElement && accountElement.getAttribute('data-backend-url'))
      || '';
    var backendBase = normalizeBackend(backendRaw);
    var configured = configState === 'configured' && !!backendBase;
    var commentId = commentsElement ? (commentsElement.getAttribute('data-comment-id') || '') : '';
    var articleUrl = (commentsElement && commentsElement.getAttribute('data-article-url'))
      || (articleElement && articleElement.getAttribute('data-article-url'))
      || window.location.href.split('#')[0];
    var articleTitle = (commentsElement && commentsElement.getAttribute('data-article-title'))
      || (articleElement && articleElement.getAttribute('data-article-title'))
      || document.title;

    var state = {
      base: backendBase,
      configured: configured,
      configState: configState,
      commentId: commentId,
      articleUrl: articleUrl,
      articleTitle: articleTitle,
      session: null,
      sessionReady: false,
      sessionFailed: false,
      sessionError: null,
      config: null,
      authConfigured: null,
      commentsEnabled: true,
      attachments: { enabled: false, maxBytes: 0, allowedTypes: [] },
      article: null,
      articleFailed: false,
      comments: [],
      commentCount: null,
      reactionStateLoaded: false,
      reactionAvailable: false,
      reactionStateUnknown: false,
      viewerReaction: null,
      commentsLoading: false,
      commentsState: 'idle',
      booting: false,
      sending: false,
      confirming: false,
      uploading: false,
      composing: false,
      draftRestored: false,
      submissionId: '',
      rateLimitUntil: 0,
      reactionBusy: false,
      reactionRetryUntil: 0,
      retryEffect: 'strong',
      quote: null,
      quoteFromModule: false,
      panelOpen: false,
      panelPinned: !!(DSH.storage && DSH.storage.get(PANEL_PIN_KEY, false) === true),
      panelLastFocus: null,
      insertMenuOpen: false,
      insertSelection: null,
      scopeMenuOpen: false,
      confirmResolve: null,
      confirmInvoker: null
    };

    var dock = $('[data-comment-dock]');
    var panelElement = $('[data-comments-panel]');
    var formElement = $('[data-comment-form]');
    var statsElement = dock ? $('.comment-stats', dock) : null;
    var dialogElement = dock ? $('[data-visibility-dialog]', dock) : null;
    var commentsScope = panelElement || commentsElement;

    var nodes = commentsElement ? {
      root: commentsElement,
      panel: panelElement,
      panelToggle: $('[data-comments-panel-toggle]'),
      panelPin: panelElement ? $('[data-comments-panel-pin]', panelElement) : null,
      panelClose: panelElement ? $('[data-comments-panel-close]', panelElement) : null,
      panelBackdrop: $('[data-comments-panel-backdrop]'),
      panelScroll: panelElement ? $('[data-comments-panel-scroll]', panelElement) : null,
      count: panelElement ? $('[data-comments-count]', panelElement) : null,
      status: $('[data-comments-status]', commentsScope),
      loading: $('[data-comments-loading]', commentsScope),
      empty: $('[data-comments-empty]', commentsScope),
      error: $('[data-comments-error]', commentsScope),
      errorTitle: $('[data-comments-error-title]', commentsScope),
      errorMessage: $('[data-comments-error-message]', commentsScope),
      retry: $('[data-comments-retry]', commentsScope),
      list: $('[data-comment-list]', commentsScope),
      unavailable: $('[data-comments-unavailable]', commentsScope),
      form: formElement,
      body: formElement ? $('[data-comment-body]', formElement) : null,
      length: formElement ? $('[data-comment-length]', formElement) : null,
      visibility: formElement ? $('[data-comment-visibility]', formElement) : null,
      scopeToggle: formElement ? $('[data-scope-toggle]', formElement) : null,
      scopeCurrent: formElement ? $('[data-scope-current]', formElement) : null,
      scopeMenu: formElement ? $('[data-scope-menu]', formElement) : null,
      quoteChip: formElement ? $('[data-composer-quote]', formElement) : null,
      quoteText: formElement ? $('[data-composer-quote-text]', formElement) : null,
      quoteRemove: formElement ? $('[data-composer-quote-remove]', formElement) : null,
      send: formElement ? $('[data-comment-send]', formElement) : null,
      sendLabel: formElement ? $('[data-send-label]', formElement) : null,
      validation: formElement ? $('[data-comment-validation]', formElement) : null,
      composerStatus: formElement ? $('[data-comment-status]', formElement) : null,
      composerSuccess: formElement ? $('[data-comment-success]', formElement) : null,
      insertRoot: formElement ? $('[data-insert-root]', formElement) : null,
      insertToggle: formElement ? $('[data-insert-toggle]', formElement) : null,
      insertMenu: formElement ? $('[data-insert-menu]', formElement) : null,
      attachmentButton: formElement ? $('[data-attachment-button]', formElement) : null,
      attachmentInput: formElement ? $('[data-attachment-input]', formElement) : null,
      attachmentNote: formElement ? $('[data-attachment-note]', formElement) : null,
      attachmentMenuNote: formElement ? $('[data-attachment-menu-note]', formElement) : null,
      attachmentProgressWrap: formElement ? $('[data-attachment-progress-wrap]', formElement) : null,
      attachmentProgress: formElement ? $('[data-attachment-progress]', formElement) : null,
      attachmentProgressText: formElement ? $('[data-attachment-progress-text]', formElement) : null,
      dialog: dialogElement,
      confirmScope: dialogElement ? $('[data-confirm-scope]', dialogElement) : null,
      confirmCancel: dialogElement ? $('[data-confirm-cancel]', dialogElement) : null,
      confirmContinue: dialogElement ? $('[data-confirm-continue]', dialogElement) : null,
      stats: statsElement,
      statComments: dock ? $('[data-stat-comments]', dock) : null,
      statLikes: dock ? $('[data-stat-likes]', dock) : null
    } : null;

    // The composer is rendered outside the article view panels so it stays
    // available in both Chat and Trajectory. Measure its real height so the
    // article always has room to scroll content clear of the dock.
    var scopeControl = formElement ? $('.comment-composer__scope', formElement) : null;
    var scopeInfo = formElement ? $('.comments__scope-info', formElement) : null;
    var scopePanel = scopeInfo ? $('.comments__scope-panel', scopeInfo) : null;
    var scopeTrigger = scopeInfo ? $('summary', scopeInfo) : null;
    var composerSuccessTimer = null;

    function updatePanelTop() {
      var topbar = $('.topbar');
      if (!topbar) return;
      var bottom = Math.max(0, Math.round(topbar.getBoundingClientRect().bottom));
      var value = bottom + 'px';
      if (document.documentElement.style.getPropertyValue('--comments-panel-top') !== value) {
        document.documentElement.style.setProperty('--comments-panel-top', value);
      }
    }

    function positionScopePanel() {
      if (!scopeInfo || !scopeInfo.open || !scopePanel || !scopeTrigger) return;
      var anchor = scopeTrigger.getBoundingClientRect();
      var width = Math.min(318, Math.max(0, window.innerWidth - 24));
      var left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
      var available = Math.max(0, anchor.top - 12);
      scopePanel.style.left = left + 'px';
      scopePanel.style.width = width + 'px';
      scopePanel.style.maxHeight = Math.max(80, Math.min(340, available)) + 'px';
      scopePanel.style.bottom = (available < 80 ? 12 : Math.max(12, window.innerHeight - anchor.top + 6)) + 'px';
    }

    function positionScopeMenu() {
      if (!state.scopeMenuOpen || !nodes || !nodes.scopeMenu || !scopeControl) return;
      var anchor = scopeControl.getBoundingClientRect();
      var viewport = window.visualViewport;
      var top = viewport ? viewport.offsetTop : 0;
      nodes.scopeMenu.style.maxHeight = Math.max(30, Math.min(150, anchor.top - top - 8)) + 'px';
    }

    function positionInsertMenu() {
      if (!state.insertMenuOpen || !nodes || !nodes.insertMenu || !nodes.insertToggle) return;
      var anchor = nodes.insertToggle.getBoundingClientRect();
      var viewport = window.visualViewport;
      var viewportWidth = viewport ? viewport.width : window.innerWidth;
      var viewportHeight = viewport ? viewport.height : window.innerHeight;
      var width = Math.min(300, Math.max(0, viewportWidth - 24));
      var left = Math.max(12, Math.min(anchor.left, viewportWidth - width - 12));
      var bottom = Math.max(12, viewportHeight - anchor.top + 8);
      var maxHeight = Math.max(120, Math.min(300, anchor.top - 20));
      nodes.insertMenu.style.width = width + 'px';
      nodes.insertMenu.style.left = left + 'px';
      nodes.insertMenu.style.bottom = bottom + 'px';
      nodes.insertMenu.style.maxHeight = maxHeight + 'px';
    }

    function updateDockSpace() {
      if (!dock) return;
      var viewport = window.visualViewport;
      var obscured = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      var bottom = Math.round(obscured) + 'px';
      if (dock.style.bottom !== bottom) dock.style.bottom = bottom;
      var height = Math.ceil(dock.getBoundingClientRect().height + obscured);
      var space = height + 'px';
      if (document.documentElement.style.getPropertyValue('--comment-dock-space') !== space) {
        document.documentElement.style.setProperty('--comment-dock-space', space);
      }
      updatePanelTop();
      positionScopePanel();
      positionScopeMenu();
      positionInsertMenu();
      syncPanelBackdrop();
    }

    if (dock) {
      document.documentElement.classList.add('has-comment-dock');
      dock.setAttribute('data-dock-ready', 'true');
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(updateDockSpace).observe(dock);
      } else if (typeof MutationObserver === 'function') {
        new MutationObserver(function () { window.requestAnimationFrame(updateDockSpace); })
          .observe(dock, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'], characterData: true });
      }
      on(scopeInfo, 'toggle', function () {
        if (scopeInfo.open) {
          closeScopeMenu(false);
          closeInsertMenu(false);
        }
        positionScopePanel();
      });
      on(formElement, 'input', function () { window.requestAnimationFrame(updateDockSpace); });
      on(window, 'resize', updateDockSpace);
      if (window.visualViewport) {
        on(window.visualViewport, 'resize', updateDockSpace);
        on(window.visualViewport, 'scroll', updateDockSpace);
      }
      updateDockSpace();
    }

    var reactionButtons = actionsElement ? $$('[data-reaction]', actionsElement) : [];
    var reactionNoteElement = actionsElement ? $('[data-reactions-note]', actionsElement) : null;
    var reactionState = {
      loaded: false,
      like: null,
      dislike: null,
      viewer: null
    };

    function getLoginHref() {
      if (!state.base) return '';
      var returnTo = window.location.href;
      try {
        var current = new URL(returnTo);
        current.searchParams.delete('auth');
        current.searchParams.delete('auth_error');
        current.hash = '';
        returnTo = current.href;
      } catch (error) {
        returnTo = returnTo.split('#')[0];
      }
      return state.base + '/api/auth/github?returnTo=' + encodeURIComponent(returnTo);
    }

    function cleanAuthQuery() {
      var current;
      try {
        current = new URL(window.location.href);
      } catch (error) {
        return { auth: '', error: '' };
      }
      var auth = current.searchParams.get('auth') || '';
      var authError = current.searchParams.get('auth_error') || '';
      if (!current.searchParams.has('auth') && !current.searchParams.has('auth_error')) {
        return { auth: '', error: '' };
      }
      current.searchParams.delete('auth');
      current.searchParams.delete('auth_error');
      try {
        window.history.replaceState(window.history.state, '', current.pathname + current.search + current.hash);
      } catch (error) {
        // Keep the visible URL if the History API is unavailable.
      }
      return { auth: auth, error: authError };
    }

    function showAuthResult(result) {
      if (!result || (!result.auth && !result.error)) return;
      var message = '';
      var tone = 'success';
      if (result.error) {
        var errors = {
          access_denied: strings.authAccessDenied,
          oauth_exchange_failed: strings.authExchangeFailed,
          profile_failed: strings.authProfileFailed,
          missing_code: strings.authMissingCode,
          invalid_state: strings.authInvalidState,
          invalid_return_to: strings.authInvalidReturnTo,
          auth_not_configured: strings.authNotConfigured
        };
        message = errors[result.error] || strings.authGenericError || '';
        tone = 'error';
      } else if (result.auth === 'ok') {
        message = strings.authOk || '';
      }
      if (message && typeof DSH.toast === 'function') DSH.toast(message, { tone: tone });
    }

    function setAccountState(value) {
      if (accountElement) accountElement.setAttribute('data-account-state', value);
    }

    function accountIconMarkup() {
      if (!accountElement) return '';
      var icon = $('[data-account-icon]', accountElement);
      return icon ? icon.innerHTML : '';
    }

    var defaultAccountIcon = accountIconMarkup();

    function setAccountIconDefault() {
      if (!accountElement) return;
      var icon = $('[data-account-icon]', accountElement);
      if (icon) icon.innerHTML = defaultAccountIcon;
    }

    function setAccountCopy(children) {
      if (!accountElement) return;
      var copy = $('[data-account-copy]', accountElement);
      if (!copy) return;
      clear(copy);
      children.forEach(function (child) {
        if (child) copy.appendChild(child);
      });
    }

    function renderAccountGuest() {
      if (!accountElement) return;
      setAccountState('guest');
      setAccountIconDefault();
      var status = make('span', 'account__status', strings.accountGuest || '');
      status.id = 'account-status';
      var login = make('a', 'account__signin');
      login.href = getLoginHref();
      login.title = strings.loginLink || '';
      login.setAttribute('data-account-login', '');
      login.textContent = strings.loginShort || strings.loginLink || '';
      setAccountCopy([status, login]);
    }

    function renderAccountUnconfigured() {
      if (!accountElement) return;
      setAccountState('unconfigured');
      setAccountIconDefault();
      var status = make('span', 'account__status', strings.accountGuest || 'Guest');
      status.id = 'account-status';
      status.title = strings.loginUnconfigured || '';
      setAccountCopy([status]);
    }

    function renderAccountError() {
      if (!accountElement) return;
      setAccountState('error');
      setAccountIconDefault();
      var status = make('span', 'account__status', strings.accountGuest || 'Guest');
      status.id = 'account-status';
      status.title = strings.accountUnavailable || '';
      setAccountCopy([status]);
    }

    function viewerInitial(viewer) {
      var label = String((viewer && (viewer.name || viewer.login)) || '');
      var characters = Array.from ? Array.from(label.trim()) : label.trim().split('');
      return characters.length ? characters[0].toUpperCase() : '?';
    }

    function setAccountAvatar(viewer) {
      if (!accountElement) return;
      var icon = $('[data-account-icon]', accountElement);
      if (!icon) return;
      clear(icon);
      var fallback = make('span', 'account__avatar-fallback', viewerInitial(viewer));
      var avatarUrl = safeHttpUrl(viewer && viewer.avatarUrl);
      if (!avatarUrl) {
        icon.appendChild(fallback);
        return;
      }
      fallback.hidden = true;
      var image = document.createElement('img');
      image.className = 'account__avatar';
      image.alt = '';
      image.width = 30;
      image.height = 30;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.src = avatarUrl;
      image.addEventListener('error', function () {
        if (image.parentNode) image.parentNode.removeChild(image);
        fallback.hidden = false;
      }, { once: true });
      icon.appendChild(fallback);
      icon.appendChild(image);
    }

    function viewerProfileUrl(viewer) {
      var declared = safeHttpUrl(viewer && viewer.url);
      if (declared) return declared;
      var login = String(viewer && viewer.login || '');
      if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
        return 'https://github.com/' + login;
      }
      return '';
    }

    function logout() {
      if (!state.session || !state.session.csrfToken || !state.base) {
        if (typeof DSH.toast === 'function') DSH.toast(strings.errorSession || '', { tone: 'error' });
        return;
      }
      var button = $('[data-account-logout]', accountElement);
      if (button) {
        button.disabled = true;
        button.textContent = strings.logoutBusy || strings.logout || '';
      }
      requestJSON(state.base + '/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'X-CSRF-Token': state.session.csrfToken
        }
      }).then(function () {
        window.location.reload();
      }).catch(function (error) {
        if (button) {
          button.disabled = false;
          button.textContent = strings.logout || '';
        }
        if (typeof DSH.toast === 'function') {
          DSH.toast(errorMessage(error, strings) || strings.logoutFailed || '', { tone: 'error' });
        }
      });
    }

    function renderAccountSigned(viewer, session) {
      if (!accountElement) return;
      setAccountState('authenticated');
      setAccountAvatar(viewer || {});
      var displayName = String((viewer && (viewer.name || viewer.login)) || 'GitHub');
      var status = make('span', 'account__status', displayName);
      status.id = 'account-status';
      status.title = strings.accountSignedIn || '';
      var line = make('span', 'account__meta-line');
      var profileUrl = viewerProfileUrl(viewer);
      var handle = String((viewer && viewer.login) || '');
      if (profileUrl) {
        var profile = make('a', 'account__profile', handle ? '@' + handle : displayName);
        profile.href = profileUrl;
        profile.target = '_blank';
        profile.rel = 'noopener noreferrer';
        profile.title = strings.githubProfile || '';
        line.appendChild(profile);
      } else if (handle) {
        line.appendChild(make('span', 'account__profile', '@' + handle));
      }
      if (line.childNodes.length) {
        var divider = make('span', '', '·');
        divider.setAttribute('aria-hidden', 'true');
        line.appendChild(divider);
      }
      var logoutButton = make('button', 'account__logout', strings.logout || '');
      logoutButton.type = 'button';
      logoutButton.setAttribute('data-account-logout', '');
      on(logoutButton, 'click', logout);
      line.appendChild(logoutButton);
      setAccountCopy([status, line]);
      if (session) state.session = session;
    }

    function renderAccountForSession() {
      if (!accountElement) return;
      if (state.sessionFailed) {
        renderAccountError();
        return;
      }
      if (!state.sessionReady) return;
      if (state.session && state.session.authenticated) {
        renderAccountSigned(state.session.viewer || {}, state.session);
        return;
      }
      if (state.authConfigured === false) {
        renderAccountUnconfigured();
        return;
      }
      renderAccountGuest();
    }

    function handleAuthExpired() {
      if (!state.session) return;
      state.session.authenticated = false;
      state.session.viewer = null;
      state.session.csrfToken = null;
      state.sessionReady = true;
      state.sessionFailed = false;
      renderAccountForSession();
      updateEditorControls();
      updateAttachmentControl();
      updateSendButton();
      if (state.article) updateReactionUI();
    }

    function isEditorAvailable() {
      return state.configured
        && !!state.base
        && state.commentsEnabled !== false
        && state.sessionReady
        && !state.sessionFailed
        && state.authConfigured !== false;
    }

    function setComposerStatus(message, tone) {
      if (!nodes || !nodes.composerStatus) return;
      if (tone === 'error' || tone === 'loading') showCommentSuccess('');
      nodes.composerStatus.textContent = message || '';
      nodes.composerStatus.classList.remove('is-error', 'is-success', 'is-loading');
      if (tone === 'error') nodes.composerStatus.classList.add('is-error');
      else if (tone === 'success') nodes.composerStatus.classList.add('is-success');
      else if (tone === 'loading') nodes.composerStatus.classList.add('is-loading');
    }

    function showCommentSuccess(message) {
      if (composerSuccessTimer !== null) {
        window.clearTimeout(composerSuccessTimer);
        composerSuccessTimer = null;
      }
      if (!nodes || !nodes.composerSuccess) return;
      nodes.composerSuccess.textContent = message || '';
      nodes.composerSuccess.hidden = !message;
      if (message) {
        composerSuccessTimer = window.setTimeout(function () {
          nodes.composerSuccess.hidden = true;
          nodes.composerSuccess.textContent = '';
          composerSuccessTimer = null;
        }, 4500);
      }
    }

    function setValidation(message) {
      if (!nodes) return;
      if (nodes.validation) nodes.validation.textContent = message || '';
      if (nodes.body) {
        if (message) {
          nodes.body.setAttribute('aria-invalid', 'true');
        } else {
          nodes.body.removeAttribute('aria-invalid');
        }
      }
    }

    function commentLength() {
      if (!nodes || !nodes.body) return 0;
      var value = nodes.body.value || '';
      return Array.from ? Array.from(value).length : value.length;
    }

    function updateCharacterCount() {
      if (!nodes || !nodes.length) return;
      var length = commentLength();
      nodes.length.textContent = length + ' / ' + MAX_COMMENT_LENGTH;
      nodes.length.classList.toggle('is-near-limit', length >= 4500 && length <= MAX_COMMENT_LENGTH);
      nodes.length.classList.toggle('is-error', length > MAX_COMMENT_LENGTH);
    }

    function autoGrow() {
      if (!nodes || !nodes.body) return;
      var body = nodes.body;
      body.style.height = 'auto';
      var styles = window.getComputedStyle(body);
      var computedMinimum = parseFloat(styles.minHeight) || 32;
      var computedMaximum = parseFloat(styles.maxHeight) || 240;
      var next = Math.min(computedMaximum, Math.max(computedMinimum, body.scrollHeight));
      body.style.height = next + 'px';
      body.style.overflowY = body.scrollHeight > next ? 'auto' : 'hidden';
    }

    function updateSendButton() {
      if (!nodes || !nodes.send) return;
      var allowed = isEditorAvailable()
        && state.authConfigured !== false
        && !state.sending
        && !state.confirming
        && !state.uploading
        && Date.now() >= state.rateLimitUntil;
      nodes.send.disabled = !allowed;
      var sendLabel = state.sending ? (strings.sending || '') : (strings.send || '');
      if (nodes.sendLabel) nodes.sendLabel.textContent = sendLabel;
      nodes.send.setAttribute('aria-label', sendLabel);
      nodes.send.title = sendLabel;
      nodes.send.setAttribute('aria-busy', state.sending ? 'true' : 'false');
    }

    function updateEditorControls() {
      if (!nodes) return;
      var available = isEditorAvailable();
      if (nodes.body) {
        nodes.body.disabled = !available;
        nodes.body.readOnly = state.sending;
      }
      if (nodes.visibility) nodes.visibility.disabled = !available;
      if (nodes.scopeToggle) nodes.scopeToggle.disabled = !available;
      if (nodes.insertToggle) nodes.insertToggle.disabled = !available || state.sending || state.confirming || state.uploading;
      if (!available || state.sending || state.confirming || state.uploading) closeInsertMenu(false);
      if (!available) closeScopeMenu(false);
      updateSendButton();
    }

    function attachmentConfig(value) {
      if (!value || typeof value !== 'object') {
        return { enabled: false, maxBytes: 0, allowedTypes: [] };
      }
      var types = Array.isArray(value.allowedTypes) ? value.allowedTypes.filter(function (type) {
        return typeof type === 'string' && /^[-\w.+]+\/[-\w.+]+$/.test(type);
      }) : [];
      var maxBytes = Number(value.maxBytes);
      return {
        enabled: value.enabled === true,
        maxBytes: isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0,
        allowedTypes: types
      };
    }

    function setAttachmentNote(message, isError) {
      if (!nodes) return;
      if (nodes.attachmentNote) {
        nodes.attachmentNote.textContent = message || '';
        nodes.attachmentNote.classList.toggle('is-error', !!isError);
      }
      if (nodes.attachmentMenuNote) nodes.attachmentMenuNote.textContent = message || '';
    }

    function fileAcceptValue() {
      var byType = {
        'image/png': '.png',
        'image/jpeg': '.jpg,.jpeg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'application/pdf': '.pdf',
        'text/plain': '.txt'
      };
      var values = [];
      state.attachments.allowedTypes.forEach(function (type) {
        values.push(type);
        if (byType[type]) values.push(byType[type]);
      });
      return values.join(',');
    }

    function updateAttachmentControl() {
      if (!nodes || !nodes.attachmentButton) return;
      var attachments = state.attachments;
      var authenticated = !!(state.session && state.session.authenticated);
      var available = isEditorAvailable();
      var waitingForSession = !state.sessionReady && !state.sessionFailed;
      var enabled = available
        && attachments.enabled
        && authenticated
        && state.authConfigured !== false
        && !state.uploading;
      nodes.attachmentButton.disabled = !enabled;
      nodes.attachmentButton.setAttribute('aria-busy', state.uploading ? 'true' : 'false');
      if (nodes.attachmentInput) {
        nodes.attachmentInput.disabled = !enabled;
        nodes.attachmentInput.accept = fileAcceptValue();
      }
      var hint = strings.attachmentUnavailable || '';
      var isError = false;
      if (state.uploading) {
        hint = strings.attachmentUploading || hint;
      } else if (waitingForSession) {
        hint = strings.attachmentLogin || hint;
      } else if (!state.commentsEnabled) {
        hint = strings.serviceDisabledHint || hint;
        isError = true;
      } else if (state.sessionFailed) {
        hint = strings.sessionError || hint;
        isError = true;
      } else if (!attachments.enabled) {
        hint = strings.attachmentUnavailable || hint;
      } else if (state.authConfigured === false) {
        hint = strings.attachmentAuthUnavailable || hint;
      } else if (!available) {
        hint = strings.sessionError || hint;
        isError = true;
      } else if (!authenticated) {
        hint = strings.attachmentLogin || hint;
      } else {
        var size = formatBytes(attachments.maxBytes);
        hint = formatTemplate(strings.attachmentReady || '', { size: size });
      }
      nodes.attachmentButton.title = hint;
      nodes.attachmentButton.setAttribute('aria-label', hint);
      if (!state.uploading) setAttachmentNote(hint, isError);
    }

    function updateVisibilityWarning() {
      if (!nodes || !nodes.visibility) return;
      var visibility = normalizeVisibility(nodes.visibility.value);
      if (scopeControl) scopeControl.setAttribute('data-visibility', visibility);
      if (scopePanel) {
        $$('[data-scope-explanation]', scopePanel).forEach(function (item) {
          item.hidden = item.getAttribute('data-scope-explanation') !== visibility;
        });
      }
      var description = visibility === 'commenter' ? strings.scopeInfoCommenter
        : visibility === 'blogger' ? strings.scopeInfoBlogger : strings.scopeInfoPublic;
      if (scopeTrigger) {
        var info = [description, strings.scopeInfoNote].filter(Boolean).join(' ');
        if (info) {
          scopeTrigger.setAttribute('aria-label', info);
          scopeTrigger.setAttribute('title', info);
        }
      }
      var option = nodes.visibility.options[nodes.visibility.selectedIndex];
      nodes.visibility.title = option ? option.textContent : visibility;
      if (nodes.scopeCurrent) nodes.scopeCurrent.textContent = option ? option.textContent : visibility;
      if (nodes.scopeToggle) {
        nodes.scopeToggle.setAttribute('aria-label', (strings.scopeShort || '') + ': ' + (option ? option.textContent : visibility));
      }
      if (nodes.scopeMenu) {
        $$('[data-scope-choice]', nodes.scopeMenu).forEach(function (item) {
          item.setAttribute('aria-selected', item.getAttribute('data-scope-choice') === visibility ? 'true' : 'false');
        });
      }
      if (nodes.confirmScope) {
        nodes.confirmScope.textContent = option ? option.textContent : visibility;
      }
    }

    function inlineCommentsModule() {
      return DSH.inlineComments && typeof DSH.inlineComments === 'object' ? DSH.inlineComments : null;
    }

    function readInlineQuote() {
      var module = inlineCommentsModule();
      if (!module || typeof module.getQuote !== 'function') return null;
      try {
        return normalizeQuote(module.getQuote());
      } catch (error) {
        return null;
      }
    }

    function renderQuoteChip() {
      if (!nodes || !nodes.quoteChip) return;
      var quote = state.quote;
      nodes.quoteChip.hidden = !quote;
      if (!quote) {
        if (nodes.quoteText) nodes.quoteText.textContent = '';
        return;
      }
      if (nodes.quoteText) {
        nodes.quoteText.textContent = quote.text;
        nodes.quoteText.title = quote.heading || '';
      }
    }

    function applyQuote(value, options) {
      var opts = options || {};
      var quote = normalizeQuote(value);
      state.quote = quote;
      state.quoteFromModule = false;
      var module = inlineCommentsModule();
      if (quote && module && typeof module.setQuote === 'function' && !opts.skipModule) {
        try {
          module.setQuote(quote);
        } catch (error) {
          // Keep the local chip usable even if the inline module is mid-load.
        }
      }
      renderQuoteChip();
    }

    function clearComposerQuote(options) {
      var opts = options || {};
      resetSubmissionId();
      state.quote = null;
      state.quoteFromModule = false;
      var module = inlineCommentsModule();
      if (module && typeof module.clearQuote === 'function' && !opts.skipModule) {
        try {
          module.clearQuote();
        } catch (error) {
          // The local state is still cleared.
        }
      }
      renderQuoteChip();
    }

    function syncQuoteFromModule() {
      var quote = readInlineQuote();
      if (!quote) {
        if (state.quoteFromModule && state.quote) {
          state.quote = null;
          state.quoteFromModule = false;
          renderQuoteChip();
        }
        return state.quote;
      }
      state.quote = quote;
      state.quoteFromModule = true;
      renderQuoteChip();
      return state.quote;
    }

    function quoteForSubmit() {
      var module = inlineCommentsModule();
      if (module && typeof module.getQuote === 'function') {
        var quote = readInlineQuote();
        if (quote) {
          state.quote = quote;
          state.quoteFromModule = true;
          renderQuoteChip();
          return quote;
        }
        if (state.quoteFromModule) {
          state.quote = null;
          renderQuoteChip();
          return null;
        }
        return state.quote;
      }
      return state.quote;
    }

    function selectedVisibility() {
      if (!nodes || !nodes.visibility) return 'public';
      return normalizeVisibility(nodes.visibility.value);
    }

    function getDraftKey() {
      return 'threadline.comment-draft.v1:' + (state.commentId || 'unknown');
    }

    function ensureSubmissionId() {
      var existing = normalizeSubmissionId(state.submissionId);
      state.submissionId = existing || newSubmissionId();
      return state.submissionId;
    }

    function resetSubmissionId() {
      state.submissionId = '';
      state.retryEffect = 'strong';
    }

    function saveDraft() {
      if (!nodes || !nodes.body) return;
      var body = nodes.body.value || '';
      if (!body.trim()) return;
      syncQuoteFromModule();
      var draft = {
        body: body,
        visibility: selectedVisibility(),
        effect: state.retryEffect,
        quote: state.quote,
        savedAt: Date.now()
      };
      var submissionId = normalizeSubmissionId(state.submissionId);
      if (submissionId) draft.submissionId = submissionId;
      try {
        window.sessionStorage.setItem(getDraftKey(), JSON.stringify(draft));
      } catch (error) {
        // Draft storage is best effort.
      }
    }

    function clearDraft() {
      try {
        window.sessionStorage.removeItem(getDraftKey());
      } catch (error) {
        // Ignore storage failures.
      }
      resetSubmissionId();
    }

    function restoreDraft() {
      if (!nodes || !nodes.body || state.draftRestored || nodes.body.value) return;
      var raw;
      try {
        raw = window.sessionStorage.getItem(getDraftKey());
      } catch (error) {
        return;
      }
      if (!raw) return;
      var draft;
      try {
        draft = JSON.parse(raw);
      } catch (error) {
        return;
      }
      if (!draft || typeof draft.body !== 'string' || !draft.body.trim()) return;
      nodes.body.value = draft.body.slice(0, MAX_COMMENT_LENGTH);
      if (nodes.visibility) nodes.visibility.value = normalizeVisibility(draft.visibility);
      if (draft.quote) applyQuote(draft.quote);
      state.submissionId = normalizeSubmissionId(draft.submissionId);
      // Preserve an in-flight legacy payload so a retry stays idempotent.
      state.retryEffect = state.submissionId ? normalizeEffect(draft.effect) : 'strong';
      state.draftRestored = true;
      updateVisibilityWarning();
      updateCharacterCount();
      autoGrow();
      setComposerStatus(strings.draftRestored || '', 'success');
    }

    function updatePanelCount() {
      if (!nodes || !nodes.count) return;
      if (state.commentCount === null) {
        nodes.count.textContent = '—';
        return;
      }
      nodes.count.textContent = formatTemplate(strings.panelCount || '{count}', {
        count: formatCount(state.commentCount)
      });
    }

    function setCommentCount(numberValue) {
      var count = nonNegativeInteger(numberValue);
      state.commentCount = count;
      if (nodes && nodes.statComments) {
        nodes.statComments.textContent = count === null ? (strings.unavailable || '—') : formatCount(count);
        if (count === null) nodes.statComments.title = strings.unavailable || '';
        else nodes.statComments.removeAttribute('title');
      }
      updatePanelCount();
    }

    function setArticleCount(numberValue) {
      setCommentCount(numberValue);
    }

    function setArticleLikes(numberValue) {
      if (!nodes || !nodes.statLikes) return;
      var count = nonNegativeInteger(numberValue);
      nodes.statLikes.textContent = count === null ? (strings.unavailable || '') : formatCount(count);
      if (count === null) nodes.statLikes.title = strings.unavailable || '';
      else nodes.statLikes.removeAttribute('title');
    }

    function setArticleCountsLoading() {
      if (!nodes) return;
      state.commentCount = null;
      if (nodes.statComments) {
        nodes.statComments.textContent = '—';
        nodes.statComments.title = strings.unavailable || '';
      }
      if (nodes.statLikes) {
        nodes.statLikes.textContent = '—';
        nodes.statLikes.title = strings.unavailable || '';
      }
      updatePanelCount();
    }

    function setCommentsStatus(message, tone) {
      if (!nodes || !nodes.status) return;
      nodes.status.textContent = message || '';
      nodes.status.classList.remove('is-ok', 'is-error');
      if (tone === 'ok') nodes.status.classList.add('is-ok');
      else if (tone === 'error') nodes.status.classList.add('is-error');
    }

    function setCommentsState(value) {
      state.commentsState = value;
      if (nodes && nodes.root) {
        nodes.root.setAttribute('data-comments-state', value);
        nodes.root.setAttribute('aria-busy', value === 'loading' ? 'true' : 'false');
      }
    }

    function hideCommentStates() {
      if (!nodes) return;
      if (nodes.loading) nodes.loading.hidden = true;
      if (nodes.empty) nodes.empty.hidden = true;
      if (nodes.error) nodes.error.hidden = true;
      if (nodes.list) nodes.list.hidden = true;
      if (nodes.unavailable) nodes.unavailable.hidden = true;
    }

    function showCommentsLoading() {
      if (!nodes) return;
      hideCommentStates();
      if (nodes.loading) nodes.loading.hidden = false;
      setCommentsState('loading');
      setCommentsStatus(strings.loading || '', '');
      setArticleCountsLoading();
      updateReactionLoading();
    }

    function showCommentsError(message, title) {
      if (!nodes) return;
      hideCommentStates();
      if (nodes.error) nodes.error.hidden = false;
      if (nodes.errorTitle) nodes.errorTitle.textContent = title || strings.errorTitle || '';
      if (nodes.errorMessage) nodes.errorMessage.textContent = message || strings.errorGeneric || '';
      if (nodes.retry) nodes.retry.hidden = false;
      setCommentsState('error');
      setCommentsStatus(strings.errorTitle || '', 'error');
      setArticleCount(null);
      setArticleLikes(null);
      var reactionMessage = state.reactionStateUnknown
        ? [strings.reactionUnknown, message].filter(Boolean).join(' ')
        : (message || strings.reactionsUnavailable || '');
      setReactionUnavailable(reactionMessage);
    }

    function showCommentsDisabled() {
      if (!nodes) return;
      hideCommentStates();
      if (nodes.error) nodes.error.hidden = false;
      if (nodes.errorTitle) nodes.errorTitle.textContent = strings.serviceDisabled || '';
      if (nodes.errorMessage) nodes.errorMessage.textContent = strings.serviceDisabledHint || '';
      if (nodes.retry) nodes.retry.hidden = true;
      setCommentsState('disabled');
      setCommentsStatus(strings.serviceDisabled || '', 'error');
      setArticleCount(null);
      setArticleLikes(null);
      setReactionUnavailable(strings.serviceDisabledHint || '');
      setComposerStatus(strings.serviceDisabledHint || '', 'error');
    }

    function panelFocusables() {
      if (!nodes || !nodes.panel) return [];
      var selector = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return $$(selector, nodes.panel).filter(function (element) {
        var styles = window.getComputedStyle(element);
        return styles.display !== 'none' && styles.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
    }

    function panelIsModal() {
      return !state.panelPinned && !!(window.matchMedia && window.matchMedia('(max-width: 780px)').matches);
    }

    function syncPanelBackdrop() {
      if (!nodes) return;
      var modal = !!state.panelOpen && panelIsModal();
      if (nodes.panel) nodes.panel.setAttribute('aria-modal', modal ? 'true' : 'false');
      if (nodes.panelBackdrop) nodes.panelBackdrop.hidden = !modal;
      document.body.classList.toggle('comments-panel-open', modal);
    }

    function updatePanelToggleLabels() {
      if (!nodes || !nodes.panelToggle) return;
      var key = state.panelOpen ? 'data-label-close' : 'data-label-open';
      var label = nodes.panelToggle.getAttribute(key);
      if (label) {
        nodes.panelToggle.setAttribute('aria-label', label);
        nodes.panelToggle.setAttribute('title', label);
      }
      nodes.panelToggle.setAttribute('aria-expanded', state.panelOpen ? 'true' : 'false');
    }

    function setPanelPinned(value, persist) {
      state.panelPinned = !!value;
      if (nodes && nodes.panelPin) {
        var label = nodes.panelPin.getAttribute(state.panelPinned ? 'data-label-unpin' : 'data-label-pin');
        nodes.panelPin.setAttribute('aria-pressed', state.panelPinned ? 'true' : 'false');
        if (label) {
          nodes.panelPin.setAttribute('aria-label', label);
          nodes.panelPin.setAttribute('title', label);
        }
      }
      if (persist && DSH.storage) DSH.storage.set(PANEL_PIN_KEY, state.panelPinned);
      syncPanelBackdrop();
    }

    function openPanel(options) {
      if (!nodes || !nodes.panel || state.panelOpen) return;
      var opts = options || {};
      closeInsertMenu(false);
      closeScopeMenu(false);
      state.panelLastFocus = opts.focus === false ? null : document.activeElement;
      state.panelOpen = true;
      nodes.panel.hidden = false;
      nodes.panel.setAttribute('aria-hidden', 'false');
      nodes.panel.setAttribute('data-comments-panel-state', 'open');
      updatePanelToggleLabels();
      updatePanelTop();
      syncPanelBackdrop();
      window.requestAnimationFrame(function () {
        if (!state.panelOpen) return;
        var active = document.activeElement;
        if (opts.focus !== false && nodes.panelClose && (!active || active === document.body || active === state.panelLastFocus || active === nodes.panelToggle)) {
          nodes.panelClose.focus();
        }
        syncInlineComments();
      });
    }

    function closePanel(options) {
      if (!nodes || !nodes.panel || !state.panelOpen) return;
      var opts = options || {};
      if (opts.unpin) setPanelPinned(false, true);
      state.panelOpen = false;
      nodes.panel.hidden = true;
      nodes.panel.setAttribute('aria-hidden', 'true');
      nodes.panel.setAttribute('data-comments-panel-state', 'closed');
      updatePanelToggleLabels();
      syncPanelBackdrop();
      var target = state.panelLastFocus && document.contains(state.panelLastFocus)
        ? state.panelLastFocus
        : nodes.panelToggle;
      state.panelLastFocus = null;
      if (opts.restoreFocus !== false && target && typeof target.focus === 'function') {
        target.focus();
      } else if (opts.restoreFocus === false &&
        nodes.panel.contains(document.activeElement) &&
        typeof document.activeElement.blur === 'function') {
        // Do not leave keyboard focus inside a panel that just became hidden.
        document.activeElement.blur();
      }
    }

    function togglePanel() {
      if (state.panelOpen) closePanel({ restoreFocus: true, unpin: true });
      else openPanel();
    }

    function bindPanel() {
      if (!nodes || !nodes.panel) return;
      on(nodes.panelToggle, 'click', togglePanel);
      on(nodes.panelPin, 'click', function () { setPanelPinned(!state.panelPinned, true); });
      on(nodes.panelClose, 'click', function () { closePanel({ restoreFocus: true, unpin: true }); });
      on(nodes.panelBackdrop, 'click', function () { closePanel({ restoreFocus: true }); });
      on(document, 'click', function (event) {
        if (!state.panelOpen || state.panelPinned || !event.target) return;
        if (nodes.panel.contains(event.target) || (nodes.panelToggle && nodes.panelToggle.contains(event.target))) return;
        if (nodes.panelBackdrop && nodes.panelBackdrop.contains(event.target)) return;
        closePanel({ restoreFocus: false });
      }, true);
      on(document, 'keydown', function (event) {
        if (event.defaultPrevented || event.isComposing || state.composing || event.keyCode === 229) return;
        if (event.key === 'Escape' && state.panelOpen) {
          if (state.insertMenuOpen || state.scopeMenuOpen) return;
          if (nodes.dialog && nodes.dialog.open) return;
          event.preventDefault();
          closePanel({ restoreFocus: true, unpin: true });
          return;
        }
        if (event.key !== 'Tab' || !state.panelOpen || !panelIsModal()) return;
        if (nodes.dialog && nodes.dialog.open) return;
        var focusables = panelFocusables();
        if (!focusables.length) {
          event.preventDefault();
          return;
        }
        if (!nodes.panel.contains(document.activeElement)) {
          event.preventDefault();
          focusables[0].focus();
          return;
        }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      // The inline layer dispatches this before it scrolls the selected quote
      // into view. Release the mobile scroll lock so the scroll can happen.
      on(document, 'threadline:comment-focus', function () {
        if (!state.panelOpen || !panelIsModal()) return;
        closePanel({ restoreFocus: false });
      });
      updatePanelToggleLabels();
      setPanelPinned(state.panelPinned, false);
      if (state.panelPinned) openPanel({ focus: false });
    }

    function normalizeAuthor(author) {
      var value = author && typeof author === 'object' ? author : {};
      return {
        login: typeof value.login === 'string' ? value.login : '',
        name: typeof value.name === 'string' ? value.name : '',
        avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : '',
        url: typeof value.url === 'string' ? value.url : ''
      };
    }

    function normalizeComment(comment) {
      var value = comment && typeof comment === 'object' ? comment : {};
      var normalized = {
        id: value.id,
        author: normalizeAuthor(value.author),
        body: typeof value.body === 'string' ? value.body : '',
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
        visibility: normalizeVisibility(value.visibility),
        effect: 'strong',
        isAuthor: value.isAuthor === true
      };
      var quote = normalizeQuote(value.quote);
      // The inline layer checks property presence. Only expose `quote` when it
      // exists so an explicit null is not mistaken for a broken selection.
      if (quote) normalized.quote = quote;
      return normalized;
    }

    function commentIdKey(value) {
      return value == null ? '' : String(value);
    }

    function commentCardExists(comment) {
      var id = commentIdKey(comment && comment.id);
      if (!id) return false;
      var inState = state.comments.some(function (entry) {
        return commentIdKey(entry && entry.id) === id;
      });
      if (inState) return true;
      if (!nodes || !nodes.list) return false;
      return $$('[data-comment-card]', nodes.list).some(function (card) {
        return commentIdKey(card.getAttribute('data-comment-id')) === id;
      });
    }

    function sortedComments(comments) {
      return comments.slice().sort(function (first, second) {
        var firstTime = Date.parse(first.createdAt);
        var secondTime = Date.parse(second.createdAt);
        if (isFinite(firstTime) && isFinite(secondTime) && firstTime !== secondTime) {
          return firstTime - secondTime;
        }
        var firstId = String(first.id == null ? '' : first.id);
        var secondId = String(second.id == null ? '' : second.id);
        return firstId.localeCompare(secondId);
      });
    }

    function avatarNode(comment) {
      var author = comment.author;
      var wrap = make('span', 'comment-card__avatar-wrap');
      var fallbackLabel = String(author.name || author.login || '?').trim();
      var characters = Array.from ? Array.from(fallbackLabel) : fallbackLabel.split('');
      var fallback = make('span', 'comment-card__avatar-fallback', characters.length ? characters[0].toUpperCase() : '?');
      var avatarUrl = safeHttpUrl(author.avatarUrl);
      wrap.appendChild(fallback);
      if (avatarUrl) {
        fallback.hidden = true;
        var image = document.createElement('img');
        image.className = 'comment-card__avatar';
        image.src = avatarUrl;
        image.alt = '';
        image.width = 32;
        image.height = 32;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', function () {
          if (image.parentNode) image.parentNode.removeChild(image);
          fallback.hidden = false;
        }, { once: true });
        wrap.appendChild(image);
      }
      return wrap;
    }

    function authorLink(label, url, className) {
      var safe = safeHttpUrl(url);
      if (!safe) return make('span', className, label);
      var link = make('a', className, label);
      link.href = safe;
      link.target = '_blank';
      link.rel = 'noopener noreferrer ugc';
      return link;
    }

    function visibilityBadge(comment) {
      if (comment.visibility === 'public') return null;
      var label = comment.visibility === 'blogger'
        ? (strings.visibilityBlogger || '')
        : (strings.visibilityCommenter || '');
      var badge = make('span', 'comment-card__badge comment-card__badge--filter', label);
      badge.title = comment.visibility === 'blogger'
        ? (strings.visibilityBloggerTitle || '')
        : (strings.visibilityCommenterTitle || '');
      return badge;
    }

    function effectBadge(comment) {
      if (comment.effect === 'off') return null;
      var badge = make(
        'span',
        'comment-card__badge comment-card__badge--effect',
        (strings.effectBadge || '') + ' · ' + (strings.effectOn || '')
      );
      return badge;
    }

    function quoteNode(comment) {
      var quote = comment.quote;
      var block = make('blockquote', 'comment-card__quote');
      block.setAttribute('data-comment-quote', '');
      if (comment.id != null) block.setAttribute('data-comment-id', String(comment.id));
      if (quote.heading) block.title = quote.heading;
      var head = make('div', 'comment-card__quote-head');
      head.appendChild(make('span', 'comment-card__quote-label', strings.quoteLabel || ''));
      var status = make('span', 'comment-card__quote-status', strings.quoteContext || '');
      status.setAttribute('data-comment-quote-status', '');
      status.setAttribute('aria-live', 'polite');
      head.appendChild(status);
      block.appendChild(head);
      var text = make('p', 'comment-card__quote-text', quote.text);
      text.setAttribute('data-comment-quote-text', '');
      block.appendChild(text);
      var view = make('button', 'comment-card__quote-view', strings.quoteView || '');
      view.type = 'button';
      view.setAttribute('data-comment-quote-view', '');
      if (comment.id != null) view.setAttribute('data-comment-id', String(comment.id));
      block.appendChild(view);
      return block;
    }

    function syncInlineComments() {
      var module = inlineCommentsModule();
      if (!module || typeof module.sync !== 'function') return;
      try {
        module.sync(state.comments);
      } catch (error) {
        // The inline layer is optional and must not block the comment panel.
      }
    }

    function commentNode(comment) {
      var item = make('li', 'comments__item');
      var card = make('article', 'comment-card');
      card.setAttribute('data-comment-card', '');
      card.setAttribute('data-effect', comment.effect);
      card.setAttribute('data-visibility', comment.visibility);
      if (comment.id != null) card.setAttribute('data-comment-id', String(comment.id));

      var head = make('div', 'comment-card__head');
      head.appendChild(avatarNode(comment));
      var identity = make('div', 'comment-card__identity');
      var byline = make('div', 'comment-card__byline');
      var author = comment.author;
      var displayName = String(author.name || author.login || 'GitHub');
      var authorNode = authorLink(displayName, author.url, 'comment-card__author');
      byline.appendChild(authorNode);
      if (author.login && displayName !== author.login) {
        var nickname = authorLink('@' + author.login, author.url, 'comment-card__nickname');
        byline.appendChild(nickname);
      }

      var meta = make('div', 'comment-card__meta');
      if (comment.createdAt) {
        var time = document.createElement('time');
        time.className = 'comment-card__time';
        var iso = dateTimeAttribute(comment.createdAt);
        if (iso) time.setAttribute('datetime', iso);
        var readable = displayDate(comment.createdAt);
        time.textContent = readable || '—';
        meta.appendChild(time);
      }
      var visibility = visibilityBadge(comment);
      if (visibility) meta.appendChild(visibility);
      var effect = effectBadge(comment);
      if (effect) meta.appendChild(effect);

      identity.appendChild(byline);
      identity.appendChild(meta);
      head.appendChild(identity);

      var body = make('div', 'comment-card__body');
      body.innerHTML = renderMarkdown(comment.body);

      card.appendChild(head);
      if (comment.quote) card.appendChild(quoteNode(comment));
      card.appendChild(body);
      item.appendChild(card);

      if (DSH.effects && typeof DSH.effects.applyCard === 'function') {
        DSH.effects.applyCard(card, comment.effect);
      }
      return item;
    }

    function renderComments(comments) {
      if (!nodes || !nodes.list) return;
      state.comments = sortedComments(comments);
      clear(nodes.list);
      state.comments.forEach(function (comment) {
        nodes.list.appendChild(commentNode(comment));
      });
      hideCommentStates();
      var hasComments = state.comments.length > 0;
      if (nodes.list) nodes.list.hidden = !hasComments;
      if (nodes.empty) nodes.empty.hidden = hasComments;
      if (nodes.loading) nodes.loading.hidden = true;
      setCommentsState(hasComments ? 'ready' : 'empty');
      syncInlineComments();
    }

    function normalizeReactions(value) {
      var reactions = value && typeof value === 'object' ? value : {};
      var viewer = reactions.viewer === 'like' || reactions.viewer === 'dislike'
        ? reactions.viewer
        : null;
      return {
        like: nonNegativeInteger(reactions.like),
        dislike: nonNegativeInteger(reactions.dislike),
        viewer: viewer
      };
    }

    function reactionCountText(value) {
      var count = nonNegativeInteger(value);
      return count === null ? '—' : formatCount(count);
    }

    function setReactionNote(message, withLogin) {
      if (!reactionNoteElement) return;
      clear(reactionNoteElement);
      reactionNoteElement.appendChild(document.createTextNode(message || ''));
      if (withLogin) {
        reactionNoteElement.appendChild(document.createTextNode(' '));
        var login = make('a', '', strings.loginLink || '');
        login.href = getLoginHref();
        login.setAttribute('data-reaction-login', '');
        reactionNoteElement.appendChild(login);
      }
      reactionElements().forEach(function (entry) {
        entry.button.title = message || '';
      });
    }

    function reactionElements() {
      return reactionButtons.map(function (button) {
        return {
          button: button,
          reaction: normalizeReaction(button.getAttribute('data-reaction')),
          count: $('[data-reaction-count]', button)
        };
      }).filter(function (entry) {
        return !!entry.reaction;
      });
    }

    function defaultReactionNote(loaded) {
      if (!reactionNoteElement) return;
      if (state.authConfigured === false) {
        setReactionNote(strings.reactionsAuthUnconfigured || '', false);
      } else if (state.sessionFailed) {
        setReactionNote(strings.reactionsSessionError || '', false);
      } else if (!loaded || !state.reactionAvailable) {
        setReactionNote(strings.reactionsUnavailable || '', false);
      } else if (!state.session || !state.session.authenticated) {
        setReactionNote(strings.reactionsLogin || '', true);
      } else {
        setReactionNote(strings.reactionsReady || '', false);
      }
    }

    function updateReactionControls() {
      var loaded = !!(state.article && state.reactionStateLoaded);
      var canUse = loaded
        && !state.reactionStateUnknown
        && state.sessionReady
        && !state.sessionFailed
        && state.authConfigured !== false
        && state.commentsEnabled !== false;
      var limited = Date.now() < state.reactionRetryUntil;
      reactionElements().forEach(function (entry) {
        var count = state.reactionStateLoaded ? reactionCountText(reactionState[entry.reaction]) : '—';
        if (entry.count) entry.count.textContent = count;
        var active = reactionState.viewer === entry.reaction;
        entry.button.classList.toggle('is-active', active);
        entry.button.setAttribute('aria-pressed', active ? 'true' : 'false');
        entry.button.setAttribute('aria-busy', state.reactionBusy ? 'true' : 'false');
        entry.button.disabled = !canUse || state.reactionBusy || limited;
      });
    }

    function updateReactionUI(options) {
      var opts = options || {};
      updateReactionControls();
      if (!opts.preserveNote) defaultReactionNote(!!state.reactionStateLoaded);
    }

    function updateReactionLoading() {
      state.reactionStateLoaded = false;
      state.reactionAvailable = false;
      reactionElements().forEach(function (entry) {
        if (entry.count) entry.count.textContent = '—';
        entry.button.disabled = true;
        entry.button.classList.remove('is-active');
        entry.button.setAttribute('aria-pressed', 'false');
        entry.button.setAttribute('aria-busy', 'true');
      });
      if (reactionNoteElement) {
        setReactionNote(
          state.reactionStateUnknown
            ? (strings.reactionUnknown || strings.reactionsLoading || '')
            : (strings.reactionsLoading || ''),
          false
        );
      }
    }

    function setReactionUnavailable(message) {
      state.reactionStateLoaded = false;
      state.reactionAvailable = false;
      reactionElements().forEach(function (entry) {
        if (entry.count) entry.count.textContent = '—';
        entry.button.disabled = true;
        entry.button.classList.remove('is-active');
        entry.button.setAttribute('aria-pressed', 'false');
        entry.button.setAttribute('aria-busy', 'false');
      });
      if (reactionNoteElement) {
        setReactionNote(message || strings.reactionsUnavailable || '', false);
      }
    }

    function markReactionStateUnknown(message) {
      state.reactionStateUnknown = true;
      state.reactionStateLoaded = false;
      state.reactionAvailable = false;
      reactionState.like = null;
      reactionState.dislike = null;
      reactionState.viewer = null;
      state.viewerReaction = null;
      setArticleLikes(null);
      reactionElements().forEach(function (entry) {
        if (entry.count) entry.count.textContent = '—';
        entry.button.disabled = true;
        entry.button.classList.remove('is-active');
        entry.button.setAttribute('aria-pressed', 'false');
        entry.button.setAttribute('aria-busy', 'false');
      });
      if (reactionNoteElement) {
        setReactionNote(message || strings.reactionUnknown || strings.reactionsUnavailable || '', false);
      }
    }

    function setReactionStats(likeCount) {
      setArticleLikes(likeCount);
    }

    function applyArticleReactions(reactions) {
      var normalized = normalizeReactions(reactions);
      state.reactionStateUnknown = false;
      reactionState.like = normalized.like;
      reactionState.dislike = normalized.dislike;
      reactionState.viewer = normalized.viewer;
      state.viewerReaction = normalized.viewer;
      state.reactionStateLoaded = normalized.like !== null || normalized.dislike !== null;
      state.reactionAvailable = true;
      if (normalized.like !== null) {
        setReactionStats(normalized.like);
      } else {
        setArticleLikes(null);
      }
      updateReactionUI();
    }

    function invalidReactionResponseError() {
      var error = new Error('Invalid reaction response');
      error.invalidResponse = true;
      return error;
    }

    function reactionErrorMayFollowWrite(error) {
      if (!error) return false;
      if (error.network === true || error.invalidResponse === true) return true;
      var code = error.error && typeof error.error.code === 'string' ? error.error.code : '';
      if (code === 'reaction_state_unknown') return true;
      var status = Number(error.status);
      return isFinite(status) && status >= 500;
    }

    function updateReactionAfterServer(reactions) {
      var normalized = normalizeReactions(reactions);
      if (normalized.like === null || normalized.dislike === null) {
        throw invalidReactionResponseError();
      }
      state.reactionStateUnknown = false;
      reactionState.like = normalized.like;
      reactionState.dislike = normalized.dislike;
      reactionState.viewer = normalized.viewer;
      state.viewerReaction = normalized.viewer;
      state.reactionStateLoaded = true;
      state.reactionAvailable = true;
      setReactionStats(normalized.like);
      if (state.article) {
        state.article.reactions = {
          like: normalized.like,
          dislike: normalized.dislike,
          viewer: normalized.viewer
        };
      }
      updateReactionUI({ preserveNote: true });
    }

    function scheduleReactionRetry(seconds) {
      if (!seconds) return;
      state.reactionRetryUntil = Date.now() + seconds * 1000;
      updateReactionControls();
      window.setTimeout(function () {
        state.reactionRetryUntil = 0;
        updateReactionControls();
      }, seconds * 1000 + 30);
    }

    function reactionRequest(reaction, csrfToken) {
      return requestJSON(
        state.base + '/api/articles/' + encodeURIComponent(state.commentId) + '/reaction',
        jsonPostOptions({
          reaction: reaction,
          expectedViewer: normalizeReaction(state.viewerReaction) || null,
          title: state.articleTitle,
          articleUrl: state.articleUrl
        }, csrfToken)
      );
    }

    function promptReactionLogin() {
      if (state.authConfigured === false) {
        setReactionNote(strings.reactionsAuthUnconfigured || '', false);
        if (typeof DSH.toast === 'function') DSH.toast(strings.reactionsAuthUnconfigured || '', { tone: 'error' });
        return;
      }
      if (state.sessionFailed) {
        setReactionNote(strings.reactionsSessionError || '', false);
        if (typeof DSH.toast === 'function') DSH.toast(strings.reactionsSessionError || '', { tone: 'error' });
        return;
      }
      setReactionNote(strings.reactionsLogin || '', true);
      if (typeof DSH.toast === 'function') DSH.toast(strings.reactionsLogin || '');
    }

    function handleReaction(buttonReaction) {
      if (!buttonReaction || state.reactionBusy) return;
      if (!state.article || state.articleFailed || !state.reactionStateLoaded || state.reactionStateUnknown) return;
      if (state.authConfigured === false) {
        promptReactionLogin();
        return;
      }
      if (!state.session || !state.session.authenticated) {
        promptReactionLogin();
        return;
      }
      if (!state.session.csrfToken) {
        setReactionNote(strings.reactionsSessionError || '', false);
        if (typeof DSH.toast === 'function') DSH.toast(strings.errorSession || '', { tone: 'error' });
        return;
      }
      if (Date.now() < state.reactionRetryUntil) return;

      var requested = state.viewerReaction === buttonReaction ? null : buttonReaction;
      state.reactionBusy = true;
      if (reactionNoteElement) setReactionNote(strings.reactionsBusy || '', false);
      updateReactionControls();

      reactionRequest(requested, state.session.csrfToken).then(function (data) {
        if (!data || !data.reactions) throw invalidReactionResponseError();
        updateReactionAfterServer(data.reactions);
        var conflict = data.conflict === true;
        var partial = data.partial === true;
        var warning = partial
          ? (strings.reactionPartial || (typeof data.warning === 'string' ? data.warning.trim() : ''))
          : '';
        if (conflict) {
          var conflictMessage = strings.reactionConflict || strings.reactionsError || '';
          if (reactionNoteElement) setReactionNote(conflictMessage, false);
          if (typeof DSH.toast === 'function') DSH.toast(conflictMessage, { duration: 5200 });
        } else if (partial) {
          if (reactionNoteElement) setReactionNote(warning, false);
          if (typeof DSH.toast === 'function') DSH.toast(warning, { duration: 5200 });
        } else if (reactionNoteElement) {
          setReactionNote(strings.reactionsSaved || '', false);
        }
      }).catch(function (error) {
        if (reactionErrorMayFollowWrite(error)) {
          var unknownMessage = strings.reactionUnknown || strings.reactionsError || '';
          markReactionStateUnknown(unknownMessage);
          if (typeof DSH.toast === 'function') {
            DSH.toast(unknownMessage, { tone: 'error', duration: 6500 });
          }
          // The write may have been applied even though the response was not
          // trustworthy. Fetch the authoritative state before allowing another
          // toggle; the stale viewer state must not turn a reaction off.
          loadComments({ fromUnknown: true });
          return;
        }
        var message = errorMessage(error, strings) || strings.reactionsError || '';
        if (error && ((error.error && error.error.code === 'session_expired') || error.status === 401)) {
          handleAuthExpired();
          message = strings.errorSession || message;
        }
        if (error && error.status === 429) {
          scheduleReactionRetry(retrySeconds(error));
        }
        updateReactionControls();
        if (state.session && !state.session.authenticated && state.authConfigured !== false) {
          setReactionNote(message, true);
        } else {
          setReactionNote(message, false);
        }
        if (typeof DSH.toast === 'function') DSH.toast(message, { tone: 'error' });
      }).then(function () {
        state.reactionBusy = false;
        updateReactionControls();
      });
    }

    reactionButtons.forEach(function (button) {
      on(button, 'click', function () {
        handleReaction(normalizeReaction(button.getAttribute('data-reaction')));
      });
    });

    function normalizeSession(data) {
      if (!data || typeof data !== 'object') {
        var error = new Error('Invalid session response');
        error.invalidResponse = true;
        throw error;
      }
      var configValue = data.config && typeof data.config === 'object' ? data.config : {};
      var authenticated = data.authenticated === true;
      var viewer = authenticated && data.viewer && typeof data.viewer === 'object' ? {
        login: typeof data.viewer.login === 'string' ? data.viewer.login : '',
        name: typeof data.viewer.name === 'string' ? data.viewer.name : '',
        avatarUrl: typeof data.viewer.avatarUrl === 'string' ? data.viewer.avatarUrl : '',
        url: typeof data.viewer.url === 'string' ? data.viewer.url : ''
      } : null;
      return {
        authenticated: authenticated,
        viewer: viewer,
        csrfToken: typeof data.csrfToken === 'string' ? data.csrfToken : '',
        config: {
          repository: typeof configValue.repository === 'string' ? configValue.repository : '',
          blogger: typeof configValue.blogger === 'string' ? configValue.blogger : '',
          commentsEnabled: configValue.commentsEnabled !== false,
          authConfigured: configValue.authConfigured !== false,
          attachments: attachmentConfig(configValue.attachments)
        }
      };
    }

    function applySession(session) {
      state.session = session;
      state.sessionReady = true;
      state.sessionFailed = false;
      state.sessionError = null;
      state.config = session.config;
      state.authConfigured = session.config.authConfigured;
      state.commentsEnabled = session.config.commentsEnabled;
      state.attachments = session.config.attachments;
      renderAccountForSession();
      updateEditorControls();
      updateAttachmentControl();
      updateVisibilityWarning();
      if (state.authConfigured === false && nodes) {
        setComposerStatus(strings.loginUnavailable || '', 'error');
      }
      if (session.authenticated) restoreDraft();
    }

    function applySessionFailure(error) {
      state.sessionFailed = true;
      state.sessionReady = false;
      state.sessionError = error;
      state.session = null;
      state.authConfigured = null;
      renderAccountError();
      if (nodes) {
        updateEditorControls();
        updateAttachmentControl();
        var message = errorMessage(error, strings) || strings.sessionError || '';
        setComposerStatus(message, 'error');
        setAttachmentNote(message, true);
      }
      setReactionUnavailable(strings.reactionsSessionError || '');
    }

    function fetchSession() {
      return requestJSON(state.base + '/api/session', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      }).then(function (data) {
        return normalizeSession(data);
      });
    }

    function loadComments(options) {
      if (!nodes) return Promise.resolve();
      if (state.commentsLoading) return Promise.resolve();
      var recoveringFromUnknown = !!(options && options.fromUnknown);
      state.commentsLoading = true;
      state.articleFailed = false;
      showCommentsLoading();
      return requestJSON(
        state.base + '/api/articles/' + encodeURIComponent(state.commentId),
        {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        }
      ).then(function (data) {
        if (!data || typeof data !== 'object' || data.available === false || !Array.isArray(data.comments)) {
          var invalid = new Error('Invalid article response');
          invalid.invalidResponse = true;
          throw invalid;
        }
        state.article = data;
        state.articleFailed = false;
        var comments = data.comments.map(normalizeComment);
        renderComments(comments);
        setArticleCount(data.commentCount);
        var reactions = normalizeReactions(data.reactions);
        state.reactionStateUnknown = false;
        reactionState.like = reactions.like;
        reactionState.dislike = reactions.dislike;
        reactionState.viewer = reactions.viewer;
        state.viewerReaction = reactions.viewer;
        state.reactionStateLoaded = reactions.like !== null || reactions.dislike !== null;
        state.reactionAvailable = true;
        if (reactions.like !== null) setReactionStats(reactions.like);
        else setArticleLikes(null);
        setCommentsStatus(strings.loaded || '', 'ok');
        if (recoveringFromUnknown) {
          // Keep the uncertainty notice visible after the state has been
          // re-read and the controls are usable again.
          updateReactionUI({ preserveNote: true });
          if (reactionNoteElement) setReactionNote(strings.reactionUnknown || '', false);
        } else {
          updateReactionUI();
        }
      }).catch(function (error) {
        state.article = null;
        state.articleFailed = true;
        var message = errorMessage(error, strings) || strings.errorGeneric || '';
        showCommentsError(message);
        updateReactionControls();
      }).then(function () {
        state.commentsLoading = false;
        if (nodes && nodes.root) nodes.root.setAttribute('aria-busy', 'false');
      });
    }

    function boot() {
      if (state.booting) return;
      state.booting = true;
      if (state.commentsEnabled !== false) showCommentsLoading();
      if (reactionNoteElement) setReactionNote(strings.reactionsLoading || '', false);
      reactionElements().forEach(function (entry) {
        entry.button.disabled = true;
      });
      fetchSession().then(function (session) {
        state.booting = false;
        applySession(session);
        if (state.commentsEnabled === false) {
          showCommentsDisabled();
          setReactionUnavailable(strings.serviceDisabledHint || '');
          return;
        }
        loadComments();
      }, function (error) {
        state.booting = false;
        applySessionFailure(error);
        loadComments();
      });
    }

    function requestComment(payload) {
      if (!state.session || !state.session.csrfToken) {
        var missing = new Error('Missing CSRF token');
        missing.status = 401;
        return Promise.reject(missing);
      }
      return requestJSON(
        state.base + '/api/articles/' + encodeURIComponent(state.commentId) + '/comments',
        jsonPostOptions(payload, state.session.csrfToken)
      );
    }

    function commentVisibleToCurrentViewer(comment) {
      if (!comment) return false;
      var visibility = normalizeVisibility(comment.visibility);
      if (visibility === 'public') return true;
      if (!state.session || !state.session.authenticated) return false;
      if (visibility === 'commenter') return comment.isAuthor === true;
      if (visibility === 'blogger') {
        var viewerLogin = String(state.session.viewer && state.session.viewer.login || '').toLowerCase();
        var blogger = String(state.config && state.config.blogger || '').toLowerCase();
        return !!viewerLogin && viewerLogin === blogger;
      }
      return false;
    }

    function setRateLimit(seconds) {
      if (!seconds) return;
      state.rateLimitUntil = Date.now() + seconds * 1000;
      updateSendButton();
      window.setTimeout(function () {
        state.rateLimitUntil = 0;
        updateSendButton();
      }, seconds * 1000 + 30);
    }

    function finishCommentSend(success, payload, data, error) {
      state.sending = false;
      if (nodes && nodes.body) nodes.body.readOnly = false;
      if (success) {
        var response = data && typeof data === 'object' ? data : {};
        var duplicate = response.duplicate === true;
        var refreshFailed = response.refreshFailed === true;
        var responseComment = response.comment && typeof response.comment === 'object'
          ? normalizeComment(response.comment)
          : null;
        var visible = !!responseComment && commentVisibleToCurrentViewer(responseComment);
        var previousCount = state.commentCount;
        var count = nonNegativeInteger(response.commentCount);
        var nextCount = count;
        if (duplicate) {
          // A duplicate 200 means the write already succeeded earlier. Keep the
          // last trustworthy count when the response cannot provide one.
          nextCount = count !== null ? count : previousCount;
        } else if (count === null) {
          if (refreshFailed && visible && previousCount !== null) {
            nextCount = previousCount + 1;
          } else {
            nextCount = previousCount;
          }
        }
        setArticleCount(nextCount);
        if (state.article) state.article.commentCount = nextCount;

        if (visible && !commentCardExists(responseComment)) {
          state.comments.push(responseComment);
          renderComments(state.comments);
        }

        clearDraft();
        clearComposerQuote();
        setValidation('');
        if (nodes && nodes.body) {
          nodes.body.value = '';
          updateCharacterCount();
          autoGrow();
          nodes.body.focus({ preventScroll: true });
        }

        var successMessage;
        if (duplicate) {
          successMessage = strings.duplicateConfirmed || strings.publishSuccess || '';
        } else if (responseComment && !visible) {
          successMessage = strings.publishHidden || strings.publishSuccess || '';
        } else if (payload && payload.visibility && payload.visibility !== 'public') {
          successMessage = strings.publishFiltered || strings.publishSuccess || '';
        } else {
          successMessage = strings.publishSuccess || '';
        }
        var warning = '';
        if (refreshFailed) warning = strings.refreshFailed || '';
        else if (typeof response.warning === 'string' && response.warning.trim()) {
          warning = response.warning.trim();
        }
        setComposerStatus(warning, warning ? 'error' : '');
        showCommentSuccess(successMessage);
        setCommentsStatus(strings.loaded || '', 'ok');
      } else {
        var message = errorMessage(error, strings) || strings.errorUnknown || '';
        if (error && (error.status === 401 || (error.error && error.error.code === 'session_expired'))) {
          handleAuthExpired();
          message = strings.errorSession || strings.loginExpired || message;
        }
        if (error && error.status === 429) {
          setRateLimit(retrySeconds(error));
        }
        saveDraft();
        setComposerStatus(message, 'error');
      }
      updateEditorControls();
      updateSendButton();
    }

    function sendComment(payload) {
      if (state.sending) return;
      payload.submissionId = ensureSubmissionId();
      // Persist the nonce before the request so a reloaded draft retry can
      // reuse the same idempotency key. The draft stays private to this tab.
      saveDraft();
      state.sending = true;
      setValidation('');
      setComposerStatus(strings.sending || '', 'loading');
      updateEditorControls();
      if (nodes && nodes.body) nodes.body.readOnly = true;
      requestComment(payload).then(function (data) {
        finishCommentSend(true, payload, data || {}, null);
      }, function (error) {
        finishCommentSend(false, payload, null, error);
      });
    }

    function openVisibilityDialog(scopeLabel, invoker) {
      var dialog = nodes && nodes.dialog;
      if (!dialog) return Promise.resolve(false);
      var warningText = strings.publicWarning || '';
      if (typeof dialog.showModal !== 'function') {
        return Promise.resolve(window.confirm(warningText + '\n\n' + scopeLabel));
      }
      if (nodes.confirmScope) nodes.confirmScope.textContent = scopeLabel;
      return new Promise(function (resolve) {
        state.confirmResolve = resolve;
        state.confirmInvoker = invoker || null;
        try {
          dialog.showModal();
        } catch (error) {
          state.confirmResolve = null;
          state.confirmInvoker = null;
          resolve(window.confirm(warningText + '\n\n' + scopeLabel));
          return;
        }
        if (nodes.confirmCancel) nodes.confirmCancel.focus();
      });
    }

    function dialogFocusables(dialog) {
      return [nodes.confirmCancel, nodes.confirmContinue].filter(function (element) {
        if (!element || element.disabled) return false;
        var styles = window.getComputedStyle(element);
        return styles.display !== 'none' && styles.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
    }

    function finishVisibilityDialog(confirmed) {
      var resolve = state.confirmResolve;
      state.confirmResolve = null;
      state.confirmInvoker = null;
      var dialog = nodes && nodes.dialog;
      if (dialog && dialog.open) dialog.close(confirmed ? 'continue' : 'cancel');
      if (typeof resolve === 'function') resolve(!!confirmed);
    }

    function bindDialog() {
      if (!nodes || !nodes.dialog) return;
      var dialog = nodes.dialog;
      if (nodes.confirmCancel) {
        on(nodes.confirmCancel, 'click', function () {
          finishVisibilityDialog(false);
        });
      }
      if (nodes.confirmContinue) {
        on(nodes.confirmContinue, 'click', function () {
          finishVisibilityDialog(true);
        });
      }
      on(dialog, 'cancel', function (event) {
        event.preventDefault();
        finishVisibilityDialog(false);
      });
      on(document, 'keydown', function (event) {
        if (event.key !== 'Tab' || !dialog.open) return;
        var focusables = dialogFocusables(dialog);
        if (!focusables.length) {
          event.preventDefault();
          return;
        }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        var active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || !dialog.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      });
      on(dialog, 'close', function () {
        if (typeof state.confirmResolve === 'function') {
          var resolve = state.confirmResolve;
          state.confirmResolve = null;
          resolve(false);
        }
      });
      on(dialog, 'click', function (event) {
        if (event.target === dialog) finishVisibilityDialog(false);
      });
    }

    function submitComment() {
      if (!nodes || !nodes.body) return;
      if (state.sending || state.confirming || state.uploading) return;
      if (!isEditorAvailable()) {
        var unavailableMessage = strings.serviceDisabledHint || '';
        if (state.authConfigured === false) unavailableMessage = strings.loginUnavailable || '';
        else if (state.sessionFailed) unavailableMessage = strings.sessionError || '';
        setComposerStatus(unavailableMessage, 'error');
        return;
      }
      if (state.authConfigured === false) {
        setComposerStatus(strings.loginUnavailable || '', 'error');
        return;
      }
      var body = String(nodes.body.value || '').trim();
      var length = Array.from ? Array.from(body).length : body.length;
      if (!body) {
        setValidation(strings.emptyError || '');
        nodes.body.focus();
        return;
      }
      if (length > MAX_COMMENT_LENGTH) {
        setValidation(strings.tooLongError || '');
        nodes.body.focus();
        return;
      }
      if (Date.now() < state.rateLimitUntil) {
        setValidation(formatTemplate(strings.errorRateLimitedRetry || '', {
          seconds: Math.ceil((state.rateLimitUntil - Date.now()) / 1000)
        }));
        return;
      }
      if (!state.session || !state.session.authenticated) {
        if (state.sessionFailed) {
          setComposerStatus(strings.sessionError || '', 'error');
          return;
        }
        saveDraft();
        setComposerStatus(strings.loginPending || '', 'loading');
        updateSendButton();
        window.location.assign(getLoginHref());
        return;
      }
      if (!state.session.csrfToken) {
        setComposerStatus(strings.errorSession || '', 'error');
        return;
      }

      setValidation('');
      var visibility = selectedVisibility();
      var quote = quoteForSubmit();
      var payload = {
        body: body,
        visibility: visibility,
        effect: state.retryEffect,
        title: state.articleTitle,
        articleUrl: state.articleUrl
      };
      if (quote) payload.quote = quote;

      if (visibility === 'public') {
        sendComment(payload);
        return;
      }

      var selected = nodes.visibility && nodes.visibility.options[nodes.visibility.selectedIndex];
      var scopeLabel = selected ? selected.textContent : visibility;
      var active = document.activeElement;
      var invoker = active && active !== document.body && document.contains(active) ? active : nodes.send;
      state.confirming = true;
      updateEditorControls();
      openVisibilityDialog(scopeLabel, invoker).then(function (confirmed) {
        state.confirming = false;
        updateEditorControls();
        if (invoker && typeof invoker.focus === 'function' && document.contains(invoker)) {
          invoker.focus();
        }
        if (!confirmed) return;
        sendComment(payload);
      });
    }

    function uploadAttachment(file) {
      if (!file || state.uploading) return;
      if (!state.session || !state.session.authenticated) {
        setComposerStatus(strings.attachmentLogin || '', 'error');
        return;
      }
      if (!state.session.csrfToken) {
        setComposerStatus(strings.errorSession || '', 'error');
        return;
      }
      var attachments = state.attachments;
      if (!attachments.enabled) {
        setAttachmentNote(strings.attachmentUnavailable || '', true);
        setComposerStatus(strings.attachmentDisabledError || '', 'error');
        updateAttachmentControl();
        return;
      }
      if (attachments.allowedTypes.length && attachments.allowedTypes.indexOf(file.type) === -1) {
        setAttachmentNote(strings.attachmentInvalidType || '', true);
        setComposerStatus(strings.attachmentInvalidType || '', 'error');
        return;
      }
      if (attachments.maxBytes && file.size > attachments.maxBytes) {
        var max = formatBytes(attachments.maxBytes);
        setAttachmentNote(formatTemplate(strings.attachmentTooLarge || '', { size: max }), true);
        setComposerStatus(formatTemplate(strings.attachmentTooLarge || '', { size: max }), 'error');
        return;
      }

      state.uploading = true;
      updateAttachmentControl();
      updateEditorControls();
      if (nodes.attachmentProgressWrap) nodes.attachmentProgressWrap.hidden = false;
      if (nodes.attachmentProgress) {
        nodes.attachmentProgress.value = 0;
        nodes.attachmentProgress.setAttribute('aria-label', strings.attachmentUploading || '');
      }
      if (nodes.attachmentProgressText) nodes.attachmentProgressText.textContent = '0%';
      setAttachmentNote(formatTemplate(strings.attachmentUploading || '', { percent: 0 }), false);
      setComposerStatus(strings.attachmentUploading ? formatTemplate(strings.attachmentUploading, { percent: 0 }) : '', 'loading');

      var xhr = new XMLHttpRequest();
      var finished = false;

      function finishUpload(success, message, attachment) {
        if (finished) return;
        finished = true;
        state.uploading = false;
        if (nodes.attachmentProgressWrap) nodes.attachmentProgressWrap.hidden = true;
        updateAttachmentControl();
        updateEditorControls();
        if (success && attachment) {
          insertAttachmentMarkdown(file, attachment);
          setComposerStatus(strings.attachmentSuccess || '', 'success');
          setAttachmentNote(strings.attachmentPublic || '', false);
        } else {
          setComposerStatus(message || strings.attachmentFailed || '', 'error');
          setAttachmentNote(message || strings.attachmentFailed || '', true);
        }
      }

      function parseResponse(raw) {
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch (error) {
          return null;
        }
      }

      on(xhr.upload, 'progress', function (event) {
        if (!event.lengthComputable) return;
        var percent = Math.max(0, Math.min(99, Math.round((event.loaded / event.total) * 100)));
        if (nodes.attachmentProgress) nodes.attachmentProgress.value = percent;
        if (nodes.attachmentProgressText) nodes.attachmentProgressText.textContent = percent + '%';
        setAttachmentNote(formatTemplate(strings.attachmentUploading || '', { percent: percent }), false);
        setComposerStatus(formatTemplate(strings.attachmentUploading || '', { percent: percent }), 'loading');
      });

      xhr.open('POST', state.base + '/api/attachments', true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-CSRF-Token', state.session.csrfToken);
      xhr.timeout = 120000;

      xhr.onload = function () {
        var data = parseResponse(xhr.responseText);
        var ok = xhr.status >= 200 && xhr.status < 300;
        if (ok) {
          var attachment = data && data.attachment && typeof data.attachment === 'object' ? data.attachment : null;
          var url = attachment ? safeHttpUrl(attachment.url) : '';
          if (!attachment || !url) {
            finishUpload(false, strings.attachmentFailed || '', null);
            return;
          }
          attachment.url = url;
          if (nodes.attachmentProgress) nodes.attachmentProgress.value = 100;
          if (nodes.attachmentProgressText) nodes.attachmentProgressText.textContent = '100%';
          finishUpload(true, '', attachment);
          return;
        }
        var failure = new Error('Upload failed');
        failure.status = xhr.status;
        failure.data = data;
        failure.error = normalizeErrorPayload(data);
        failure.retryAfter = xhr.getResponseHeader('Retry-After') || '';
        var message = errorMessage(failure, strings) || strings.attachmentFailed || '';
        if (xhr.status === 401) {
          handleAuthExpired();
          message = strings.errorSession || message;
        }
        if (failure.error && failure.error.code === 'attachments_disabled') {
          state.attachments.enabled = false;
          message = strings.attachmentUnavailable || message;
        }
        finishUpload(false, message, null);
      };

      xhr.onerror = function () {
        finishUpload(false, strings.networkError || strings.attachmentFailed || '', null);
      };

      xhr.ontimeout = function () {
        finishUpload(false, strings.attachmentFailed || '', null);
      };

      var formData = new FormData();
      formData.append('file', file, file.name);
      xhr.send(formData);
    }

    function insertAttachmentMarkdown(file, attachment) {
      if (!nodes || !nodes.body) return;
      var body = nodes.body;
      var name = String(attachment.name || file.name || 'attachment').replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'attachment';
      var url = safeHttpUrl(attachment.url);
      if (!url) return;
      var mime = String(attachment.mime || file.type || '');
      var markdown = (mime.indexOf('image/') === 0 ? '![' : '[') + name + '](' + url + ')';
      var start = typeof body.selectionStart === 'number' ? body.selectionStart : body.value.length;
      var end = typeof body.selectionEnd === 'number' ? body.selectionEnd : start;
      var before = body.value.slice(0, start);
      var after = body.value.slice(end);
      var prefix = before && !/\n$/.test(before) ? '\n' : '';
      var suffix = after && !/^\n/.test(after) ? '\n' : '';
      var insertion = prefix + markdown + suffix;
      if (typeof body.setRangeText === 'function') {
        body.setRangeText(insertion, start, end, 'end');
      } else {
        body.value = before + insertion + after;
      }
      updateCharacterCount();
      autoGrow();
      body.dispatchEvent(new Event('input', { bubbles: true }));
      body.focus();
    }

    function chooseAttachment() {
      if (!nodes || !nodes.attachmentInput || nodes.attachmentButton.disabled) return;
      setValidation('');
      setAttachmentNote(strings.attachmentPublic || '', false);
      closeInsertMenu(false);
      if (nodes.body) nodes.body.focus({ preventScroll: true });
      nodes.attachmentInput.click();
    }

    function rememberInsertSelection() {
      if (!nodes || !nodes.body) return;
      state.insertSelection = {
        start: typeof nodes.body.selectionStart === 'number' ? nodes.body.selectionStart : nodes.body.value.length,
        end: typeof nodes.body.selectionEnd === 'number' ? nodes.body.selectionEnd : nodes.body.value.length
      };
    }

    function openInsertMenu() {
      if (!nodes || !nodes.insertMenu || !nodes.insertToggle || nodes.insertToggle.disabled) return;
      closeScopeMenu(false);
      if (scopeInfo && scopeInfo.open) scopeInfo.open = false;
      rememberInsertSelection();
      state.insertMenuOpen = true;
      nodes.insertMenu.hidden = false;
      nodes.insertToggle.setAttribute('aria-expanded', 'true');
      positionInsertMenu();
      window.requestAnimationFrame(function () {
        if (!state.insertMenuOpen) return;
        var first = $('[data-insert-emoji]', nodes.insertMenu);
        if (first) first.focus();
      });
    }

    function closeInsertMenu(restoreFocus) {
      if (!nodes || !nodes.insertMenu) return;
      var wasOpen = state.insertMenuOpen;
      state.insertMenuOpen = false;
      nodes.insertMenu.hidden = true;
      if (nodes.insertToggle) {
        nodes.insertToggle.setAttribute('aria-expanded', 'false');
        if (restoreFocus && wasOpen) nodes.insertToggle.focus({ preventScroll: true });
      }
    }

    function insertEmoji(emoji) {
      if (!nodes || !nodes.body || !emoji || state.composing || nodes.body.disabled || nodes.body.readOnly) return;
      var body = nodes.body;
      var selection = state.insertSelection || { start: body.selectionStart, end: body.selectionEnd };
      var start = Math.max(0, Math.min(body.value.length, Number(selection.start) || 0));
      var end = Math.max(start, Math.min(body.value.length, Number(selection.end) || start));
      if (body.maxLength >= 0 && body.value.length - (end - start) + emoji.length > body.maxLength) {
        setValidation(strings.tooLongError || '');
        closeInsertMenu(false);
        body.focus({ preventScroll: true });
        return;
      }
      if (typeof body.setRangeText === 'function') body.setRangeText(emoji, start, end, 'end');
      else {
        body.value = body.value.slice(0, start) + emoji + body.value.slice(end);
        body.setSelectionRange(start + emoji.length, start + emoji.length);
      }
      closeInsertMenu(false);
      body.dispatchEvent(new Event('input', { bubbles: true }));
      body.focus({ preventScroll: true });
    }

    function bindInsertMenu() {
      if (!nodes || !nodes.insertToggle || !nodes.insertMenu) return;
      on(nodes.insertToggle, 'click', function () {
        if (state.insertMenuOpen) closeInsertMenu(true);
        else openInsertMenu();
      });
      $$('[data-insert-emoji]', nodes.insertMenu).forEach(function (button) {
        on(button, 'click', function () { insertEmoji(button.getAttribute('data-insert-emoji') || ''); });
      });
      on(document, 'click', function (event) {
        if (state.insertMenuOpen && nodes.insertRoot && !nodes.insertRoot.contains(event.target)) closeInsertMenu(false);
      });
      on(document, 'focusin', function (event) {
        if (state.insertMenuOpen && nodes.insertRoot && !nodes.insertRoot.contains(event.target)) closeInsertMenu(false);
      });
    }

    function closeScopeMenu(restoreFocus) {
      if (!nodes || !nodes.scopeMenu) return;
      var wasOpen = state.scopeMenuOpen;
      state.scopeMenuOpen = false;
      nodes.scopeMenu.hidden = true;
      if (scopeControl) scopeControl.setAttribute('data-scope-open', 'false');
      if (nodes.form) nodes.form.classList.remove('is-scope-menu-open');
      if (nodes.scopeToggle) {
        nodes.scopeToggle.setAttribute('aria-expanded', 'false');
        if (restoreFocus && wasOpen && !nodes.scopeToggle.disabled) nodes.scopeToggle.focus({ preventScroll: true });
      }
    }

    function openScopeMenu() {
      if (!nodes || !nodes.scopeMenu || !nodes.scopeToggle || nodes.scopeToggle.disabled) return;
      closeInsertMenu(false);
      if (scopeInfo && scopeInfo.open) scopeInfo.open = false;
      state.scopeMenuOpen = true;
      nodes.scopeMenu.hidden = false;
      if (scopeControl) scopeControl.setAttribute('data-scope-open', 'true');
      if (nodes.form) nodes.form.classList.add('is-scope-menu-open');
      nodes.scopeToggle.setAttribute('aria-expanded', 'true');
      positionScopeMenu();
      window.requestAnimationFrame(function () {
        if (!state.scopeMenuOpen) return;
        var selected = $('[data-scope-choice][aria-selected="true"]', nodes.scopeMenu);
        if (selected) {
          selected.focus({ preventScroll: true });
          selected.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    function chooseScope(value) {
      if (!nodes || !nodes.visibility) return;
      var next = normalizeVisibility(value);
      if (nodes.visibility.value !== next) {
        nodes.visibility.value = next;
        nodes.visibility.dispatchEvent(new Event('change', { bubbles: true }));
      }
      closeScopeMenu(true);
    }

    function bindScopeMenu() {
      if (!nodes || !nodes.scopeToggle || !nodes.scopeMenu) return;
      on(nodes.scopeToggle, 'click', function () {
        if (state.scopeMenuOpen) closeScopeMenu(true);
        else openScopeMenu();
      });
      on(nodes.scopeToggle, 'keydown', function (event) {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        if (!state.scopeMenuOpen) openScopeMenu();
      });
      on(nodes.scopeMenu, 'click', function (event) {
        var choice = event.target && event.target.closest ? event.target.closest('[data-scope-choice]') : null;
        if (choice && nodes.scopeMenu.contains(choice)) chooseScope(choice.getAttribute('data-scope-choice'));
      });
      on(nodes.scopeMenu, 'keydown', function (event) {
        var choices = $$('[data-scope-choice]', nodes.scopeMenu);
        var index = choices.indexOf(document.activeElement);
        if (event.key === 'Tab') {
          event.preventDefault();
          closeScopeMenu(false);
          var next = event.shiftKey ? nodes.scopeToggle : scopeTrigger;
          if (next) next.focus({ preventScroll: true });
          return;
        }
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          if (index >= 0) {
            event.preventDefault();
            chooseScope(choices[index].getAttribute('data-scope-choice'));
          }
          return;
        }
        var nextIndex = index;
        if (event.key === 'ArrowDown') nextIndex = (Math.max(index, 0) + 1) % choices.length;
        else if (event.key === 'ArrowUp') nextIndex = (Math.max(index, 0) - 1 + choices.length) % choices.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = choices.length - 1;
        else return;
        if (!choices.length) return;
        event.preventDefault();
        choices[nextIndex].focus({ preventScroll: true });
        choices[nextIndex].scrollIntoView({ block: 'nearest' });
      });
      on(document, 'click', function (event) {
        if (state.scopeMenuOpen && scopeControl && !scopeControl.contains(event.target)) closeScopeMenu(false);
      });
      on(document, 'focusin', function (event) {
        if (state.scopeMenuOpen && scopeControl && !scopeControl.contains(event.target)) closeScopeMenu(false);
      });
    }

    function bindForm() {
      if (!nodes || !nodes.form) return;

      on(nodes.form, 'submit', function (event) {
        event.preventDefault();
        submitComment();
      });

      on(nodes.form, 'focusin', function () {
        syncQuoteFromModule();
      });

      on(document, 'threadline:quote-change', function (event) {
        var detail = event && event.detail ? event.detail : null;
        var quote = normalizeQuote(detail ? detail.quote : null);
        resetSubmissionId();
        if (quote) {
          state.quote = quote;
          state.quoteFromModule = true;
        } else {
          state.quote = null;
          state.quoteFromModule = false;
        }
        renderQuoteChip();
      });

      on(nodes.body, 'input', function () {
        resetSubmissionId();
        updateCharacterCount();
        setValidation('');
        updateSendButton();
        autoGrow();
      });

      on(nodes.body, 'compositionstart', function () {
        state.composing = true;
      });
      on(nodes.body, 'compositionend', function () {
        state.composing = false;
        updateCharacterCount();
        autoGrow();
      });
      on(nodes.body, 'keydown', function (event) {
        if (event.key !== 'Enter') return;
        if (event.shiftKey) return;
        if (state.composing || event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        submitComment();
      });

      on(nodes.visibility, 'change', function () {
        resetSubmissionId();
        updateVisibilityWarning();
        setValidation('');
      });

      on(nodes.quoteRemove, 'click', function () {
        clearComposerQuote();
        if (nodes.body) nodes.body.focus({ preventScroll: true });
      });

      on(nodes.attachmentButton, 'click', chooseAttachment);
      on(nodes.attachmentInput, 'change', function () {
        var file = nodes.attachmentInput.files && nodes.attachmentInput.files[0];
        nodes.attachmentInput.value = '';
        if (!file) {
          setComposerStatus(strings.attachmentCancelled || '', '');
          return;
        }
        uploadAttachment(file);
      });

      if (nodes.retry) {
        on(nodes.retry, 'click', function () {
          boot();
        });
      }

      on(document, 'keydown', function (event) {
        if (event.key !== 'Escape') return;
        if (event.isComposing || state.composing || event.keyCode === 229) return;
        if (nodes.dialog && nodes.dialog.open) return;
        if (state.scopeMenuOpen) {
          event.preventDefault();
          closeScopeMenu(true);
          return;
        }
        if (state.insertMenuOpen) {
          event.preventDefault();
          closeInsertMenu(true);
          return;
        }
        if (state.panelOpen) {
          event.preventDefault();
          closePanel({ restoreFocus: true });
        }
      });

      bindInsertMenu();
      bindScopeMenu();
      bindDialog();
      updateVisibilityWarning();
      renderQuoteChip();
      updateCharacterCount();
      updateSendButton();
      updateAttachmentControl();
    }

    function initializeUnavailable() {
      var runtimeInvalid = configState === 'configured' && !configured;
      var serviceMessage = commentsElement ? (commentsElement.getAttribute('data-service-message') || '') : '';
      if (commentsElement) commentsElement.setAttribute('aria-busy', 'false');
      setAccountState(runtimeInvalid || configState === 'invalid' ? 'error' : 'unconfigured');
      if (nodes) {
        setArticleCountsLoading();
        if (runtimeInvalid) {
          hideCommentStates();
          if (nodes.error) nodes.error.hidden = false;
          if (nodes.errorTitle) nodes.errorTitle.textContent = strings.serviceInvalid || '';
          if (nodes.errorMessage) nodes.errorMessage.textContent = strings.serviceInvalidHint || '';
          if (nodes.retry) nodes.retry.hidden = true;
          setCommentsState('invalid');
          setCommentsStatus(strings.serviceInvalid || '', 'error');
        } else {
          setCommentsState(configState === 'invalid' ? 'invalid' : 'unconfigured');
        }
      }
      if (actionsElement) {
        var note = [serviceMessage, strings.reactionsUnavailable || ''].filter(Boolean).join(' ');
        setReactionUnavailable(note || strings.reactionsUnavailable || '');
      }
    }

    bindPanel();
    if (configured) {
      var authResult = cleanAuthQuery();
      showAuthResult(authResult);
    }

    if (!configured) {
      initializeUnavailable();
      return;
    }

    bindForm();
    updateAttachmentControl();
    updateSendButton();
    if (actionsElement) updateReactionLoading();
    if (nodes) {
      on(document, 'click', function (event) {
        var anchor = event.target && event.target.closest
          ? event.target.closest('a[href*="/api/auth/github?"]')
          : null;
        if (anchor) saveDraft();
      });
    }
    boot();
  });

  // Exposed only for local verification of the dependency-free renderer. The
  // production UI always uses renderMarkdown internally.
  DSH.renderCommentMarkdown = renderMarkdown;
})();
