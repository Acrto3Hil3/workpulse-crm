// Tiny progressive enhancements — the app works fully without JavaScript.
(function () {
  'use strict';

  // Confirm before destructive actions.
  document.querySelectorAll('[data-confirm]').forEach(function (btn) {
    btn.closest('form').addEventListener('submit', function (e) {
      if (!window.confirm(btn.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Filter selects submit on change (no extra tap).
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { el.form.submit(); });
  });

  // Double-submit guard on all forms (slow industrial connections).
  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function () {
      var btn = form.querySelector('button[type="submit"]');
      if (btn) setTimeout(function () { btn.disabled = true; }, 0);
    });
  });

  // Installable app: register the service worker (offline fallback + cached assets).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* non-fatal */ });
  }
})();
