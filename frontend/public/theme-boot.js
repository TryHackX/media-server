/*
 * The theme of the last visit, before the first paint.
 *
 * Every page loads this file with a plain blocking <script> in its <head>, ahead
 * of the stylesheet (the tag is written by the build: vite.config.ts). The
 * pages allow no inline script (CSP: script-src 'self'), and the application's
 * own modules run after the first frame — without this a page chosen to be blue
 * flashed green on every load.
 *
 * It does two things: puts `data-theme` on <html>, which is what the stylesheet
 * switches on, and gives <meta name="theme-color"> that theme's canvas colour.
 * The account's own choice arrives later, with the session, and replaces this
 * one if it differs (shared/theme.ts, which this file must agree with:
 * shared/theme.test.ts runs it and compares).
 *
 * Classic script, no modules, nothing newer than ES5: it must run everywhere
 * the page opens at all, and it must never throw.
 */
(function () {
  var colors = { emerald: "#0b0f14", blue: "#060a14" };
  var theme = "emerald";
  try {
    var stored = window.localStorage.getItem("media-theme");
    if (stored && Object.prototype.hasOwnProperty.call(colors, stored)) theme = stored;
  } catch (error) { /* storage switched off: the default theme */ }
  try {
    document.documentElement.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", colors[theme]);
  } catch (error) { /* never in the way of the page */ }
})();
