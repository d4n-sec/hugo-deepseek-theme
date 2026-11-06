;(function () {
  'use strict';

  var DSH = (window.DSH = window.DSH || {});

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
    if (!target || typeof target.addEventListener !== 'function') return null;
    target.addEventListener(type, listener, options);
    return target;
  }

  function ready(callback) {
    if (typeof callback !== 'function') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    if (value == null) return '';
    var raw = String(value).trim();
    if (!raw) return '';
    try {
      var parsed = new URL(raw, window.location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
        return parsed.href;
      }
    } catch (error) {
      return '';
    }
    return '';
  }

  function debounce(fn, wait) {
    var timer = null;
    var delay = typeof wait === 'number' ? wait : 200;
    function debounced() {
      var context = this;
      var args = arguments;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        timer = null;
        fn.apply(context, args);
      }, delay);
    }
    debounced.cancel = function () {
      window.clearTimeout(timer);
      timer = null;
    };
    return debounced;
  }

  var storage = {
    get: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        if (raw === null) return fallback;
        try {
          return JSON.parse(raw);
        } catch (error) {
          return raw;
        }
      } catch (error) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        return false;
      }
    },
    remove: function (key) {
      try {
        window.localStorage.removeItem(key);
        return true;
      } catch (error) {
        return false;
      }
    }
  };

  function prefersReducedMotion() {
    if (!window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  var config = {};
  try {
    var configNode = document.getElementById('site-config');
    if (configNode) config = JSON.parse(configNode.textContent || '{}');
  } catch (error) {
    config = {};
  }

  function formatCount(value, options) {
    var number = Number(value);
    if (!isFinite(number)) return String(value == null ? '' : value);
    var locale = config.languageCode || document.documentElement.lang || undefined;
    try {
      return new Intl.NumberFormat(locale, options || {}).format(number);
    } catch (error) {
      return String(number);
    }
  }

  function toast(message, options) {
    var region = document.getElementById('toast-region');
    if (!region) return null;
    var opts = options || {};
    var tone = opts.tone === 'error' || opts.tone === 'success' ? opts.tone : '';
    var node = document.createElement('div');
    node.className = 'toast' + (tone ? ' toast--' + tone : '');
    node.textContent = String(message == null ? '' : message);
    region.appendChild(node);
    window.requestAnimationFrame(function () {
      node.classList.add('is-visible');
    });
    var duration = typeof opts.duration === 'number' ? opts.duration : 3200;
    if (duration > 0) {
      window.setTimeout(function () {
        removeToast(node);
      }, duration);
    }
    return node;
  }

  function removeToast(node) {
    if (!node || !node.parentNode) return;
    node.classList.remove('is-visible');
    if (prefersReducedMotion()) {
      node.parentNode.removeChild(node);
      return;
    }
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 220);
  }

  function copyText(text) {
    var value = String(text == null ? '' : text);
    return new Promise(function (resolve, reject) {
      function fallback() {
        var area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-9999px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var succeeded = false;
        try {
          succeeded = document.execCommand('copy');
        } catch (error) {
          succeeded = false;
        }
        document.body.removeChild(area);
        if (succeeded) resolve(true);
        else reject(new Error('Copy failed'));
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(function () {
          resolve(true);
        }).catch(fallback);
      } else {
        fallback();
      }
    });
  }

  DSH.$ = $;
  DSH.$$ = $$;
  DSH.on = on;
  DSH.ready = ready;
  DSH.escapeHtml = escapeHtml;
  DSH.safeUrl = safeUrl;
  DSH.toast = toast;
  DSH.copyText = copyText;
  DSH.debounce = debounce;
  DSH.storage = storage;
  DSH.prefersReducedMotion = prefersReducedMotion;
  DSH.config = config;
  DSH.formatCount = formatCount;

  var COLLAPSED_KEY = 'threadline.sidebar.collapsed';
  var MOBILE_QUERY = '(max-width: 780px)';
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function initSidebar() {
    var sidebar = document.getElementById('site-sidebar');
    if (!sidebar) return;
    var body = document.body;
    var collapseButtons = $$('[data-sidebar-collapse]');
    var closeButtons = $$('[data-sidebar-close]');
    var menuButton = $('[data-sidebar-menu]');
    var backdrop = $('[data-sidebar-backdrop]');
    var mobileQuery = window.matchMedia(MOBILE_QUERY);
    var lastFocus = null;
    var drawerOpen = false;

    function getFocusableElements() {
      return $$(FOCUSABLE, sidebar).filter(function (element) {
        var styles = window.getComputedStyle(element);
        return styles.display !== 'none' && styles.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
    }

    function isMobile() {
      return mobileQuery.matches;
    }

    function syncCollapseControls() {
      var collapsed = body.classList.contains('sidebar-collapsed');
      collapseButtons.forEach(function (button) {
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        var label = collapsed ? button.getAttribute('data-label-collapsed') : button.getAttribute('data-label-expanded');
        if (label) {
          button.setAttribute('aria-label', label);
          button.setAttribute('title', label);
        }
      });
    }

    function setDesktopCollapsed(collapsed, persist) {
      body.classList.toggle('sidebar-collapsed', collapsed);
      if (persist) storage.set(COLLAPSED_KEY, collapsed);
      syncCollapseControls();
    }

    function setDrawerAccessibility(open) {
      if (open) {
        sidebar.removeAttribute('inert');
        sidebar.removeAttribute('aria-hidden');
      } else if (isMobile()) {
        sidebar.setAttribute('inert', '');
        sidebar.setAttribute('aria-hidden', 'true');
      } else {
        sidebar.removeAttribute('inert');
        sidebar.removeAttribute('aria-hidden');
      }
    }

    function setMenuState(open) {
      if (!menuButton) return;
      menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      var key = open ? 'data-label-close' : 'data-label-open';
      var label = menuButton.getAttribute(key);
      if (label) {
        menuButton.setAttribute('aria-label', label);
        menuButton.setAttribute('title', label);
      }
    }

    function openDrawer() {
      if (!isMobile() || drawerOpen) return;
      lastFocus = document.activeElement;
      drawerOpen = true;
      body.classList.add('sidebar-open');
      if (backdrop) backdrop.hidden = false;
      setDrawerAccessibility(true);
      setMenuState(true);
      window.requestAnimationFrame(function () {
        var focusable = getFocusableElements();
        if (focusable.length) focusable[0].focus();
      });
      window.setTimeout(function () {
        if (!drawerOpen || sidebar.contains(document.activeElement)) return;
        var focusable = getFocusableElements();
        if (focusable.length) focusable[0].focus();
      }, 260);
    }

    function closeDrawer(options) {
      var opts = options || {};
      if (!drawerOpen) {
        setDrawerAccessibility(false);
        return;
      }
      drawerOpen = false;
      body.classList.remove('sidebar-open');
      if (backdrop) backdrop.hidden = true;
      setDrawerAccessibility(false);
      setMenuState(false);
      if (opts.restoreFocus !== false && lastFocus && typeof lastFocus.focus === 'function') {
        lastFocus.focus();
      }
      lastFocus = null;
    }

    function handleViewportChange() {
      if (isMobile()) {
        body.classList.remove('sidebar-collapsed');
        syncCollapseControls();
        setDrawerAccessibility(false);
        if (menuButton) setMenuState(false);
        if (backdrop) backdrop.hidden = true;
        body.classList.remove('sidebar-open');
        // Keep the persisted collapse preference for when desktop returns.
      } else {
        if (drawerOpen) closeDrawer({ restoreFocus: false });
        setDrawerAccessibility(true);
        setMenuState(false);
        if (backdrop) backdrop.hidden = true;
        body.classList.remove('sidebar-open');
        setDesktopCollapsed(storage.get(COLLAPSED_KEY, false) === true, false);
      }
    }

    if (!isMobile()) {
      setDesktopCollapsed(storage.get(COLLAPSED_KEY, false) === true, false);
    } else {
      body.classList.remove('sidebar-collapsed');
      syncCollapseControls();
    }
    setDrawerAccessibility(false);
    setMenuState(false);

    collapseButtons.forEach(function (button) {
      on(button, 'click', function () {
        if (isMobile()) return;
        setDesktopCollapsed(!body.classList.contains('sidebar-collapsed'), true);
      });
    });

    if (menuButton) {
      on(menuButton, 'click', function () {
        if (drawerOpen) closeDrawer();
        else openDrawer();
      });
    }

    if (backdrop) {
      on(backdrop, 'click', function () {
        closeDrawer();
      });
    }

    closeButtons.forEach(function (button) {
      on(button, 'click', function () {
        closeDrawer();
      });
    });

    on(document, 'keydown', function (event) {
      if (!drawerOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab') return;
      var focusable = getFocusableElements();
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    on(sidebar, 'click', function (event) {
      if (!drawerOpen || !isMobile()) return;
      var link = event.target.closest('a[href]');
      if (link && !link.target) closeDrawer({ restoreFocus: false });
    });

    if (typeof mobileQuery.addEventListener === 'function') {
      mobileQuery.addEventListener('change', handleViewportChange);
    } else if (typeof mobileQuery.addListener === 'function') {
      mobileQuery.addListener(handleViewportChange);
    }
  }

  function initViewTabs() {
    $$('[data-view-tabs]').forEach(function (tablist) {
      var tabs = $$('[data-view-tab]', tablist);
      if (!tabs.length) return;
      var panels = tabs.map(function (tab) {
        var id = tab.getAttribute('aria-controls');
        return id ? document.getElementById(id) : null;
      });

      function selectTab(tab, options) {
        var target = tab.getAttribute('data-view-tab');
        var opts = options || {};
        tabs.forEach(function (item, index) {
          var selected = item === tab;
          item.classList.toggle('is-active', selected);
          item.setAttribute('aria-selected', selected ? 'true' : 'false');
          item.tabIndex = selected ? 0 : -1;
          var panel = panels[index];
          if (panel) panel.hidden = !selected;
        });
        if (opts.focus) tab.focus();
        if (target) tablist.setAttribute('data-active-view', target);
        var article = document.querySelector('[data-article-page]');
        if (article && target) article.setAttribute('data-active-article-view', target);
      }

      tabs.forEach(function (tab) {
        on(tab, 'click', function () {
          selectTab(tab);
        });
        on(tab, 'keydown', function (event) {
          var index = tabs.indexOf(tab);
          var nextIndex = null;
          if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
          else if (event.key === 'Home') nextIndex = 0;
          else if (event.key === 'End') nextIndex = tabs.length - 1;
          if (nextIndex === null) return;
          event.preventDefault();
          selectTab(tabs[nextIndex], { focus: true });
        });
      });
    });
  }

  DSH.ready(function () {
    initSidebar();
    initViewTabs();
  });
})();
