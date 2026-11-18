/*!
 * Sofia's Resto-Lounge booking widget.
 * Inline:  <script src="https://sofia.example.com/widget.js" data-branch="MAIN" data-lang="ar" async></script>
 * Button:  add data-mode="button" data-label="Reserve a table" to open the booking page in an overlay.
 */
(function () {
  var s = document.currentScript;
  if (!s) return;
  var base = new URL(s.src).origin;
  var branch = s.getAttribute('data-branch') || '';
  var lang = s.getAttribute('data-lang') || 'ar';
  var mode = s.getAttribute('data-mode') || 'inline';
  var src = base + '/book/' + encodeURIComponent(branch) + '?embed=1&lang=' + encodeURIComponent(lang);
  function frame() {
    var f = document.createElement('iframe');
    f.src = src;
    f.title = 'Reserve a table';
    f.loading = 'lazy';
    f.style.cssText = 'width:100%;border:0;min-height:620px;border-radius:14px;background:transparent';
    window.addEventListener('message', function (e) {
      if (e.origin === base && e.data && e.data.type === 'sofia:height' && e.source === f.contentWindow) f.style.height = e.data.height + 'px';
    });
    return f;
  }
  if (mode === 'button') {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.getAttribute('data-label') || (lang === 'ar' ? 'احجز طاولتك' : 'Reserve a table');
    b.style.cssText = 'background:#6B1420;color:#F3E6D0;border:0;border-radius:999px;padding:12px 26px;font:600 16px system-ui;cursor:pointer';
    b.onclick = function () {
      var o = document.createElement('div');
      o.style.cssText = 'position:fixed;inset:0;background:rgba(30,8,11,.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px';
      var box = document.createElement('div');
      box.style.cssText = 'width:min(640px,100%);max-height:92vh;overflow:auto;border-radius:16px;background:#FBF7F1;position:relative';
      var x = document.createElement('button');
      x.textContent = '×';
      x.setAttribute('aria-label', 'Close');
      x.style.cssText = 'position:absolute;top:6px;right:10px;border:0;background:none;font-size:28px;cursor:pointer;z-index:1';
      x.onclick = function () { o.remove(); };
      o.onclick = function (e) { if (e.target === o) o.remove(); };
      box.appendChild(x);
      box.appendChild(frame());
      o.appendChild(box);
      document.body.appendChild(o);
    };
    s.parentNode.insertBefore(b, s);
  } else {
    s.parentNode.insertBefore(frame(), s);
  }
})();
