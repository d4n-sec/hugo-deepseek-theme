;(function () {
  'use strict';

  var GROUP_STATES_KEY = 'threadline.articleIndex.groupStates';

  function normalise(value) {
    var text = String(value == null ? '' : value);
    if (typeof text.normalize === 'function') text = text.normalize('NFKC');
    return text.toLocaleLowerCase();
  }

  function textOf(value) {
    return String(value == null ? '' : value);
  }

  function initArticleIndex(root) {
    if (!root || root.getAttribute('data-index-ready') === 'true') return;
    root.setAttribute('data-index-ready', 'true');
    var DSH = window.DSH;
    var viewButtons = DSH.$$('[data-article-view]', root);
    var viewPanels = DSH.$$('[data-article-panel]', root);
    var groups = DSH.$$('[data-article-group]', root);
    var searchBox = DSH.$('[data-index-search]', root);
    var searchToggle = DSH.$('[data-index-search-toggle]', root);
    var queryInput = DSH.$('[data-index-query]', root);
    var clearButton = DSH.$('[data-index-clear]', root);
    var closeButton = DSH.$('[data-index-close]', root);
    var pinButton = DSH.$('[data-index-pin]', root);
    var pinnedStatus = DSH.$('[data-index-pinned]', root);
    var pinnedLabel = DSH.$('[data-index-pinned-query]', root);
    var pinnedEmpty = DSH.$('[data-index-pinned-empty]', root);
    var unpinButton = DSH.$('[data-index-unpin]', root);
    var searchBody = DSH.$('[data-index-search-body]', root);
    var resultsList = DSH.$('[data-index-results]', root);
    var resultCount = DSH.$('[data-index-result-count]', root);
    var empty = DSH.$('[data-index-search-empty]', root);
    var dataNode = DSH.$('[data-article-search-data]', root);
    var countTemplate = searchBox ? searchBox.getAttribute('data-result-count-template') || '' : '';
    var openResultLabel = searchBox ? searchBox.getAttribute('data-open-result-label') || '' : '';
    var stored = DSH.storage.get(GROUP_STATES_KEY, {});
    var groupStates = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    var searchRecords = [];
    var searchData = {};
    var isOpen = false;
    var isComposing = false;
    var pinKey = 'threadline.articleIndex.pinnedSearch:';
    var pinnedQuery = '';

    try {
      pinKey += new URL((DSH.config && DSH.config.baseURL) || '/', window.location.href).pathname;
      pinnedQuery = (window.sessionStorage.getItem(pinKey) || '').trim();
    } catch (error) {
      pinnedQuery = '';
    }

    try {
      var records = dataNode ? JSON.parse(dataNode.textContent || '[]') : [];
      if (Array.isArray(records)) records.forEach(function (record) {
        if (!record || !record.key) return;
        var key = textOf(record.key);
        var title = textOf(record.title);
        var tags = Array.isArray(record.tags) ? record.tags.map(textOf) : [];
        var text = textOf(record.text);
        var haystack = normalise([title, tags.join(' '), text].join(' '));
        var entry = {
          key: key,
          title: title,
          tags: tags,
          text: text,
          dateLabel: textOf(record.dateLabel || record.date),
          haystack: haystack
        };
        searchRecords.push(entry);
        searchData[key] = entry;
      });
    } catch (error) {
      searchRecords = [];
      searchData = {};
    }

    // Keep the dialog outside the rail and its mobile drawer transform.
    if (searchBox && searchBox.parentNode !== document.body) {
      document.body.appendChild(searchBox);
    }

    function groupBody(group) {
      var toggle = DSH.$('[data-group-toggle]', group);
      return toggle ? document.getElementById(toggle.getAttribute('aria-controls')) : null;
    }

    function shouldCollapse(group) {
      var key = group.getAttribute('data-group-key') || '';
      if (Object.prototype.hasOwnProperty.call(groupStates, key) && typeof groupStates[key] === 'boolean') {
        return groupStates[key];
      }
      return group.getAttribute('data-default-collapsed') === 'true';
    }

    function setCollapsed(group, value, persist) {
      var toggle = DSH.$('[data-group-toggle]', group);
      var body = groupBody(group);
      var key = group.getAttribute('data-group-key') || '';
      if (!toggle || !body || !key) return;
      group.classList.toggle('is-collapsed', value);
      toggle.setAttribute('aria-expanded', value ? 'false' : 'true');
      body.hidden = value;
      if (persist) {
        groupStates[key] = value;
        DSH.storage.set(GROUP_STATES_KEY, groupStates);
      }
    }

    groups.forEach(function (group) {
      setCollapsed(group, shouldCollapse(group), false);
      var toggle = DSH.$('[data-group-toggle]', group);
      DSH.on(toggle, 'click', function () {
        setCollapsed(group, !group.classList.contains('is-collapsed'), !pinnedQuery);
      });
    });

    function termsFor(value) {
      var query = normalise(textOf(value).trim());
      return query ? query.split(/\s+/) : [];
    }

    function currentTerms() {
      return termsFor(queryInput ? queryInput.value : '');
    }

    function matchesTerms(haystack, terms) {
      return terms.every(function (term) { return haystack.indexOf(term) !== -1; });
    }

    function matchingRecords(terms) {
      if (!terms.length) return [];
      return searchRecords.filter(function (record) { return matchesTerms(record.haystack, terms); });
    }

    function updatePinState() {
      if (!pinButton) return;
      var query = queryInput ? queryInput.value.trim() : '';
      var active = !isComposing && !!query && query === pinnedQuery;
      pinButton.disabled = !currentTerms().length || isComposing;
      pinButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      var label = pinButton.getAttribute(active ? 'data-unpin-label' : 'data-pin-label');
      if (label) {
        pinButton.setAttribute('aria-label', label);
      }
    }

    function buildResult(record) {
      var item = document.createElement('li');
      item.className = 'article-search__result';
      var link = document.createElement('a');
      link.className = 'article-search__result-link';
      link.href = record.key;
      if (record.title) link.title = record.title;

      var title = document.createElement('span');
      title.className = 'article-search__result-title';
      title.textContent = record.title || record.key;
      link.appendChild(title);

      if (openResultLabel) {
        var openLabel = document.createElement('span');
        openLabel.className = 'sr-only';
        openLabel.textContent = ' ' + openResultLabel;
        link.appendChild(openLabel);
      }

      var meta = document.createElement('span');
      meta.className = 'article-search__result-meta';
      meta.setAttribute('aria-hidden', 'true');
      if (record.dateLabel) {
        var date = document.createElement('span');
        date.className = 'article-search__result-date';
        date.textContent = record.dateLabel;
        meta.appendChild(date);
      }
      if (record.tags.length) {
        var tags = document.createElement('span');
        tags.className = 'article-search__result-tags';
        tags.textContent = record.tags.join(' · ');
        meta.appendChild(tags);
      }
      if (meta.childNodes.length) link.appendChild(meta);

      item.appendChild(link);
      return item;
    }

    function renderResults(terms) {
      if (!searchBox || !isOpen) return;
      var hasQuery = terms.length > 0;
      var matches = matchingRecords(terms);
      if (searchBody) searchBody.hidden = !hasQuery;
      if (resultsList) {
        resultsList.textContent = '';
        matches.forEach(function (record) {
          resultsList.appendChild(buildResult(record));
        });
        resultsList.hidden = matches.length === 0;
      }
      if (resultCount) {
        resultCount.textContent = hasQuery ? countTemplate.replace(/\{count\}/g, String(matches.length)) : '';
      }
      if (empty) empty.hidden = terms.length === 0 || matches.length > 0;
      if (clearButton) clearButton.hidden = terms.length === 0;
      updatePinState();
    }

    function applyPinnedSearch() {
      var terms = termsFor(pinnedQuery);
      groups.forEach(function (group) {
        var count = 0;
        DSH.$$('[data-article-row]', group).forEach(function (row) {
          var key = row.getAttribute('data-article-key') || '';
          var record = searchData[key];
          var haystack = record ? record.haystack : normalise(row.textContent);
          var matches = matchesTerms(haystack, terms);
          row.hidden = !matches;
          if (matches) count += 1;
        });
        group.hidden = terms.length > 0 && count === 0;
        if (terms.length && count) setCollapsed(group, false, false);
        if (!terms.length) setCollapsed(group, shouldCollapse(group), false);
      });
      if (pinnedStatus) pinnedStatus.hidden = terms.length === 0;
      if (pinnedLabel) {
        pinnedLabel.textContent = pinnedQuery;
        pinnedLabel.title = pinnedQuery;
      }
      if (pinnedEmpty) pinnedEmpty.hidden = terms.length === 0 || matchingRecords(terms).length > 0;
    }

    function setPinnedQuery(value) {
      pinnedQuery = textOf(value).trim();
      try {
        if (pinnedQuery) window.sessionStorage.setItem(pinKey, pinnedQuery);
        else window.sessionStorage.removeItem(pinKey);
      } catch (error) {
        // The current page can still use the filter when storage is unavailable.
      }
      applyPinnedSearch();
      updatePinState();
    }

    function selectView(button, options) {
      var target = button.getAttribute('data-article-view');
      viewButtons.forEach(function (item) {
        var selected = item === button;
        item.classList.toggle('is-active', selected);
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        item.tabIndex = selected ? 0 : -1;
      });
      viewPanels.forEach(function (panel) { panel.hidden = panel.getAttribute('data-article-panel') !== target; });
      if (options && options.focus) button.focus();
    }

    viewButtons.forEach(function (button) {
      DSH.on(button, 'click', function () { selectView(button); });
      DSH.on(button, 'keydown', function (event) {
        var index = viewButtons.indexOf(button);
        var next = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % viewButtons.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + viewButtons.length) % viewButtons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = viewButtons.length - 1;
        if (next === null) return;
        event.preventDefault();
        selectView(viewButtons[next], { focus: true });
      });
    });

    function openSearch() {
      if (!searchBox || isOpen || typeof searchBox.showModal !== 'function') return;
      searchBox.hidden = false;
      try {
        searchBox.showModal();
      } catch (error) {
        searchBox.hidden = true;
        return;
      }
      isOpen = true;
      document.body.classList.add('has-search-dialog');
      if (searchToggle) searchToggle.setAttribute('aria-expanded', 'true');
      renderResults(currentTerms());
      window.requestAnimationFrame(function () {
        if (isOpen && queryInput) queryInput.focus();
      });
    }

    function closeSearch() {
      if (!searchBox || !isOpen) return;
      isOpen = false;
      if (queryInput) queryInput.value = '';
      isComposing = false;
      if (searchBox.open) searchBox.close();
      searchBox.hidden = true;
      document.body.classList.remove('has-search-dialog');
      if (searchBody) searchBody.hidden = true;
      if (resultsList) {
        resultsList.textContent = '';
        resultsList.hidden = true;
      }
      if (resultCount) resultCount.textContent = '';
      if (empty) empty.hidden = true;
      if (clearButton) clearButton.hidden = true;
      if (searchToggle) {
        searchToggle.setAttribute('aria-expanded', 'false');
        searchToggle.focus({ preventScroll: true });
      }
    }

    DSH.on(searchToggle, 'click', function () {
      if (!searchBox) return;
      if (isOpen) closeSearch();
      else openSearch();
    });
    DSH.on(closeButton, 'click', function () { closeSearch(); });
    DSH.on(queryInput, 'input', function (event) {
      if (!event.isComposing && !isComposing) renderResults(currentTerms());
    });
    DSH.on(queryInput, 'compositionstart', function () {
      isComposing = true;
      updatePinState();
    });
    DSH.on(queryInput, 'compositionend', function () {
      isComposing = false;
      renderResults(currentTerms());
    });
    DSH.on(clearButton, 'click', function () {
      if (queryInput) { queryInput.value = ''; queryInput.focus(); }
      renderResults(currentTerms());
    });
    DSH.on(pinButton, 'click', function () {
      if (isComposing || !currentTerms().length) return;
      var query = queryInput ? queryInput.value.trim() : '';
      setPinnedQuery(query === pinnedQuery ? '' : query);
    });
    DSH.on(unpinButton, 'click', function () {
      setPinnedQuery('');
      if (searchToggle) searchToggle.focus({ preventScroll: true });
    });
    DSH.on(searchBox, 'click', function (event) {
      if (!isOpen || event.target !== searchBox) return;
      var rect = searchBox.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSearch();
    });
    DSH.on(searchBox, 'cancel', function (event) {
      event.preventDefault();
      closeSearch();
    });
    DSH.on(document, 'keydown', function (event) {
      if (!isOpen || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Tab') {
        var focusable = DSH.$$('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])', searchBox)
          .filter(function (element) { return element.getClientRects().length > 0; });
        if (!focusable.length) return;
        var index = focusable.indexOf(document.activeElement);
        if (event.shiftKey && index <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        } else if (!event.shiftKey && (index === -1 || index === focusable.length - 1)) {
          event.preventDefault();
          focusable[0].focus();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    }, true);
    if (window.Intl && typeof Intl.RelativeTimeFormat === 'function') {
      var locale = (DSH.config && DSH.config.languageCode) || document.documentElement.lang || undefined;
      var formatter;
      try { formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }); } catch (error) { formatter = null; }
      if (formatter) DSH.$$('[data-article-row] time[datetime]', root).forEach(function (node) {
        var time = Date.parse(node.getAttribute('datetime'));
        if (!isFinite(time)) return;
        var seconds = (time - Date.now()) / 1000;
        var magnitude = Math.abs(seconds);
        var unit = magnitude >= 31536000 ? ['year', 31536000] : magnitude >= 2592000 ? ['month', 2592000] : magnitude >= 604800 ? ['week', 604800] : magnitude >= 86400 ? ['day', 86400] : magnitude >= 3600 ? ['hour', 3600] : ['minute', 60];
        var amount = seconds < 0 ? Math.ceil(seconds / unit[1]) : Math.floor(seconds / unit[1]);
        node.textContent = formatter.format(amount, unit[0]);
      });
    }
    applyPinnedSearch();
  }

  window.DSH.ready(function () {
    window.DSH.$$('[data-article-index]').forEach(initArticleIndex);
  });
})();
