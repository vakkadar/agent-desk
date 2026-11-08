// Attachments on the composer (📎, paste, drop) and prefill from a share link.
type Item = { name: string; source: string; path?: string; failed?: boolean; chip: HTMLElement };

const MAX_FILES = 5;
const MAX_FILE = 20 * 1024 * 1024;

/** Text from `#q=…&source=…` (iOS Shortcut) or `?title=&text=&url=` (share_target). Clears them from the URL. */
export function takePrefill(): { text: string; source?: string } | null {
  const h = new URLSearchParams(location.hash.slice(1));
  const s = new URLSearchParams(location.search);
  let text = h.get("q") ?? "";
  if (!text) text = ["title", "text", "url"].map((k) => s.get(k)).filter(Boolean).join("\n");
  const source = h.get("source") ?? undefined;
  const had = h.has("q") || h.has("source") || ["title", "text", "url"].some((k) => s.has(k));
  if (had) {
    h.delete("q"); h.delete("source");
    ["title", "text", "url"].forEach((k) => s.delete(k));
    const qs = s.toString(), hs = h.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + (hs ? `#${hs}` : ""));
  }
  return text.trim() ? { text, source } : null;
}

/** Wire attach button, paste and drop onto the prompt form. */
export function initAttach(form: HTMLFormElement, ctx: { source: () => string; token: () => string | undefined; error: (m: string) => void }) {
  const items: Item[] = [];
  const bar = document.createElement("div");
  bar.id = "attachBar";
  bar.hidden = true;
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  input.accept = "image/*,application/pdf,text/*,.md,.json,.csv,.log,.zip";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "attachBtn";
  btn.title = "Attach photos or files";
  btn.setAttribute("aria-label", "Attach files");
  btn.textContent = "📎";
  btn.onclick = () => input.click();
  form.append(btn, input, bar);

  async function add(files: File[]) {
    for (const f of files) {
      if (items.length >= MAX_FILES) return ctx.error(`max ${MAX_FILES} files`);
      if (f.size > MAX_FILE) { ctx.error(`${f.name}: over 20 MB`); continue; }
      const chip = document.createElement("span");
      chip.className = "chip";
      const it: Item = { name: f.name || "pasted-image.png", source: ctx.source(), chip };
      items.push(it);
      draw(it, "…");
      try {
        const r = await fetch(`/upload?source=${encodeURIComponent(it.source)}`, {
          method: "POST",
          headers: { "x-desk-token": ctx.token() ?? "", "x-desk-name": encodeURIComponent(it.name), "content-type": f.type || "application/octet-stream" },
          body: f,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `upload failed (${r.status})`);
        it.path = j.path;
        draw(it, "");
      } catch (e: any) {
        it.failed = true;
        ctx.error(`${it.name}: ${e.message}`);
        draw(it, "failed ");
      }
    }
  }
  function draw(it: Item, mark: string) {
    it.chip.textContent = `${mark}${it.name} `;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "Remove";
    x.onclick = () => { items.splice(items.indexOf(it), 1); it.chip.remove(); bar.hidden = !items.length; };
    it.chip.append(x);
    bar.append(it.chip);
    bar.hidden = false;
  }
  input.onchange = () => { add([...(input.files ?? [])]); input.value = ""; };
  form.addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files ?? [])];
    if (fs.length) { e.preventDefault(); add(fs); }
  });
  form.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  form.addEventListener("drop", (e) => {
    const fs = [...(e.dataTransfer?.files ?? [])];
    if (fs.length) { e.preventDefault(); add(fs); }
  });

  return {
    /** Paths to send with the prompt, or null while uploads run (caller keeps the text). Clears the chips. */
    take(): string[] | null {
      if (items.some((i) => !i.path && !i.failed)) { ctx.error("uploading…"); return null; }
      const src = ctx.source();
      const paths = items.filter((i) => i.path && i.source === src).map((i) => i.path!);
      items.length = 0;
      bar.replaceChildren();
      bar.hidden = true;
      return paths;
    },
  };
}

/** Split the "Attached files:" block off a prompt; files get a URL the server serves. */
export function splitAttached(text: string, source: string): { text: string; files: { name: string; url: string; image: boolean }[] } {
  const m = /\n\nAttached files:\n((?:- .+\n?)+)$/.exec(text);
  if (!m) return { text, files: [] };
  const files = m[1].trim().split("\n").map((l) => l.slice(2)).filter((p) => p.includes(".desk-uploads/")).map((p) => {
    const rel = p.slice(p.indexOf(".desk-uploads/") + ".desk-uploads/".length);
    return { name: p.split("/").pop()!, url: `/uploads/${encodeURIComponent(source)}/${rel.split("/").map(encodeURIComponent).join("/")}`, image: /\.(png|jpe?g|gif|webp|svg)$/i.test(p) };
  });
  return { text: text.slice(0, m.index), files };
}

/** Thumbnails/links for a card's attachments. */
export function attachedEl(files: { name: string; url: string; image: boolean }[]): HTMLElement {
  const d = document.createElement("div");
  d.className = "atts";
  for (const f of files) {
    const a = document.createElement("a");
    a.href = f.url;
    a.target = "_blank";
    a.rel = "noopener";
    if (f.image) {
      const img = document.createElement("img");
      img.src = f.url;
      img.alt = f.name;
      img.loading = "lazy";
      a.append(img);
    } else a.textContent = `📄 ${f.name}`;
    d.append(a);
  }
  return d;
}
