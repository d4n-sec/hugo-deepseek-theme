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

  function readStrings() {
    var node = document.getElementById('article-strings');
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

  function isReducedMotion() {
    return typeof DSH.prefersReducedMotion === 'function' && DSH.prefersReducedMotion();
  }

  function showToast(message, tone) {
    if (message && typeof DSH.toast === 'function') {
      DSH.toast(message, tone ? { tone: tone } : undefined);
    }
  }

  function initTyping(article, body, strings) {
    var THINKING_DELAY = 500;
    var readerConfig = (DSH.config && DSH.config.reader) || {};
    var streamPanel = article.querySelector('[data-reader-stream]');
    var skipButton = article.querySelector('[data-reader-skip]');
    var announcer = article.querySelector('[data-reader-announcer]');
    var panel = document.getElementById('trajectory-panel');
    var records = [];
    var units = [];
    var pending = new Map();
    var state = 'idle';
    var frame = null;
    var thinkingTimer = null;
    var observer = null;
    var startedAt = 0;
    var duration = 0;
    var totalWeight = 0;
    var cursor = 0;
    var consumed = 0;
    var labelSource = document.querySelector('[data-article-index]');
    var fallbackThinking = labelSource ? labelSource.getAttribute('data-reader-thinking-label') || '' : '';
    var fallbackSkip = labelSource ? labelSource.getAttribute('data-reader-skip-label') || '' : '';
    var thinkingLabel = strings.thinking || fallbackThinking || 'Thinking';
    var skipLabel = strings.skipAnimation || fallbackSkip || '';
    var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    function setState(value) {
      state = value;
      article.setAttribute('data-reader-state', value);
    }

    function hasFragment() {
      if (window.location.href.indexOf('#') !== -1) return true;
      try {
        var navigation = window.performance && window.performance.getEntriesByType
          ? window.performance.getEntriesByType('navigation') : [];
        return !!(navigation.length && navigation[0].name.indexOf('#') !== -1);
      } catch (error) {
        return false;
      }
    }

    function scrollToFragment() {
      var fragment = window.location.hash.slice(1);
      if (!fragment) return;
      try { fragment = decodeURIComponent(fragment); } catch (error) { /* Use the original fragment. */ }
      var target = document.getElementById(fragment);
      if (!target) {
        var named = document.getElementsByName(fragment);
        for (var index = 0; index < named.length; index += 1) {
          if (named[index].tagName === 'A') { target = named[index]; break; }
        }
      }
      if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView();
    }

    function setSkipLabel(button, label) {
      if (!button || !label) return;
      var icon = button.querySelector('.icon');
      button.textContent = '';
      if (icon) button.appendChild(icon);
      button.appendChild(document.createTextNode(label));
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }

    function prepareStreamUI() {
      if (!streamPanel) return;
      var status = streamPanel.querySelector('.reader-stream__status');
      if (!status) {
        status = document.createElement('span');
        status.className = 'reader-stream__status';
        streamPanel.insertBefore(status, streamPanel.firstChild);
      }
      status.textContent = '';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');

      var pulse = document.createElement('span');
      pulse.className = 'reader-stream__pulse';
      pulse.setAttribute('aria-hidden', 'true');
      status.appendChild(pulse);

      var label = document.createElement('span');
      label.className = 'reader-stream__label';
      label.textContent = thinkingLabel;
      status.appendChild(label);

      var dots = document.createElement('span');
      dots.className = 'reader-stream__dots';
      dots.setAttribute('aria-hidden', 'true');
      for (var index = 0; index < 3; index += 1) {
        var dot = document.createElement('span');
        dots.appendChild(dot);
      }
      status.appendChild(dots);

      if (skipButton) {
        setSkipLabel(skipButton, skipLabel || (skipButton.textContent || '').replace(/\s+/g, ' ').trim());
        skipButton.setAttribute('aria-keyshortcuts', 'Escape');
      }
    }

    function restoreDom() {
      records.forEach(function (record) {
        record.node.nodeValue = record.original;
      });
      pending.forEach(function (_, element) {
        releasePending(element);
      });
      body.removeAttribute('aria-busy');
      article.classList.remove('is-reader-animating');
      if (streamPanel) streamPanel.hidden = true;
    }

    function finish(options) {
      if (state !== 'thinking' && state !== 'streaming') return false;
      var opts = options || {};
      if (thinkingTimer !== null) {
        window.clearTimeout(thinkingTimer);
        thinkingTimer = null;
      }
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      restoreDom();
      if (opts.focus !== false) {
        var active = document.activeElement;
        if (streamPanel && active && streamPanel.contains(active)) {
          var main = document.getElementById('main');
          if (main && typeof main.focus === 'function') main.focus({ preventScroll: true });
        }
      }
      setState('complete');
      if (opts.announce !== false && announcer) {
        announcer.textContent = strings.readerComplete || '';
      }
      return true;
    }

    function atomicWeight(element) {
      var text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      var length = Array.from(text).length;
      return Math.min(140, Math.max(10, Math.ceil(length / 3)));
    }

    function markPending(element) {
      pending.set(element, {
        hadClass: element.hasAttribute('class'),
        hadPending: element.classList.contains('is-reader-pending')
      });
      element.classList.add('is-reader-pending');
    }

    function releasePending(element) {
      var original = pending.get(element);
      if (!original) return;
      if (!original.hadPending) element.classList.remove('is-reader-pending');
      if (!original.hadClass && element.getAttribute('class') === '') element.removeAttribute('class');
      pending.delete(element);
    }

    function revealPath(element) {
      while (element && element !== body) {
        releasePending(element);
        element = element.parentElement;
      }
    }

    function collect(node) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === Node.TEXT_NODE) {
          var value = child.nodeValue || '';
          if (!/\S/.test(value)) return;
          var record = {
            node: child,
            original: value,
            characters: Array.from(value),
            shown: 0
          };
          records.push(record);
          units.push({ type: 'text', record: record, weight: record.characters.length });
          return;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        var tag = child.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
        markPending(child);
        if (!child.childNodes.length || child.matches('pre, .highlight, table, img, picture, video, audio, iframe, object, embed, svg, canvas, figure, [data-reader-math]')) {
          units.push({
            type: 'atomic',
            element: child,
            weight: child.childNodes.length ? atomicWeight(child) : 1
          });
          return;
        }
        collect(child);
      });
    }

    function reveal(target) {
      while (cursor < units.length) {
        var unit = units[cursor];
        if (unit.type === 'atomic') {
          if (target - consumed < unit.weight) break;
          revealPath(unit.element);
          consumed += unit.weight;
          cursor += 1;
          continue;
        }
        var record = unit.record;
        var allowance = target - consumed;
        if (allowance <= 0) break;
        var remaining = record.characters.length - record.shown;
        var take = Math.min(remaining, allowance);
        if (take > 0) {
          record.node.nodeValue += record.characters.slice(record.shown, record.shown + take).join('');
          if (/\S/.test(record.node.nodeValue)) revealPath(record.node.parentElement);
          record.shown += take;
          consumed += take;
        }
        if (record.shown >= record.characters.length) {
          cursor += 1;
          continue;
        }
        break;
      }
    }

    function tick(now) {
      if (state !== 'streaming') return;
      try {
        var elapsed = now - startedAt;
        var progress = duration > 0 ? Math.min(1, elapsed / duration) : 1;
        var eased = 1 - Math.pow(1 - progress, 1.18);
        reveal(Math.floor(totalWeight * eased));
        if (progress >= 1) {
          finish({ announce: true });
          return;
        }
        frame = window.requestAnimationFrame(tick);
      } catch (error) {
        finish({ announce: false, focus: false });
      }
    }

    function beginStreaming() {
      thinkingTimer = null;
      if (state !== 'thinking') return;
      try {
        setState('streaming');
        startedAt = window.performance && window.performance.now ? window.performance.now() : Date.now();
        frame = window.requestAnimationFrame(function (now) {
          startedAt = now;
          frame = window.requestAnimationFrame(tick);
        });
      } catch (error) {
        finish({ announce: false, focus: false });
      }
    }

    function start() {
      if (state !== 'idle') return;
      if (readerConfig.typing !== true || hasFragment()) {
        setState('static');
        return;
      }
      if (isReducedMotion() || document.visibilityState === 'hidden') {
        setState('static');
        return;
      }
      if (!body || !body.textContent || !body.textContent.trim()) {
        setState('static');
        return;
      }
      try {
        collect(body);
        totalWeight = units.reduce(function (sum, unit) { return sum + unit.weight; }, 0);
        if (!totalWeight) {
          restoreDom();
          setState('static');
          return;
        }
        var speed = Number(readerConfig.typingSpeed);
        if (!isFinite(speed) || speed <= 0) speed = 18;
        var charactersPerSecond = Math.min(325, Math.max(40, speed * 7));
        duration = Math.min(18000, Math.max(4800, (totalWeight / charactersPerSecond) * 1000)) / 0.7;
        records.forEach(function (record) {
          record.node.nodeValue = '';
        });
        body.setAttribute('aria-busy', 'true');
        article.classList.add('is-reader-animating');
        if (streamPanel) streamPanel.hidden = false;
        if (announcer) announcer.textContent = thinkingLabel;
        article.setAttribute('data-reader-duration', String(Math.round(duration)));
        article.setAttribute('data-reader-characters', String(totalWeight));
        setState('thinking');
        thinkingTimer = window.setTimeout(beginStreaming, THINKING_DELAY);
      } catch (error) {
        if (thinkingTimer !== null) {
          window.clearTimeout(thinkingTimer);
          thinkingTimer = null;
        }
        if (frame !== null) {
          window.cancelAnimationFrame(frame);
          frame = null;
        }
        restoreDom();
        setState('static');
      }
    }

    function finishFromExternal(options) {
      return finish(options || { announce: false });
    }

    if (skipButton) {
      skipButton.addEventListener('click', function () {
        finish({ announce: true });
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (state !== 'thinking' && state !== 'streaming') return;
      var active = document.activeElement;
      if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
      if (active && typeof active.closest === 'function' && active.closest('[role="dialog"], [data-comment-dock], [data-comments-root]')) return;
      finish({ announce: true });
    });

    window.addEventListener('pageshow', function (event) {
      if (event.persisted) finish({ announce: false });
    });

    window.addEventListener('hashchange', function (event) {
      var nextURL = event && typeof event.newURL === 'string' ? event.newURL : '';
      if ((nextURL.indexOf('#') === -1 && !hasFragment()) || !finish({ announce: false })) return;
      window.requestAnimationFrame(scrollToFragment);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') finish({ announce: false });
    });

    if (motionQuery) {
      var onMotionChange = function () {
        if (motionQuery.matches) finish({ announce: false });
      };
      if (typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', onMotionChange);
      } else if (typeof motionQuery.addListener === 'function') {
        motionQuery.addListener(onMotionChange);
      }
    }

    if (panel && typeof window.MutationObserver === 'function') {
      observer = new MutationObserver(function () {
        if (!panel.hidden) finish({ announce: false });
      });
      observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    }

    setState('idle');
    prepareStreamUI();
    start();

    return {
      finish: finishFromExternal,
      isStreaming: function () { return state === 'streaming'; },
      state: function () { return state; }
    };
  }

  function articlePermalink(article) {
    var canonical = document.querySelector('link[rel="canonical"]');
    if (canonical && canonical.href) return canonical.href;
    var declared = article.getAttribute('data-article-url');
    if (declared) return declared;
    return window.location.href.split('#')[0];
  }

  function articleText(article, body) {
    var title = article.getAttribute('data-article-title') || '';
    var bodyText = body ? (body.innerText || body.textContent || '') : '';
    bodyText = bodyText.replace(/^\s+|\s+$/g, '');
    if (title && bodyText) return title + '\n\n' + bodyText;
    return title || bodyText;
  }

  function initActions(article, body, strings) {
    var actions = article.querySelector('[data-message-actions]');
    if (!actions) return;
    var copyButton = actions.querySelector('[data-action="copy"]');
    var shareButton = actions.querySelector('[data-action="share"]');
    var articleTitle = article.getAttribute('data-article-title') || document.title;
    var permalink = articlePermalink(article);

    function finishReader() {
      if (DSH.reader && typeof DSH.reader.finish === 'function') {
        DSH.reader.finish({ announce: false });
      }
    }

    function copyArticle() {
      finishReader();
      if (typeof DSH.copyText !== 'function') {
        showToast(strings.copyFailure, 'error');
        return;
      }
      var text = articleText(article, body);
      DSH.copyText(text).then(function () {
        showToast(strings.copySuccess, 'success');
      }).catch(function () {
        showToast(strings.copyFailure, 'error');
      });
    }

    function copyPermalink() {
      if (typeof DSH.copyText !== 'function') {
        showToast(strings.shareFallbackFailure, 'error');
        return Promise.resolve(false);
      }
      return DSH.copyText(permalink).then(function () {
        showToast(strings.shareFallbackSuccess, 'success');
      }).catch(function () {
        showToast(strings.shareFallbackFailure, 'error');
      });
    }

    function shareArticle() {
      finishReader();
      var payload = { title: articleTitle, url: permalink };
      if (typeof navigator.share !== 'function') {
        copyPermalink();
        return;
      }
      var request;
      try {
        request = navigator.share(payload);
      } catch (error) {
        copyPermalink();
        return;
      }
      if (!request || typeof request.then !== 'function') {
        showToast(strings.shareSuccess, 'success');
        return;
      }
      request.then(function () {
        showToast(strings.shareSuccess, 'success');
      }).catch(function (error) {
        if (error && error.name === 'AbortError') {
          showToast(strings.shareCancelled);
          return;
        }
        copyPermalink();
      });
    }

    if (copyButton) {
      copyButton.disabled = false;
      copyButton.setAttribute('data-action-ready', 'true');
      copyButton.addEventListener('click', copyArticle);
    }
    if (shareButton) {
      shareButton.disabled = false;
      shareButton.setAttribute('data-action-ready', 'true');
      shareButton.addEventListener('click', shareArticle);
    }
    actions.setAttribute('data-article-actions-ready', 'true');
  }

  ready(function () {
    var article = document.querySelector('[data-article-page]');
    if (!article) return;
    var body = article.querySelector('[data-article-body]');
    var strings = readStrings();
    DSH.reader = initTyping(article, body, strings);
    initActions(article, body, strings);
  });
})();
