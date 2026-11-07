// Usage tab (FR-9): per source/thread token + cost table with today / 7d / all filter.
type Row = { sourceId: string; threadId: string; tokensIn: number; tokensOut: number; costUsd: number; turns: number };
type Msg = { range: string; rows: Row[]; total: Omit<Row, "sourceId" | "threadId"> };

const fmt = (n: number) => n.toLocaleString();
let range = "today";
let root: HTMLElement;
let request: (range: string) => void;
let last: Msg | null = null;

export function initUsage(el: HTMLElement, req: (range: string) => void) {
  root = el;
  request = req;
}

export function showUsage() {
  render();
  request(range);
}

export function onUsage(m: Msg) {
  last = m;
  if (m.range === range) render();
}

function render() {
  root.replaceChildren();
  const bar = document.createElement("div");
  bar.className = "seg";
  for (const [id, label] of [["today", "Today"], ["7d", "7 days"], ["all", "All time"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className = id === range ? "on" : "";
    b.onclick = () => { range = id; showUsage(); };
    bar.append(b);
  }
  root.append(bar);
  if (!last || last.range !== range) return;
  const t = document.createElement("table");
  t.className = "grid";
  t.innerHTML = "<thead><tr><th>Source</th><th>Thread</th><th>Turns</th><th class=n>Tokens in</th><th class=n>Tokens out</th><th class=n>Cost</th></tr></thead>";
  const body = document.createElement("tbody");
  const addRow = (cells: (string | number)[], cls = "") => {
    const tr = document.createElement("tr");
    tr.className = cls;
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = String(c);
      if (i >= 3) td.className = "n";
      tr.append(td);
    });
    body.append(tr);
  };
  for (const r of last.rows) addRow([r.sourceId, r.threadId, r.turns, fmt(r.tokensIn), fmt(r.tokensOut), `$${r.costUsd.toFixed(4)}`]);
  if (!last.rows.length) addRow(["No usage in this period", "", "", "", "", ""], "mute");
  addRow(["Total", "", last.total.turns, fmt(last.total.tokensIn), fmt(last.total.tokensOut), `$${last.total.costUsd.toFixed(4)}`], "total");
  t.append(body);
  const wrap = document.createElement("div");
  wrap.className = "tablewrap";
  wrap.append(t);
  root.append(wrap);
}
