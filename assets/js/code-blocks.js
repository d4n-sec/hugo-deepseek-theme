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

  function labels() {
    var lang = (document.documentElement.lang || '').toLowerCase();
    return lang.indexOf('zh') === 0
      ? { copy: '复制代码', copied: '已复制代码', failed: '复制失败，请手动选择代码' }
      : { copy: 'Copy code', copied: 'Code copied', failed: 'Copy failed; select the code manually' };
  }

  function codeText(block) {
    var source = block.querySelector('table tr > td:last-child pre code') ||
      block.querySelector('table tr > td:last-child pre') ||
      block.querySelector('pre code') || block.querySelector('pre');
    if (!source) return '';
    var copy = source.cloneNode(true);
    if (source.closest('.chroma')) {
      copy.querySelectorAll('.lnt, .ln').forEach(function (lineNumber) {
        lineNumber.remove();
      });
    } else if (!block.classList.contains('code-block--plain')) {
      copy.querySelectorAll('[style*="user-select:none"]').forEach(function (lineNumber) {
        lineNumber.remove();
      });
    }
    return copy.textContent || '';
  }

  function copyIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('aria-hidden', 'true');
    var rear = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    rear.setAttribute('d', 'M6 6V4.8C6 3.8 6.8 3 7.8 3h7.4c1 0 1.8.8 1.8 1.8v7.4c0 1-.8 1.8-1.8 1.8H14');
    var front = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    front.setAttribute('x', '3');
    front.setAttribute('y', '6');
    front.setAttribute('width', '11');
    front.setAttribute('height', '11');
    front.setAttribute('rx', '1.8');
    svg.appendChild(rear);
    svg.appendChild(front);
    return svg;
  }

  function addCopyButton(block, strings) {
    if (block.querySelector(':scope > .code-copy')) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.setAttribute('aria-label', strings.copy);
    button.setAttribute('title', strings.copy);
    button.appendChild(copyIcon());
    var resetTimer = null;
    button.addEventListener('click', function () {
      if (typeof DSH.copyText !== 'function') return;
      DSH.copyText(codeText(block)).then(function () {
        button.setAttribute('aria-label', strings.copied);
        button.setAttribute('title', strings.copied);
        if (typeof DSH.toast === 'function') DSH.toast(strings.copied, { tone: 'success' });
        if (resetTimer !== null) window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(function () {
          button.setAttribute('aria-label', strings.copy);
          button.setAttribute('title', strings.copy);
          resetTimer = null;
        }, 2000);
      }).catch(function () {
        if (typeof DSH.toast === 'function') DSH.toast(strings.failed, { tone: 'error' });
      });
    });
    block.appendChild(button);
  }

  ready(function () {
    var body = document.querySelector('[data-article-body]');
    if (!body) return;
    var strings = labels();
    Array.prototype.forEach.call(body.querySelectorAll('pre'), function (pre) {
      var block = pre.closest('.highlight');
      if (!block) {
        block = document.createElement('div');
        block.className = 'highlight code-block--plain';
        pre.parentNode.insertBefore(block, pre);
        block.appendChild(pre);
      }
      addCopyButton(block, strings);
    });
  });
})();
