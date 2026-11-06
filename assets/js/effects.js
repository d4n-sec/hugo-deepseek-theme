;(function () {
  'use strict';

  var DSH = (window.DSH = window.DSH || {});
  var EFFECTS = ['off', 'subtle', 'strong'];
  var PARTICLE_COUNT = 4;

  function normalize(value) {
    var effect = String(value == null ? '' : value).toLowerCase();
    return EFFECTS.indexOf(effect) === -1 ? 'off' : effect;
  }

  function ensureParticles(layer) {
    var existing = layer.querySelectorAll('.comment-effect__particle');
    for (var i = existing.length; i < PARTICLE_COUNT; i += 1) {
      var particle = document.createElement('span');
      particle.className = 'comment-effect__particle';
      particle.setAttribute('aria-hidden', 'true');
      layer.appendChild(particle);
    }
  }

  function decorateCard(card, value) {
    if (!card || !card.getAttribute) return;
    var effect = normalize(value == null ? card.getAttribute('data-effect') : value);
    card.classList.remove('comment-card--effect-off', 'comment-card--effect-subtle', 'comment-card--effect-strong');
    card.classList.add('comment-card--effect-' + effect);
    card.setAttribute('data-effect', effect);
    var layer = card.querySelector('.comment-card__effect');
    if (effect === 'off') {
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      return;
    }
    if (!layer) {
      layer = document.createElement('span');
      layer.className = 'comment-card__effect';
      layer.setAttribute('aria-hidden', 'true');
      card.insertBefore(layer, card.firstChild);
    }
    ensureParticles(layer);
  }

  function apply(scope, value) {
    var root = scope || document;
    if (!root || !root.querySelectorAll) return;
    var cards = root.matches && root.matches('[data-comment-card]') ? [root] : [];
    cards = cards.concat(Array.prototype.slice.call(root.querySelectorAll('[data-comment-card]')));
    cards.forEach(function (card) {
      decorateCard(card, value == null ? card.getAttribute('data-effect') : value);
    });
  }

  DSH.effects = {
    normalize: normalize,
    apply: apply,
    applyCard: decorateCard
  };

  if (typeof DSH.ready === 'function') {
    DSH.ready(function () {
      apply(document);
    });
  }
})();
