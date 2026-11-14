// Release Seal widget for download pages:
//   <script src="https://emilhuseyn.github.io/release-seal/widget.js" data-project="<project id>" async></script>
// Puts a small frame right after the script tag. The frame (the app in embed mode) reads the seal from Bitcoin Cash and checks a
// dropped file in the visitor's browser; nothing is uploaded. The frame reports only its height, and only its own reports count.
(function () {
  var base = new URL(".", (document.currentScript && document.currentScript.src) || location.href);
  var frames = [];
  window.addEventListener("message", function (e) {
    if (e.origin !== base.origin || !e.data || e.data.releaseSeal !== "height") return;
    var h = Number(e.data.height);
    if (!(h > 0 && h < 2000)) return;
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === e.source) frames[i].style.height = h + "px";
  });
  var tags = document.querySelectorAll("script[data-project]");
  for (var i = 0; i < tags.length; i++) {
    var s = tags[i];
    if (s.getAttribute("data-release-seal-done")) continue;
    var id = String(s.getAttribute("data-project") || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id) || new URL(s.src, location.href).href.indexOf(base.href) !== 0) continue;
    s.setAttribute("data-release-seal-done", "1");
    var f = document.createElement("iframe");
    f.src = base.href + "?project=" + id + "&embed=1";
    f.title = "Release Seal: check this download";
    f.style.cssText = "display:block;width:100%;max-width:420px;height:150px;border:0;color-scheme:normal";
    s.parentNode.insertBefore(f, s.nextSibling);
    frames.push(f);
  }
})();
