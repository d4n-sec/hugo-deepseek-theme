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

  var SECTION_COLORS = [
    { color: 'rgba(54, 167, 98, 0.78)', mark: '#36a762' },
    { color: 'rgba(136, 107, 174, 0.78)', mark: '#886bae' },
    { color: 'rgba(65, 118, 230, 0.78)', mark: '#4176e6' }
  ];

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

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function characterLength(value) {
    return Array.from(String(value == null ? '' : value)).length;
  }

  function shorter(value, limit) {
    var characters = Array.from(String(value == null ? '' : value));
    if (characters.length <= limit) return characters.join('');
    return characters.slice(0, limit).join('') + '…';
  }

  function cloneText(node) {
    if (!node) return '';
    var clone = node.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('.anchor'), function (anchor) {
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    });
    return cleanText(clone.textContent);
  }

  function rangeText(range) {
    var fragment = range.cloneContents();
    Array.prototype.forEach.call(fragment.querySelectorAll('.anchor'), function (anchor) {
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    });
    return cleanText(fragment.textContent);
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function initTrajectory() {
    var panel = document.getElementById('trajectory-panel');
    var root = panel ? panel.querySelector('[data-trajectory-root]') : null;
    if (!panel || !root) return;

    var pending = root.querySelector('[data-trajectory-pending]');
    var empty = root.querySelector('[data-trajectory-empty]');
    var content = root.querySelector('[data-trajectory-content]');
    var article = document.querySelector('[data-article-page]');
    var body = article ? article.querySelector('[data-article-body]') : null;
    var titleNode = article ? article.querySelector('.article-title') : null;
    var titleTarget = article ? article.querySelector('[data-article-title-target]') : null;
    var descriptionNode = article ? article.querySelector('.article-title__description') : null;
    var strings = readStrings();
    var built = false;

    function isReducedMotion() {
      if (typeof DSH.prefersReducedMotion === 'function') return DSH.prefersReducedMotion();
      return false;
    }

    function colorFor(segment, sectionIndex) {
      if (segment.kind === 'title') {
        return { color: 'rgba(97, 102, 107, 0.82)', mark: '#61666b' };
      }
      if (segment.kind === 'preamble') {
        return { color: 'rgba(65, 118, 230, 0.8)', mark: '#4176e6' };
      }
      if (segment.kind === 'body') {
        return SECTION_COLORS[0];
      }
      return SECTION_COLORS[sectionIndex % SECTION_COLORS.length];
    }

    function collectSegments() {
      if (!article || !body) return null;
      var hasBody = body.children.length > 0 || cleanText(body.textContent).length > 0;
      if (!hasBody) return null;

      var segments = [];
      var titleText = cleanText(titleNode ? titleNode.textContent : article.getAttribute('data-article-title'));
      var titleExcerpt = descriptionNode ? cleanText(descriptionNode.textContent) : '';
      segments.push({
        kind: 'title',
        title: titleText || strings.trajectoryTitle,
        excerpt: titleExcerpt || strings.trajectoryTitleExcerpt,
        target: titleTarget || titleNode || body,
        weight: characterLength(titleText),
        characters: characterLength(titleText)
      });

      var headings = Array.prototype.slice.call(body.querySelectorAll('h1'));
      var sectionIndex = 0;

      if (!headings.length) {
        var bodyText = cloneText(body);
        segments.push({
          kind: 'body',
          title: strings.trajectoryArticle,
          excerpt: bodyText || strings.trajectoryEmptyExcerpt,
          target: body,
          weight: characterLength(bodyText),
          characters: characterLength(bodyText)
        });
        return segments;
      }

      var firstRange = document.createRange();
      firstRange.setStart(body, 0);
      firstRange.setEndBefore(headings[0]);
      var preambleText = rangeText(firstRange);
      if (characterLength(preambleText) > 0) {
        segments.push({
          kind: 'preamble',
          title: strings.trajectoryPreamble,
          excerpt: preambleText,
          target: body,
          weight: characterLength(preambleText),
          characters: characterLength(preambleText)
        });
      }

      headings.forEach(function (heading, index) {
        var headingText = cloneText(heading);
        var sectionRange = document.createRange();
        sectionRange.setStartAfter(heading);
        if (headings[index + 1]) {
          sectionRange.setEndBefore(headings[index + 1]);
        } else {
          sectionRange.setEnd(body, body.childNodes.length);
        }
        var sectionText = rangeText(sectionRange);
        var weight = characterLength(headingText) + characterLength(sectionText);
        segments.push({
          kind: 'section',
          title: headingText || strings.trajectoryUntitled,
          excerpt: sectionText || strings.trajectoryEmptyExcerpt,
          target: heading,
          weight: weight,
          characters: weight,
          sectionIndex: sectionIndex
        });
        sectionIndex += 1;
      });

      return segments;
    }

    function segmentLabel(segment, index) {
      return [
        strings.trajectoryOrder + ' ' + (index + 1),
        shorter(segment.title, 120),
        segment.characters + ' ' + strings.trajectoryCharacters,
        strings.trajectoryJump
      ].join(' · ');
    }

    function activate(segment) {
      if (DSH.reader && typeof DSH.reader.finish === 'function') {
        DSH.reader.finish({ announce: false });
      }
      var chatTab = document.querySelector('[data-view-tab="chat"]');
      if (chatTab && !panel.hidden) chatTab.click();
      window.requestAnimationFrame(function () {
        focusTarget(segment.target);
      });
    }

    function focusTarget(target) {
      if (!target || !target.isConnected) return;
      Array.prototype.forEach.call(document.querySelectorAll('.is-trajectory-target'), function (node) {
        node.classList.remove('is-trajectory-target');
      });
      var hadTabindex = target.hasAttribute('tabindex');
      if (!hadTabindex) target.setAttribute('tabindex', '-1');
      target.classList.add('is-trajectory-target');
      if (typeof target.focus === 'function') {
        try {
          target.focus({ preventScroll: true });
        } catch (error) {
          target.focus();
        }
      }
      try {
        target.scrollIntoView({
          behavior: isReducedMotion() ? 'auto' : 'smooth',
          block: 'start'
        });
      } catch (error) {
        target.scrollIntoView();
      }
      window.setTimeout(function () {
        target.classList.remove('is-trajectory-target');
        if (!hadTabindex) {
          target.addEventListener('blur', function removeTabindex() {
            target.removeAttribute('tabindex');
            target.removeEventListener('blur', removeTabindex);
          });
        }
      }, 1800);
    }

    function build() {
      if (built) return;
      var segments = collectSegments();
      if (pending) pending.hidden = true;
      if (!segments) {
        if (empty) empty.hidden = false;
        if (content) {
          content.hidden = true;
          content.textContent = '';
        }
        built = true;
        return;
      }

      if (content) {
        content.textContent = '';
        content.hidden = false;
      }
      if (empty) empty.hidden = true;

      var head = element('div', 'trajectory__head');
      var heading = element('h2', 'trajectory__title', strings.trajectoryStructure);
      var hint = element('p', 'trajectory__hint', strings.trajectoryHint);
      var overview = element('div', 'trajectory-overview');
      overview.setAttribute('role', 'group');
      overview.setAttribute('aria-label', strings.trajectoryOverview);

      var totalCharacters = 0;
      segments.forEach(function (segment) { totalCharacters += segment.characters; });
      var summary = element(
        'span',
        'trajectory__summary',
        segments.length + ' ' + strings.trajectorySegments + ' · ' + totalCharacters + ' ' + strings.trajectoryCharacters
      );
      head.appendChild(heading);
      head.appendChild(hint);
      head.appendChild(summary);

      var list = element('ol', 'trajectory-list');

      segments.forEach(function (segment, index) {
        var palette = colorFor(segment, typeof segment.sectionIndex === 'number' ? segment.sectionIndex : 0);
        var label = segmentLabel(segment, index);

        var segmentButton = element('button', 'trajectory-segment');
        segmentButton.type = 'button';
        segmentButton.style.flexGrow = String(Math.max(1, segment.weight));
        segmentButton.style.setProperty('--trajectory-color', palette.color);
        segmentButton.setAttribute('data-trajectory-index', String(index));
        segmentButton.setAttribute('data-trajectory-weight', String(segment.weight));
        segmentButton.setAttribute('data-trajectory-chars', String(segment.characters));
        segmentButton.setAttribute('data-trajectory-kind', segment.kind);
        segmentButton.setAttribute('aria-label', label);
        segmentButton.setAttribute('title', label);
        segmentButton.addEventListener('click', function () {
          activate(segment);
        });
        overview.appendChild(segmentButton);

        var item = element('li', 'trajectory-list__item');
        var row = element('button', 'trajectory-item');
        row.type = 'button';
        row.setAttribute('aria-label', label);
        row.setAttribute('data-trajectory-index', String(index));
        row.setAttribute('data-trajectory-kind', segment.kind);
        row.addEventListener('click', function () {
          activate(segment);
        });

        var mark = element('span', 'trajectory-item__mark');
        mark.style.setProperty('--trajectory-color', palette.mark);
        mark.setAttribute('aria-hidden', 'true');

        var copy = element('span', 'trajectory-item__copy');
        var rowHead = element('span', 'trajectory-item__head');
        var rowTitle = element('span', 'trajectory-item__title', segment.title);
        var rowIndex = element('span', 'trajectory-item__index', ('0' + (index + 1)).slice(-2));
        rowHead.appendChild(rowTitle);
        rowHead.appendChild(rowIndex);

        var excerpt = element('span', 'trajectory-item__excerpt', shorter(segment.excerpt, 140));
        var meta = element(
          'span',
          'trajectory-item__meta',
          segment.characters + ' ' + strings.trajectoryCharacters
        );
        copy.appendChild(rowHead);
        copy.appendChild(excerpt);
        copy.appendChild(meta);
        row.appendChild(mark);
        row.appendChild(copy);
        item.appendChild(row);
        list.appendChild(item);
      });

      content.appendChild(head);
      content.appendChild(overview);
      content.appendChild(list);
      built = true;
    }

    function prepare() {
      if (built) return;
      if (DSH.reader && typeof DSH.reader.finish === 'function') {
        DSH.reader.finish({ announce: false });
      }
      try {
        build();
      } catch (error) {
        if (pending) pending.hidden = true;
        if (content) content.hidden = true;
        if (empty) empty.hidden = false;
        built = true;
      }
    }

    var trajectoryTab = document.querySelector('[data-view-tab="trajectory"]');
    if (trajectoryTab) {
      trajectoryTab.addEventListener('click', prepare);
      trajectoryTab.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') prepare();
      });
    }

    if (typeof window.MutationObserver === 'function') {
      var observer = new MutationObserver(function () {
        if (!panel.hidden) prepare();
      });
      observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    }

    if (!panel.hidden) prepare();
  }

  ready(initTrajectory);
})();
