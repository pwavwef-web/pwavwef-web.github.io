# The Pwavwe Papers audio player — embed markup

The hosted player (`/embed/audio/{id}` on `az-studio.web.app`) wears the Papers theme: warm ivory, near-black
text, a fine border and blue playback accents, with a coordinated navy under `theme=dark`. The player itself
updates for every post on each deploy — but the theme it is asked for, the height of its box and the fallback
link beneath it live in the markup pasted into the post, so an existing post keeps its old surround until the
block below replaces it.

What the markup changes, and why the iframe cannot do it for you:

- **The large red “Listen to this paper” link under the player is the post’s, not the player’s.** It is an
  ordinary `<a>` in the post body taking the blog’s link colour, so nothing inside the iframe can restyle it.
  The block below replaces it with a small, muted “Open audio in a new tab”.
- **`?theme=light`.** An iframe does not inherit the blog’s own light/dark button. The embed asks for the
  Papers light theme; `theme=dark` and `theme=auto` (the reader’s system setting) are the alternatives.
- **Two box heights.** The player puts its transport on one row when it is at least 549 px wide and on a second
  row below that, so the `<style>` block gives the iframe a taller box on narrow screens, with the `height`
  attribute as the fallback if a template drops the block. The breakpoints assume this theme’s post column
  (about 28 px narrower than the viewport).

Paste a block in the post’s **HTML view**, replacing the whole old `<div class="pwavwe-audio-embed">…</div>`.
The public id, the listening link and the audio are unchanged, so nothing is re-narrated or republished.
Narrator → an edition → Publish generates the same markup for any edition, with a theme picker.

## Not Every Useful App Needs to Become a Startup

https://blogs.pwavwe.com/2026/10/useful-app-does-not-need-startup.html

```html
<!-- The Pwavwe Papers audio edition (AZ Studio player). Keep it near the top of the post. -->
<div class="pwavwe-audio-embed" style="margin:1.75em 0;max-width:760px;">
<style>.pwavwe-audio-embed{--pwavwe-audio-h:156px}@media (max-width:576px){.pwavwe-audio-embed{--pwavwe-audio-h:224px}}@media (max-width:312px){.pwavwe-audio-embed{--pwavwe-audio-h:264px}}.pwavwe-audio-embed iframe{display:block;width:100%;height:var(--pwavwe-audio-h);border:0;border-radius:12px;overflow:hidden}.pwavwe-audio-embed p{margin:.45em 0 0}.pwavwe-audio-embed a.pwavwe-audio-open{font-size:.78em;color:inherit;opacity:.62;text-decoration:underline;text-underline-offset:.2em}.pwavwe-audio-embed a.pwavwe-audio-open:hover,.pwavwe-audio-embed a.pwavwe-audio-open:focus{opacity:1}</style>
<iframe src="https://az-studio.web.app/embed/audio/kOZQ0h9lETB6?theme=light" title="Listen to Not Every Useful App Needs to Become a Startup — audio edition, The Pwavwe Papers" width="100%" height="156" style="display:block;width:100%;border:0;border-radius:12px;overflow:hidden;" loading="lazy" scrolling="no" referrerpolicy="strict-origin-when-cross-origin">Listen to this paper: https://az-studio.web.app/embed/audio/kOZQ0h9lETB6</iframe>
<p><a class="pwavwe-audio-open" href="https://az-studio.web.app/embed/audio/kOZQ0h9lETB6" target="_blank" rel="noopener">Open audio in a new tab</a></p>
</div>
```

## If They Had the Power

https://blogs.pwavwe.com/2026/10/if-they-had-the-power.html

```html
<!-- The Pwavwe Papers audio edition (AZ Studio player). Keep it near the top of the post. -->
<div class="pwavwe-audio-embed" style="margin:1.75em 0;max-width:760px;">
<style>.pwavwe-audio-embed{--pwavwe-audio-h:156px}@media (max-width:576px){.pwavwe-audio-embed{--pwavwe-audio-h:224px}}@media (max-width:312px){.pwavwe-audio-embed{--pwavwe-audio-h:264px}}.pwavwe-audio-embed iframe{display:block;width:100%;height:var(--pwavwe-audio-h);border:0;border-radius:12px;overflow:hidden}.pwavwe-audio-embed p{margin:.45em 0 0}.pwavwe-audio-embed a.pwavwe-audio-open{font-size:.78em;color:inherit;opacity:.62;text-decoration:underline;text-underline-offset:.2em}.pwavwe-audio-embed a.pwavwe-audio-open:hover,.pwavwe-audio-embed a.pwavwe-audio-open:focus{opacity:1}</style>
<iframe src="https://az-studio.web.app/embed/audio/ajLMkL8uwtfL?theme=light" title="Listen to If They Had the Power — audio edition, The Pwavwe Papers" width="100%" height="156" style="display:block;width:100%;border:0;border-radius:12px;overflow:hidden;" loading="lazy" scrolling="no" referrerpolicy="strict-origin-when-cross-origin">Listen to this paper: https://az-studio.web.app/embed/audio/ajLMkL8uwtfL</iframe>
<p><a class="pwavwe-audio-open" href="https://az-studio.web.app/embed/audio/ajLMkL8uwtfL" target="_blank" rel="noopener">Open audio in a new tab</a></p>
</div>
```

## Optional: keep the player on the blog’s theme

Paste this once in **Theme → Edit HTML**, just before `</body>` — in the theme, not in a post. It is optional:
it makes every embedded player follow the blog’s own light/dark button and sizes each iframe to its player
exactly, so no width is left with a band of empty space. Both sides check the other’s origin before acting on
a message, and the player accepts theme messages only from the publication origins.

```html
<script>
/* The Pwavwe Papers audio player: keep embedded players on the blog's theme, and size them to their content. */
(function () {
  var ORIGIN = "https://az-studio.web.app";
  var frames = function () { return document.querySelectorAll('.pwavwe-audio-embed iframe'); };
  function send() {
    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    frames().forEach(function (f) {
      if (f.contentWindow) f.contentWindow.postMessage({ type: 'pwavwe-player-theme', theme: theme }, ORIGIN);
    });
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.type !== 'pwavwe-player-size') return;
    var h = Number(e.data.height);
    if (!(h > 0) || h > 600) return;
    frames().forEach(function (f) {
      if (f.contentWindow === e.source) f.style.height = Math.round(h) + 'px';
    });
    send();
  });
  new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('load', send);
})();
</script>
```
