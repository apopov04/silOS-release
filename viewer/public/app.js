(function () {
  "use strict";
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); document.documentElement.setAttribute("data-tg", ""); }

  var statusEl = document.getElementById("status");
  var sheet = document.getElementById("sheet");
  function setStatus(text) { statusEl.textContent = text || ""; statusEl.hidden = !text; }

  var OPEN_FROM_CHAT = "Open this from your silOS Telegram chat.";
  var initData = tg ? tg.initData : "";
  if (!initData) { setStatus(OPEN_FROM_CHAT); return; }

  fetch("/api/graph", { headers: { "X-Telegram-Init-Data": initData }, cache: "no-store" })
    .then(function (r) {
      if (r.status === 401) throw new Error("auth");
      if (!r.ok) throw new Error("http");
      return r.json();
    })
    .then(render)
    .catch(function (err) {
      setStatus(err.message === "auth" ? OPEN_FROM_CHAT : "Couldn't load memory. Close and reopen to retry.");
    });

  var PALETTE = ["#5b8def", "#e8785a", "#4fb286", "#c46fd6", "#e3b341", "#46b5c9", "#d9607e", "#8a8f9c"];
  function colorFor(type) {
    var h = 0;
    for (var i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function radius(n) { return 4 * Math.sqrt(n.degree + 1); }

  function render(data) {
    if (!data.nodes.length) { setStatus("Memory is empty."); return; }
    setStatus("");

    var byId = {}, out = {}, inn = {};
    data.nodes.forEach(function (n) { byId[n.id] = n; out[n.id] = []; inn[n.id] = []; });
    data.links.forEach(function (l) { out[l.source].push(l.target); inn[l.target].push(l.source); });

    var css = getComputedStyle(document.documentElement);
    var fg = css.getPropertyValue("--fg").trim() || "#1b1b1f";
    var muted = css.getPropertyValue("--muted").trim() || "#7a7a85";
    var selected = null;

    var graph = ForceGraph()(document.getElementById("graph"))
      .width(window.innerWidth).height(window.innerHeight)
      .backgroundColor("rgba(0,0,0,0)")
      .graphData({ nodes: data.nodes, links: data.links })
      .nodeId("id")
      .nodeLabel(function () { return ""; })          // no HTML tooltips: titles are untrusted
      .nodeVal(function (n) { return n.degree + 1; })
      .nodeCanvasObject(function (n, ctx, scale) {
        var r = radius(n);
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = colorFor(n.type); ctx.globalAlpha = selected && selected !== n ? 0.55 : 1; ctx.fill();
        ctx.globalAlpha = 1;
        if (selected === n) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = fg; ctx.stroke(); }
        if (r >= 9 || scale > 2.2 || selected === n) {
          var size = Math.max(10 / scale, 3);
          ctx.font = size + "px -apple-system, Segoe UI, sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = fg;
          ctx.fillText(n.title, n.x, n.y + r + 2 / scale);
        }
      })
      .nodePointerAreaPaint(function (n, color, ctx) {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x, n.y, radius(n) + 3, 0, 2 * Math.PI); ctx.fill();
      })
      .linkColor(function () { return muted; })
      .linkWidth(0.6)
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .onNodeClick(function (n) { openSheet(n); })
      .onBackgroundClick(closeSheet)
      .onNodeDragEnd(function (n) { n.fx = undefined; n.fy = undefined; }); // let it float back
    var fitted = false;
    graph.onEngineStop(function () {
      if (!fitted) { fitted = true; graph.zoomToFit(400, 40); }
    });
    graph.d3Force("charge").strength(-70);

    window.addEventListener("resize", function () { graph.width(window.innerWidth).height(window.innerHeight); });

    function fill(listEl, labelEl, label, ids) {
      labelEl.textContent = label + " (" + ids.length + ")";
      listEl.textContent = "";
      if (!ids.length) {
        var li = document.createElement("li"); li.className = "empty"; li.textContent = "None"; listEl.appendChild(li); return;
      }
      ids.map(function (id) { return byId[id]; })
        .sort(function (a, b) { return a.title.localeCompare(b.title); })
        .forEach(function (n) {
          var li = document.createElement("li"), b = document.createElement("button");
          b.type = "button"; b.textContent = n.title;
          b.addEventListener("click", function () { flyTo(n); });
          li.appendChild(b); listEl.appendChild(li);
        });
    }

    function openSheet(n) {
      selected = n;
      document.getElementById("sheet-title").textContent = n.title;
      document.getElementById("sheet-type").textContent = n.type;
      fill(document.getElementById("out-list"), document.getElementById("out-label"), "Links to", out[n.id]);
      fill(document.getElementById("in-list"), document.getElementById("in-label"), "Linked from", inn[n.id]);
      sheet.hidden = false; sheet.scrollTop = 0;
      if (tg && tg.BackButton) tg.BackButton.show();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
    }
    function closeSheet() {
      selected = null; sheet.hidden = true;
      if (tg && tg.BackButton) tg.BackButton.hide();
    }
    function flyTo(n) {
      graph.centerAt(n.x, n.y, 600); graph.zoom(3, 600); openSheet(n);
    }
    if (tg && tg.BackButton) tg.BackButton.onClick(closeSheet);
  }
})();
